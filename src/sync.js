import path from 'node:path';
import { config, FILES_DIR, publicConfig } from './config.js';
import { downloadAsset, setProgressHook, verifyExisting } from './downloader.js';
import { listReleases, selectReleases, sortReleases, normalizeRelease } from './github.js';
import { log } from './logger.js';
import * as store from './store.js';
import { humanBytes, nowIso, runPool } from './util.js';

const state = {
  running: false,
  reason: null,
  startedAt: null,
  finishedAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  current: null,
  lastResult: null,
  nextRunAt: null,
  runs: 0,
  downloadsCompleted: 0,
  bytesDownloaded: 0,
  prunedFiles: 0,
};

let inFlight = null;
let rerunRequested = false;
let timer = null;
let stopped = false;

setProgressHook((event) => {
  if (event.phase === 'done') {
    state.current = null;
    return;
  }
  state.current = { ...event, at: nowIso() };
});

export function getSyncState() {
  return {
    ...state,
    current: state.current ? { ...state.current } : null,
    config: publicConfig(),
  };
}

function resetProgress() {
  state.current = null;
}

function buildManifest(selected, results, previousManifest) {
  const byKey = new Map(results.map((r) => [`${r.tag}\u0000${r.asset.name}`, r]));
  const previousByFile = new Map();
  for (const rel of previousManifest.releases || []) {
    for (const a of rel.assets || []) {
      if (a.fileName) previousByFile.set(a.fileName, a);
    }
  }

  return {
    schema: 1,
    repo: config.repo,
    app: 'blfp-release-mirror',
    lastSyncAt: nowIso(),
    releases: selected.map((release) => ({
      tag: release.tag,
      name: release.name,
      prerelease: release.prerelease,
      publishedAt: release.publishedAt,
      htmlUrl: release.htmlUrl,
      htmlUrlTemplate: `https://github.com/${config.repo}/releases/tag/${encodeURIComponent(release.tag)}`,
      assets: release.assets.map((asset) => {
        const result = byKey.get(`${release.tag}\u0000${asset.name}`);
        const ok = result && result.status !== 'failed';
        const recorded = previousByFile.get(asset.fileName);
        return {
          name: asset.name,
          fileName: asset.fileName,
          size: ok ? result.size ?? asset.size : asset.size,
          sha256: ok ? result.sha256 ?? asset.sha256 : asset.sha256,
          verified: Boolean(ok && result.verified),
          downloaded: Boolean(ok),
          status: result ? result.status : 'pending',
          error: result && result.error ? String(result.error).slice(0, 500) : null,
          mtimeMs: ok ? result.mtimeMs ?? recorded?.mtimeMs ?? null : null,
          updatedAt: asset.updatedAt,
          sourceUrl: asset.htmlUrl,
          // 记录这次实际用的加速源，便于排查"这个文件是从哪来的"
          mirror: ok ? result.mirror ?? recorded?.mirror ?? null : null,
          resumedFrom: ok ? result.resumedFrom ?? 0 : 0,
          mirrorsTried: ok && Array.isArray(result.mirrorsTried) ? result.mirrorsTried : undefined,
        };
      }),
    })),
  };
}

async function runSync(reason) {
  const startedAt = Date.now();
  state.running = true;
  state.reason = reason;
  state.startedAt = nowIso();
  state.finishedAt = null;
  state.lastError = null;
  state.runs += 1;
  resetProgress();

  log.info(`开始同步 (原因: ${reason})，仓库: ${config.repo}`);

  try {
    await store.ensureDirs();
    const previousManifest = await store.readManifest();

    const perPage = Math.min(100, Math.max(30, config.keepVersions * 10));
    const rawReleases = await listReleases({ perPage });
    log.info(`获取到 ${rawReleases.length} 个 release（含 pre-release: ${config.includePrerelease}）`);

    const selected = selectReleases(rawReleases, config.keepVersions);
    if (selected.length === 0) {
      throw new Error(
        `没有找到可用的 release（仓库 ${config.repo}，包含 pre=${config.includePrerelease}，` +
          `ASSET_REGEX=${config.assetRegex ? config.assetRegex.source : '未设置'}）`,
      );
    }
    const localTag = previousManifest.releases?.[0]?.tag ?? null;
    log.info(
      `将保留 ${selected.length} 个版本: ${selected.map((r) => r.tag).join(', ')}` +
        (localTag && localTag !== selected[0].tag ? `（本地旧版本: ${localTag}）` : ''),
    );

    // 建立本地已记录信息，避免每次同步都重算几百 MB 的 sha256
    const recordedByFile = new Map();
    for (const rel of previousManifest.releases || []) {
      for (const a of rel.assets || []) {
        if (a.fileName) recordedByFile.set(a.fileName, a);
      }
    }

    const tasks = selected.flatMap((release) =>
      release.assets.map((asset) => ({
        tag: release.tag,
        asset,
        dest: path.join(FILES_DIR, asset.fileName),
      })),
    );

    const results = await runPool(tasks, config.downloadConcurrency, async (task) => {
      const { tag, asset, dest } = task;
      try {
        const existing = await verifyExisting(dest, asset, recordedByFile.get(asset.fileName));
        if (existing) {
          log.info(`已是最新，跳过下载: ${asset.fileName} (${humanBytes(existing.size)})`);
          return { tag, asset, dest, status: 'skipped', ...existing };
        }
        const info = await downloadAsset(asset, dest);
        state.downloadsCompleted += 1;
        state.bytesDownloaded += info.size || 0;
        return { tag, asset, dest, status: 'downloaded', ...info };
      } catch (err) {
        log.error(`下载失败: ${asset.fileName} - ${err.message}`);
        return { tag, asset, dest, status: 'failed', error: err.message };
      }
    });

    const failed = results.filter((r) => r.status === 'failed');
    const ok = results.filter((r) => r.status !== 'failed');

    // 写 manifest（失败的文件仍会列出，但 downloaded=false）
    const manifest = buildManifest(selected, results, previousManifest);
    await store.writeManifest(manifest);

    // 删除旧版本 / 残留半成品
    const keep = new Set(ok.map((r) => path.basename(r.dest)));
    const pruneResult = await store.pruneFiles(keep);
    const removed = pruneResult.deleted?.length || 0;
    if (removed > 0) {
      state.prunedFiles += removed;
      const bytes = pruneResult.deleted.reduce((sum, d) => sum + (d.size || 0), 0);
      log.info(`已清理 ${removed} 个旧文件，释放 ${humanBytes(bytes)}`);
    }

    const newest = selected[0];
    const durationMs = Date.now() - startedAt;
    state.lastResult = {
      newestTag: newest.tag,
      newestPrerelease: newest.prerelease,
      localTags: selected.map((r) => r.tag),
      downloaded: ok.filter((r) => r.status === 'downloaded').length,
      skipped: ok.filter((r) => r.status === 'skipped').length,
      failed: failed.length,
      pruned: removed,
      durationMs,
    };

    if (failed.length > 0) {
      state.consecutiveFailures += 1;
      state.lastError = `${failed.length} 个文件下载失败: ${failed.map((f) => f.asset.fileName).join(', ')}`;
      log.error(`同步部分失败: ${state.lastError}`);
    } else {
      state.consecutiveFailures = 0;
      state.lastSuccessAt = nowIso();
      log.info(
        `同步完成: 最新版本 ${newest.tag}${newest.prerelease ? ' (pre-release)' : ''}，` +
          `新下载 ${state.lastResult.downloaded} 个，已存在 ${state.lastResult.skipped} 个，` +
          `清理 ${removed} 个，用时 ${(durationMs / 1000).toFixed(1)}s`,
      );
    }
    return state.lastResult;
  } catch (err) {
    state.consecutiveFailures += 1;
    state.lastError = err.message;
    log.error(`同步失败 (第 ${state.consecutiveFailures} 次连续失败): ${err.message}`);
    throw err;
  } finally {
    state.running = false;
    state.finishedAt = nowIso();
    resetProgress();
  }
}

/**
 * 触发一次同步；已有同步在跑时直接复用，避免并发。
 *
 * rerunIfBusy=true 用于"配置刚改过"这类场景：当前这次同步用的是旧配置，
 * 因此等它结束后会自动再补一次同步，保证新配置立刻生效而不是等到下个周期。
 */
export function syncNow(reason = 'manual', { rerunIfBusy = false } = {}) {
  if (inFlight) {
    if (rerunIfBusy) {
      rerunRequested = true;
      log.info(`同步已在进行中，已排队在结束后按新配置再同步一次（请求原因: ${reason}）`);
    } else {
      log.info(`同步已在进行中，复用当前任务（请求原因: ${reason}）`);
    }
    return inFlight;
  }
  inFlight = runSync(reason).finally(() => {
    inFlight = null;
    if (rerunRequested) {
      rerunRequested = false;
      // 排队的那次同步用最新配置重跑
      syncNow('queued-rerun').catch(() => {});
    }
  });
  return inFlight;
}

/** 只检查远端是否有更新，不下载。 */
export async function checkForUpdate() {
  const manifest = await store.readManifest();
  const rawReleases = await listReleases({ perPage: 30 });
  const normalized = rawReleases
    .map(normalizeRelease)
    .filter((r) => config.includePrerelease || !r.prerelease)
    .filter((r) => r.assets.length > 0);
  const sorted = sortReleases(normalized);
  const latest = sorted[0] ?? null;
  const localTags = (manifest.releases || []).map((r) => r.tag);
  const localNewest = localTags[0] ?? null;
  return {
    remoteLatest: latest
      ? {
          tag: latest.tag,
          prerelease: latest.prerelease,
          publishedAt: latest.publishedAt,
          assets: latest.assets.map((a) => ({ name: a.name, size: a.size, sha256: a.sha256 })),
        }
      : null,
    localTags,
    updateAvailable: Boolean(latest && latest.tag !== localNewest),
    totalRemoteReleases: sorted.length,
  };
}

export function startScheduler() {
  stopped = false;
  if (config.syncOnStart) {
    syncNow('startup').catch((err) => log.error(`启动同步失败: ${err.message}`));
  } else {
    log.info('SYNC_ON_START=false，跳过启动同步');
  }
  scheduleNext();
}

function scheduleNext() {
  if (stopped || config.syncIntervalSeconds <= 0) {
    state.nextRunAt = null;
    if (config.syncIntervalSeconds <= 0) log.info('SYNC_INTERVAL_SECONDS=0，定时同步已关闭');
    return;
  }
  const delayMs = config.syncIntervalSeconds * 1000;
  state.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  timer = setTimeout(async () => {
    try {
      await syncNow('interval');
    } catch {
      /* 错误已在 runSync 内记录 */
    }
    scheduleNext();
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopScheduler() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  state.nextRunAt = null;
}

/** 配置变更后重新计算下一次轮询时间（例如运行时改了同步间隔）。 */
export function reschedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!stopped) scheduleNext();
}
