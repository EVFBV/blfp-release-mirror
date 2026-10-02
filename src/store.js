import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, FILES_DIR, MANIFEST_PATH } from './config.js';
import { log } from './logger.js';
import { nowIso } from './util.js';

const PART_MAX_AGE_MS = 6 * 3600 * 1000;

export async function ensureDirs() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
}

function emptyManifest() {
  return {
    schema: 1,
    repo: config.repo,
    lastSyncAt: null,
    lastSyncReason: null,
    releases: [],
  };
}

export async function readManifest() {
  try {
    const raw = await fsp.readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyManifest();
    return { ...emptyManifest(), ...parsed, releases: Array.isArray(parsed.releases) ? parsed.releases : [] };
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`读取 manifest 失败，将重建: ${err.message}`);
    return emptyManifest();
  }
}

/** 原子写入 manifest：先写临时文件再 rename，避免读到半个文件。 */
export async function writeManifest(manifest) {
  await ensureDirs();
  const tmp = `${MANIFEST_PATH}.${process.pid}.tmp`;
  const payload = JSON.stringify({ ...manifest, writtenAt: nowIso() }, null, 2);
  await fsp.writeFile(tmp, payload, 'utf8');
  await fsp.rename(tmp, MANIFEST_PATH);
  return manifest;
}

/** 列出本地已下载的资产文件（不含 .part 临时文件）。 */
export async function listLocalFiles() {
  await ensureDirs();
  const entries = await fsp.readdir(FILES_DIR, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (entry.name.endsWith('.part') || entry.name.endsWith('.tmp')) continue;
    const full = path.join(FILES_DIR, entry.name);
    try {
      const st = await fsp.stat(full);
      out.push({
        name: entry.name,
        size: st.size,
        mtimeMs: Math.floor(st.mtimeMs),
        modifiedAt: new Date(st.mtimeMs).toISOString(),
        path: full,
      });
    } catch {
      /* 文件可能在统计时被删除，忽略 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function statLocalFile(name) {
  const safe = path.basename(name);
  const full = path.join(FILES_DIR, safe);
  try {
    const st = await fsp.stat(full);
    if (!st.isFile()) return null;
    return {
      name: safe,
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      modifiedAt: new Date(st.mtimeMs).toISOString(),
      path: full,
    };
  } catch {
    return null;
  }
}

export async function removeFile(name) {
  const full = path.join(FILES_DIR, path.basename(name));
  await fsp.rm(full, { force: true });
}

/**
 * 删除不在 keep 集合里的文件（旧版本）以及残留的 .part 半成品。
 * keep 为空时拒绝执行，避免配置异常时把数据全部删掉。
 */
export async function pruneFiles(keep, { dryRun = false } = {}) {
  const keepSet = keep instanceof Set ? keep : new Set(keep || []);
  if (keepSet.size === 0) {
    log.warn('prune 跳过：保留列表为空（可能是本次没有成功解析到任何 release）');
    return { deleted: [], skipped: true, reason: 'empty-keep-list' };
  }

  const entries = await fsp.readdir(FILES_DIR, { withFileTypes: true }).catch(() => []);
  const deleted = [];
  const now = Date.now();

  for (const entry of entries) {
    const full = path.join(FILES_DIR, entry.name);
    if (entry.name.endsWith('.part') || entry.name.endsWith('.tmp')) {
      try {
        const st = await fsp.stat(full);
        if (now - st.mtimeMs > PART_MAX_AGE_MS) {
          if (!dryRun) await fsp.rm(full, { force: true });
          deleted.push({ name: entry.name, reason: 'stale-partial' });
        }
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (keepSet.has(entry.name)) continue;

    let size = 0;
    try {
      size = (await fsp.stat(full)).size;
    } catch {
      continue;
    }
    if (!dryRun) await fsp.rm(full, { force: true });
    deleted.push({ name: entry.name, size, reason: 'old-version' });
    log.info(`${dryRun ? '[dry-run] 将删除' : '已删除'}旧版本文件: ${entry.name}`);
  }

  return { deleted, skipped: false };
}

/** 统计磁盘占用（用于 /api/status）。 */
export async function diskUsage() {
  const files = await listLocalFiles();
  const total = files.reduce((sum, f) => sum + f.size, 0);
  let partial = 0;
  const entries = await fsp.readdir(FILES_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.name.endsWith('.part')) continue;
    try {
      partial += (await fsp.stat(path.join(FILES_DIR, entry.name))).size;
    } catch {
      /* ignore */
    }
  }
  return { fileCount: files.length, bytes: total, partialBytes: partial };
}
