import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, publicConfig } from './config.js';
import { GitHubError } from './github.js';
import { mirrorSnapshot, probeNow } from './mirrors.js';
import { log } from './logger.js';
import * as settings from './settings.js';
import * as store from './store.js';
import * as sync from './sync.js';
import { APP_NAME, APP_VERSION, humanBytes, nowIso } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.msi': 'application/octet-stream',
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
  '.apk': 'application/vnd.android.package-archive',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.yml': 'text/yaml; charset=utf-8',
  '.blockmap': 'application/octet-stream',
};

function guessType(name) {
  return MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

function baseUrlFor(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${config.port}`;
  return `${String(proto).split(',')[0]}://${String(host).split(',')[0]}`;
}

function corsHeaders(req) {
  if (config.corsOrigin === '') return {};
  const allowed = config.corsOrigin === '*' ? (req.headers.origin || '*') : config.corsOrigin;
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
    'access-control-allow-headers': 'Authorization,Content-Type,X-API-Token,Range',
    'access-control-expose-headers': 'Content-Length,Content-Range,Content-Disposition,ETag',
    vary: 'Origin',
  };
}

function sendJson(req, res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...corsHeaders(req),
  });
  if (req.method === 'HEAD') return res.end();
  res.end(payload);
}

/** 读取并解析 JSON 请求体（限制大小，避免被塞爆内存），空体返回 {}。 */
function readJsonBody(req, { limit = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体过大（上限 ${limit} 字节）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function extractToken(req) {
  const auth = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  if (req.headers['x-api-token']) return String(req.headers['x-api-token']).trim();
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token') || '';
}

/** 定长比较，避免 token 校验被时序攻击。 */
function tokenEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 返回 true 表示已放行，false 表示已经响应了 401。 */
function authorize(req, res, { write = false, download = false } = {}) {
  const needWrite = write && Boolean(config.apiToken);
  const needDownload = download && Boolean(config.protectDownloads);
  if (!needWrite && !needDownload) return true;

  const expected = config.apiToken;
  if (!expected) {
    sendJson(req, res, 401, {
      error: 'misconfigured',
      message: 'PROTECT_DOWNLOADS=true 但没有设置 API_TOKEN，请先设置 API_TOKEN 再启用下载保护',
    });
    return false;
  }

  const provided = extractToken(req);
  if (provided && tokenEquals(provided, expected)) return true;

  sendJson(req, res, 401, {
    error: 'unauthorized',
    message: needWrite
      ? '该接口需要鉴权：请通过 Authorization: Bearer <API_TOKEN>、X-API-Token 头或 ?token=<API_TOKEN> 提供'
      : '下载接口已开启鉴权（PROTECT_DOWNLOADS=true）：请提供 API_TOKEN',
  });
  return false;
}

async function serveFileRequest(req, res, fileName, { download = false } = {}) {
  const safe = path.basename(String(fileName || ''));
  if (!safe || safe === '.' || safe === '..') {
    return sendJson(req, res, 400, { error: 'bad_request', message: '非法的文件名' });
  }
  if (!authorize(req, res, { download: true })) return undefined;

  const info = await store.statLocalFile(safe);
  if (!info) {
    return sendJson(req, res, 404, {
      error: 'not_found',
      message: `本地没有文件 ${safe}，可能尚未下载完成；可调用 POST /api/sync 立即同步，或查看 /api/files`,
    });
  }
  return streamFile(req, res, info, { download });
}

/** 支持 Range / ETag / HEAD 的文件下发，可用于浏览器直接下载、curl、迅雷/IDM 多线程。 */
function streamFile(req, res, info, { download = false } = {}) {
  const etag = `W/"${info.size}-${info.mtimeMs}"`;
  const headers = {
    'content-type': guessType(info.name),
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=300',
    etag,
    'last-modified': new Date(info.mtimeMs).toUTCString(),
    ...corsHeaders(req),
  };
  if (download) {
    const ascii = info.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
    headers['content-disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(info.name)}`;
  }

  let start = 0;
  let end = info.size - 1;
  let status = 200;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}`, ...corsHeaders(req) });
      return res.end();
    }
    if (m[1] === '') {
      const suffix = Number(m[2]);
      start = Math.max(0, info.size - suffix);
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}`, ...corsHeaders(req) });
      return res.end();
    }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
  }

  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  headers['content-length'] = String(end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(info.path, { start, end });
  stream.on('error', (err) => {
    log.warn(`读取文件失败 ${info.name}: ${err.message}`);
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
  return undefined;
}

async function serveIndex(req, res) {
  try {
    const html = await fsp.readFile(INDEX_HTML, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-cache',
    });
    return res.end(html);
  } catch {
    return sendJson(req, res, 200, {
      service: APP_NAME,
      version: APP_VERSION,
      endpoints: ['/api/status', '/api/releases', '/api/latest', '/api/files', '/latest', '/download/<file>'],
    });
  }
}

function buildReleaseResponse(req, manifest) {
  const base = baseUrlFor(req);
  const files = new Set();
  const releases = (manifest.releases || []).map((rel) => ({
    tag: rel.tag,
    name: rel.name,
    prerelease: rel.prerelease,
    publishedAt: rel.publishedAt,
    htmlUrl: rel.htmlUrl || `https://github.com/${config.repo}/releases/tag/${encodeURIComponent(rel.tag)}`,
    assets: (rel.assets || []).map((a) => {
      if (a.fileName) files.add(a.fileName);
      return {
        name: a.name,
        fileName: a.fileName,
        size: a.size,
        sizeHuman: humanBytes(a.size),
        sha256: a.sha256,
        verified: Boolean(a.verified),
        downloaded: Boolean(a.downloaded),
        status: a.status,
        error: a.error || null,
        updatedAt: a.updatedAt || null,
        downloadUrl: a.fileName ? `${base}/download/${encodeURIComponent(a.fileName)}` : null,
        directUrl: a.fileName ? `${base}/files/${encodeURIComponent(a.fileName)}` : null,
        sourceUrl: a.sourceUrl || null,
      };
    }),
  }));
  return { releases, files: [...files], base };
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/status' || pathname === '/api/health') {
    const [state, usage, manifest] = await Promise.all([sync.getSyncState(), store.diskUsage(), store.readManifest()]);
    return sendJson(req, res, 200, {
      service: APP_NAME,
      version: APP_VERSION,
      time: nowIso(),
      repo: config.repo,
      mirrors: {
        mode: config.mirrorMode,
        asset: mirrorSnapshot().asset.chosen,
        api: mirrorSnapshot().api.chosen,
        detail: '/api/mirrors',
      },
      sync: state,
      storage: {
        dataDir: config.dataDir,
        filesDir: path.join(config.dataDir, 'files'),
        fileCount: usage.fileCount,
        bytes: usage.bytes,
        bytesHuman: humanBytes(usage.bytes),
        partialBytes: usage.partialBytes,
      },
      manifest: { lastSyncAt: manifest.lastSyncAt, localTags: (manifest.releases || []).map((r) => r.tag) },
      endpoints: {
        latest: '/api/latest',
        releases: '/api/releases',
        files: '/api/files',
        check: '/api/check',
        sync: 'POST /api/sync',
        settings: '/api/settings',
        mirrors: '/api/mirrors',
        mirrorProbe: 'POST /api/mirrors/probe',
        directFile: '/download/<fileName>',
        alwaysLatest: '/latest',
      },
    });
  }

  if (pathname === '/api/config') {
    return sendJson(req, res, 200, { ...publicConfig(), runtime: settings.currentSettings() });
  }

  if (pathname === '/api/settings') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!authorize(req, res, { write: true })) return undefined;
      return sendJson(req, res, 200, settings.currentSettings());
    }
    if (req.method !== 'POST') {
      return sendJson(req, res, 405, { error: 'method_not_allowed', message: '请使用 GET 或 POST /api/settings' });
    }
    if (!authorize(req, res, { write: true })) return undefined;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(req, res, 400, { error: 'bad_request', message: `请求体解析失败: ${err.message}` });
    }

    const reset = body && typeof body === 'object' && body.reset === true;
    const patch = body && typeof body === 'object' ? { ...body } : {};
    delete patch.reset;

    try {
      const before = { repo: config.repo, apiBase: config.apiBase };
      const effective = await settings.updateSettings(patch, { reset });
      const repoChanged = before.repo !== config.repo || before.apiBase !== config.apiBase;

      // 让新的间隔/仓库立刻生效：重排定时器并马上同步一次
      sync.reschedule();
      // 如果此刻正好有同步在跑（用的是旧配置），排队结束后按新配置再同步一次
      const promise = sync.syncNow('settings-change', { rerunIfBusy: true });
      promise.catch(() => {});

      return sendJson(req, res, 200, {
        ok: true,
        repoChanged,
        message: repoChanged
          ? `已将镜像仓库切换为 ${config.repo}，并已在后台开始同步（旧仓库的文件会在这次同步后被清理）`
          : '配置已保存并生效，已在后台触发一次同步',
        settings: effective,
        statusUrl: `${baseUrlFor(req)}/api/status`,
      });
    } catch (err) {
      if (err instanceof settings.SettingsError) {
        return sendJson(req, res, 400, { error: 'invalid_settings', message: err.message, field: err.field ?? null });
      }
      log.error(`更新运行时配置失败: ${err.message}`);
      return sendJson(req, res, 500, { error: 'settings_failed', message: err.message });
    }
  }

  // 加速源（镜像）状态与测速
  if (pathname === '/api/mirrors' || pathname === '/api/mirrors/probe') {
    if (pathname === '/api/mirrors' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(req, res, 200, {
        ...mirrorSnapshot(),
        note: 'mode=auto 时每次拉取前探测并选延迟最低的可用源；POST /api/mirrors/probe 可强制立即重测',
      });
    }
    if (req.method !== 'POST') {
      return sendJson(req, res, 405, { error: 'method_not_allowed', message: '请使用 GET /api/mirrors 或 POST /api/mirrors/probe' });
    }
    if (!authorize(req, res, { write: true })) return undefined;

    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(req, res, 400, { error: 'bad_request', message: `请求体解析失败: ${err.message}` });
    }
    const kind = ['asset', 'api', 'both'].includes(body?.kind) ? body.kind : 'both';
    try {
      const result = await probeNow(kind);
      return sendJson(req, res, 200, { ok: true, mode: config.mirrorMode, ...result });
    } catch (err) {
      return sendJson(req, res, 502, { error: 'mirror_probe_failed', message: `加速源探测失败: ${err.message}` });
    }
  }

  if (pathname === '/api/releases') {
    const manifest = await store.readManifest();
    const { releases, base } = buildReleaseResponse(req, manifest);
    return sendJson(req, res, 200, {
      repo: config.repo,
      lastSyncAt: manifest.lastSyncAt,
      count: releases.length,
      keepVersions: config.keepVersions,
      includePrerelease: config.includePrerelease,
      baseUrl: base,
      releases,
    });
  }

  if (pathname === '/api/latest') {
    const manifest = await store.readManifest();
    const { releases, base } = buildReleaseResponse(req, manifest);
    const latest = releases[0] || null;
    if (!latest) {
      return sendJson(req, res, 404, {
        error: 'not_found',
        message: '本地还没有任何版本，请先调用 POST /api/sync',
      });
    }
    const first = latest.assets.find((a) => a.downloaded) || latest.assets[0] || null;
    return sendJson(req, res, 200, {
      repo: config.repo,
      lastSyncAt: manifest.lastSyncAt,
      tag: latest.tag,
      prerelease: latest.prerelease,
      publishedAt: latest.publishedAt,
      htmlUrl: latest.htmlUrl,
      alwaysLatestUrl: `${base}/latest`,
      fileCount: latest.assets.length,
      files: latest.assets,
      primaryDownloadUrl: first ? first.downloadUrl : null,
      directUrl: first ? first.directUrl : null,
    });
  }

  if (pathname === '/api/files') {
    const [files, manifest] = await Promise.all([store.listLocalFiles(), store.readManifest()]);
    const base = baseUrlFor(req);
    const owner = new Map();
    for (const rel of manifest.releases || []) {
      for (const a of rel.assets || []) {
        if (a.fileName) owner.set(a.fileName, { tag: rel.tag, name: a.name, prerelease: rel.prerelease, sha256: a.sha256 });
      }
    }
    return sendJson(req, res, 200, {
      count: files.length,
      totalBytes: files.reduce((s, f) => s + f.size, 0),
      files: files.map((f) => ({
        name: f.name,
        fileName: f.name,
        size: f.size,
        sizeHuman: humanBytes(f.size),
        modifiedAt: f.modifiedAt,
        sha256: owner.get(f.name)?.sha256 ?? null,
        tag: owner.get(f.name)?.tag ?? null,
        prerelease: owner.get(f.name)?.prerelease ?? null,
        downloadUrl: `${base}/download/${encodeURIComponent(f.name)}`,
        directUrl: `${base}/files/${encodeURIComponent(f.name)}`,
      })),
    });
  }

  if (pathname === '/api/check') {
    if (!authorize(req, res, { download: true })) return undefined;
    try {
      const result = await sync.checkForUpdate();
      return sendJson(req, res, 200, { ...result, checkedAt: nowIso() });
    } catch (err) {
      return sendJson(req, res, err instanceof GitHubError ? 502 : 500, { error: 'check_failed', message: err.message });
    }
  }

  if (pathname === '/api/sync') {
    if (req.method !== 'POST' && req.method !== 'GET') {
      return sendJson(req, res, 405, { error: 'method_not_allowed', message: '请使用 POST /api/sync' });
    }
    if (!authorize(req, res, { write: true })) return undefined;
    const wait = ['1', 'true', 'yes'].includes(String(url.searchParams.get('wait') || '').toLowerCase());
    const running = sync.getSyncState().running;
    const promise = sync.syncNow(wait ? 'api' : 'api-async');
    if (wait) {
      try {
        const result = await promise;
        return sendJson(req, res, 200, { ok: true, waited: true, result });
      } catch (err) {
        return sendJson(req, res, 500, { ok: false, error: 'sync_failed', message: err.message });
      }
    }
    promise.catch(() => {});
    const state = sync.getSyncState();
    return sendJson(req, res, 202, {
      ok: true,
      started: !running,
      alreadyRunning: running,
      message: running ? '同步正在进行中' : '同步已在后台启动，可用 GET /api/status 查看进度',
      statusUrl: `${baseUrlFor(req)}/api/status`,
    });
  }

  return sendJson(req, res, 404, {
    error: 'not_found',
    message: `未知接口: ${pathname}`,
    endpoints: [
      '/api/status',
      '/api/mirrors',
      '/api/releases',
      '/api/latest',
      '/api/files',
      '/api/check',
      '/api/settings',
      'POST /api/sync',
      'POST /api/settings',
    ],
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (pathname === '/health') {
    return sendJson(req, res, 200, { status: 'ok', time: nowIso(), version: APP_VERSION });
  }

  if (pathname.startsWith('/api/')) {
    if (pathname !== '/api/status' && pathname !== '/api/health' && config.protectDownloads) {
      if (!authorize(req, res, { download: true })) return undefined;
    }
    return handleApi(req, res, url);
  }

  if (pathname === '/' || pathname === '/index.html') {
    return serveIndex(req, res);
  }

  // 直接访问：/files/<name>、/download/<name>、/dl/<name>
  let m = /^\/(?:files|download|dl)\/(.+)$/.exec(pathname);
  if (m) {
    const attachment = pathname.startsWith('/download') || pathname.startsWith('/dl');
    return serveFileRequest(req, res, m[1], { download: attachment });
  }

  // 始终指向最新版本：/latest 或 /latest/<name>
  if (pathname === '/latest' || pathname === '/latest/') {
    if (!authorize(req, res, { download: true })) return undefined;
    const manifest = await store.readManifest();
    const latest = (manifest.releases || [])[0];
    const assets = (latest?.assets || []).filter((a) => a.downloaded && a.fileName);
    if (!latest || assets.length === 0) {
      return sendJson(req, res, 404, {
        error: 'not_found',
        message: '本地还没有可用的最新版本文件，请先调用 POST /api/sync',
      });
    }
    if (assets.length === 1) {
      res.writeHead(302, { location: `/download/${encodeURIComponent(assets[0].fileName)}` });
      return res.end();
    }
    const base = baseUrlFor(req);
    return sendJson(req, res, 200, {
      tag: latest.tag,
      message: '该版本包含多个文件，请从列表中选择',
      files: assets.map((a) => `${base}/download/${encodeURIComponent(a.fileName)}`),
    });
  }

  m = /^\/latest\/(.+)$/.exec(pathname);
  if (m) {
    const manifest = await store.readManifest();
    const latest = (manifest.releases || [])[0];
    const wanted = path.basename(m[1]);
    const asset = (latest?.assets || []).find((a) => a.fileName === wanted || a.name === wanted);
    if (!asset || !asset.fileName) {
      return sendJson(req, res, 404, { error: 'not_found', message: `最新版本 ${latest?.tag || '未知'} 中没有文件 ${wanted}` });
    }
    return serveFileRequest(req, res, asset.fileName, { download: false });
  }

  // 指定版本的直接访问：/releases/<tag>/<name>
  m = /^\/releases\/([^/]+)\/(.+)$/.exec(pathname);
  if (m) {
    const tag = m[1];
    const wanted = path.basename(m[2]);
    const manifest = await store.readManifest();
    const rel = (manifest.releases || []).find((r) => r.tag === tag);
    const asset = (rel?.assets || []).find((a) => a.fileName === wanted || a.name === wanted);
    if (!asset || !asset.fileName) {
      return sendJson(req, res, 404, { error: 'not_found', message: `版本 ${tag} 中没有文件 ${wanted}（可能已被清理，当前保留: ${(manifest.releases || []).map((r) => r.tag).join(', ')}）` });
    }
    return serveFileRequest(req, res, asset.fileName, { download: false });
  }

  return sendJson(req, res, 404, { error: 'not_found', message: `未知路径: ${pathname}` });
}

export function createServer() {
  return http.createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        log.warn(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
      } else {
        log.debug(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
      }
    });
    route(req, res).catch((err) => {
      log.error(`处理请求失败 ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(req, res, 500, { error: 'internal_error', message: err.message });
    });
  });
}

async function main() {
  await store.ensureDirs();
  // 先加载运行时配置（settings.json 优先于环境变量），再启动服务与定时同步
  await settings.loadSettings();
  const server = createServer();
  server.headersTimeout = 65_000;
  server.requestTimeout = 0; // 大文件下载不设总时长限制

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  log.banner({
    repo: config.repo,
    listen: `http://${config.host}:${config.port}`,
    dataDir: config.dataDir,
    keepVersions: config.keepVersions,
    includePrerelease: config.includePrerelease,
    syncIntervalSeconds: config.syncIntervalSeconds,
    githubToken: config.token ? '已配置' : '未配置（公开仓库够用，但受 60 次/小时限制）',
  });

  sync.startScheduler();

  const shutdown = (signal) => {
    log.info(`收到 ${signal}，正在关闭...`);
    sync.stopScheduler();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    log.error(`启动失败: ${err.stack || err.message}`);
    process.exit(1);
  });
}
