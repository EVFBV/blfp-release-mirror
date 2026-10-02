import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { log } from './logger.js';
import { applyMirror, mirrorLabel } from './mirror-list.js';
import { assetPool, setAssetSampleUrl } from './mirrors.js';
import { fileSha256, humanBytes, sleep, updateHashFromFile } from './util.js';

/** 下载期间的进度回调（由 sync 层注入，用于 /api/status 显示） */
let progressHook = () => {};
export function setProgressHook(fn) {
  progressHook = typeof fn === 'function' ? fn : () => {};
}

export class DownloadError extends Error {
  constructor(message, { retryable = true, code = null } = {}) {
    super(message);
    this.name = 'DownloadError';
    this.retryable = retryable;
    this.code = code;
  }
}

function downloadHeaders({ rangeStart = 0 } = {}) {
  const headers = {
    accept: 'application/octet-stream',
    'user-agent': 'blfp-release-mirror/1.0',
  };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (rangeStart > 0) headers.range = `bytes=${rangeStart}-`;
  return headers;
}

/**
 * 单个资产的下载：自动挑加速源、支持断点续传（.part + Range）、sha256 校验、卡死看门狗、失败重试。
 *
 * 加速源策略：先让镜像池给出「按实测延迟排序」的候选源（含直连兜底），
 * 依次尝试；某个源失败就换下一个源，已下载的 .part 保留，
 * 所以换源后是接着下而不是从头下（各源提供的是同一份字节）。
 */
export async function downloadAsset(asset, destPath) {
  const partPath = `${destPath}.part`;
  const originalUrl = asset.downloadUrl;
  const pool = asset.mirrorPool ?? assetPool();
  setAssetSampleUrl(originalUrl);

  let candidates;
  try {
    candidates = await pool.order(originalUrl);
  } catch (err) {
    log.warn(`加速源探测失败，改用直连: ${err.message}`);
    candidates = [''];
  }
  if (candidates.length === 0) candidates = [''];

  let lastError = null;
  const tried = [];

  for (const prefix of candidates) {
    const url = applyMirror(prefix, originalUrl);
    tried.push(mirrorLabel(prefix));
    log.info(`下载 ${asset.fileName}（源：${mirrorLabel(prefix)}）`);

    let mirrorFailed = false;
    for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
      try {
        const result = await downloadOnce({ ...asset, downloadUrl: url, mirror: mirrorLabel(prefix) }, destPath, partPath, attempt);
        pool.reportSuccess(prefix);
        return { ...result, mirror: mirrorLabel(prefix), mirrorsTried: tried };
      } catch (err) {
        lastError = err;
        // 校验失败说明 .part 内容已损坏（可能是换了源但内容不一致），丢弃后重试
        if (err.code === 'CHECKSUM_MISMATCH' || err.code === 'SIZE_MISMATCH') {
          await fsp.rm(partPath, { force: true }).catch(() => {});
        }
        if (!err.retryable) {
          mirrorFailed = true;
          break;
        }
        if (attempt >= config.maxRetries) break;
        const delay = Math.min(30000, 1000 * 2 ** (attempt - 1));
        log.warn(
          `下载失败，${Math.round(delay / 1000)}s 后重试 (${attempt}/${config.maxRetries}) ` +
            `[${mirrorLabel(prefix)}]: ${asset.fileName} - ${err.message}`,
        );
        progressHook({
          phase: 'retry-wait',
          fileName: asset.fileName,
          attempt,
          error: err.message,
          mirror: mirrorLabel(prefix),
        });
        await sleep(delay);
      }
    }

    pool.reportFailure(prefix);
    if (candidates.indexOf(prefix) < candidates.length - 1) {
      log.warn(`源 ${mirrorLabel(prefix)} 下载失败（${lastError?.message ?? '未知原因'}），自动切换到下一个源`);
      progressHook({
        phase: 'switch-mirror',
        fileName: asset.fileName,
        error: lastError?.message ?? null,
        mirror: mirrorLabel(prefix),
      });
    }
    void mirrorFailed;
  }

  // 彻底失败：清理 .part，避免下次误以为可以续传
  await fsp.rm(partPath, { force: true }).catch(() => {});
  throw lastError ?? new DownloadError(`下载失败: ${asset.fileName}`);
}

async function downloadOnce(asset, destPath, partPath, attempt) {
  const startedAt = Date.now();
  let sinkHash = crypto.createHash('sha256');
  let start = 0;
  let resumedFrom = 0;

  // 1) 看看有没有可续传的半成品；先把已有部分的哈希算好再发请求，
  //    避免拿住响应体不读（会让连接空转甚至触发解析器异常）。
  let resumeHash = null;
  try {
    const st = await fsp.stat(partPath);
    if (st.size > 0 && (!asset.size || st.size < asset.size)) {
      start = st.size;
      resumeHash = crypto.createHash('sha256');
      await updateHashFromFile(partPath, resumeHash);
    } else if (st.size > 0) {
      await fsp.rm(partPath, { force: true });
    }
  } catch {
    /* 没有半成品，正常从 0 开始 */
  }

  // 看门狗：超过 stallTimeoutSeconds 没收到任何数据就中断，交给重试/换源逻辑
  const controller = new AbortController();
  let stalled = false;
  let stallTimer = null;
  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, config.stallTimeoutSeconds * 1000);
  };
  armStallTimer();

  try {
    const res = await fetch(asset.downloadUrl, {
      headers: downloadHeaders({ rangeStart: start }),
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status === 404 || res.status === 403) {
        throw new DownloadError(`HTTP ${res.status} ${res.statusText}（资产可能已被删除、需要 GITHUB_TOKEN，或该加速源不支持此文件）`, {
          retryable: false,
        });
      }
      throw new DownloadError(`HTTP ${res.status} ${res.statusText}`);
    }
    if (!res.body) throw new DownloadError('响应没有 body');

    const isPartial = res.status === 206;
    if (start > 0 && isPartial) {
      const contentRange = res.headers.get('content-range') || '';
      const m = /bytes\s+(\d+)-/i.exec(contentRange);
      if (!m || Number(m[1]) !== start) {
        // 服务端返回的范围和预期不符，放弃续传，重新开始
        log.warn(`续传范围不匹配(${contentRange})，将重新完整下载: ${asset.fileName}`);
        await fsp.rm(partPath, { force: true });
        start = 0;
        throw new DownloadError('续传范围不匹配');
      }
      resumedFrom = start;
      sinkHash = resumeHash; // 续用已算好的前缀哈希（注意不能 finalize）
      log.info(`断点续传 ${asset.fileName}：从 ${humanBytes(start)} 继续（源：${asset.mirror ?? '直连'}）`);
    } else if (start > 0) {
      // 服务端不支持 Range（200），重新开始
      await fsp.rm(partPath, { force: true });
      start = 0;
      sinkHash = crypto.createHash('sha256');
      throw new DownloadError('服务端不支持断点续传，重新下载');
    }

    progressHook({
      phase: 'downloading',
      fileName: asset.fileName,
      received: start,
      total: asset.size || 0,
      attempt,
      resumedFrom,
      mirror: asset.mirror ?? null,
    });

    const out = fs.createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' });
    let received = start;
    let lastReport = 0;

    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      sinkHash.update(chunk);
      armStallTimer();
      const now = Date.now();
      if (now - lastReport > 500) {
        lastReport = now;
        progressHook({
          phase: 'downloading',
          fileName: asset.fileName,
          received,
          total: asset.size || 0,
          attempt,
          resumedFrom,
          mirror: asset.mirror ?? null,
        });
      }
    });

    await pipeline(source, out);
    clearTimeout(stallTimer);

    // 2) 大小校验
    const finalSize = (await fsp.stat(partPath)).size;
    if (asset.size && finalSize !== asset.size) {
      const err = new DownloadError(`文件大小不符：期望 ${asset.size} 字节，实际 ${finalSize} 字节`);
      err.code = 'SIZE_MISMATCH';
      throw err;
    }

    // 3) sha256 校验（GitHub 提供 digest 时）
    const digest = sinkHash.digest('hex');
    if (asset.sha256 && asset.sha256.toLowerCase() !== digest) {
      const err = new DownloadError(`sha256 校验失败：期望 ${asset.sha256}，实际 ${digest}`);
      err.code = 'CHECKSUM_MISMATCH';
      throw err;
    }

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.rename(partPath, destPath);
    const st = await fsp.stat(destPath);
    const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    log.info(
      `下载完成 ${asset.fileName} (${humanBytes(st.size)}) 用时 ${seconds.toFixed(1)}s` +
        `${resumedFrom ? `，其中续传 ${humanBytes(resumedFrom)}` : ''}${asset.sha256 ? '，校验通过' : ''}` +
        `${asset.mirror ? `，源：${asset.mirror}` : ''}`,
    );
    progressHook({
      phase: 'done',
      fileName: asset.fileName,
      received: st.size,
      total: asset.size || st.size,
      attempt,
      mirror: asset.mirror ?? null,
    });

    return {
      fileName: path.basename(destPath),
      size: st.size,
      sha256: asset.sha256 ? digest : null,
      verified: Boolean(asset.sha256),
      resumedFrom,
      mtimeMs: Math.floor(st.mtimeMs),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (stalled) throw new DownloadError(`下载卡死超过 ${config.stallTimeoutSeconds}s，已中断: ${asset.fileName}`);
    if (err instanceof DownloadError) throw err;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new DownloadError(`下载被中断: ${err.message}`);
    }
    throw new DownloadError(`下载出错: ${err.message}`);
  } finally {
    clearTimeout(stallTimer);
  }
}

/**
 * 判断本地文件是否已经是正确的版本：
 * manifest 里记录的 size+mtime 未变则直接信任，否则重算 sha256。
 */
export async function verifyExisting(destPath, asset, recorded = null) {
  let st;
  try {
    st = await fsp.stat(destPath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size === 0) return null;
  const mtimeMs = Math.floor(st.mtimeMs);

  if (asset.size && st.size !== asset.size) {
    log.warn(`本地文件大小与远端不一致，将重新下载: ${asset.fileName}`);
    return null;
  }
  if (recorded && recorded.size === st.size && recorded.mtimeMs === mtimeMs && recorded.sha256) {
    return { fileName: path.basename(destPath), size: st.size, sha256: recorded.sha256, verified: true, mtimeMs, reused: true };
  }
  if (!asset.sha256) {
    return { fileName: path.basename(destPath), size: st.size, sha256: null, verified: false, mtimeMs };
  }
  const digest = await fileSha256(destPath);
  if (digest.toLowerCase() !== asset.sha256.toLowerCase()) {
    log.warn(`本地文件校验和不匹配，将重新下载: ${asset.fileName}`);
    return null;
  }
  return { fileName: path.basename(destPath), size: st.size, sha256: digest, verified: true, mtimeMs };
}
