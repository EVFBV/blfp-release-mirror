import { config } from './config.js';
import { log } from './logger.js';
import { DIRECT, applyMirror, isDirect, mirrorLabel, parseMirrors } from './mirror-list.js';

/**
 * 加速源运行时层：探测延迟、自动选最快、失败降级与缓存。
 * 纯工具与默认列表在 mirror-list.js（那里不依赖 config，避免循环引用）。
 */
export { DIRECT, KNOWN_API_MIRRORS, KNOWN_ASSET_MIRRORS, applyMirror, isDirect, mirrorLabel, parseMirrors } from './mirror-list.js';

/** 探测用的样例地址（资产类）：优先用真实资产地址，其次用 releases 页面 */
let assetSampleUrl = null;
export function setAssetSampleUrl(url) {
  if (url) assetSampleUrl = url;
}
export function currentAssetSampleUrl() {
  return assetSampleUrl || `https://github.com/${config.repo}/releases/latest`;
}

/**
 * 探测资产加速源时，最好拿"真实资产地址"当样本 —— 有些源（如 gh-proxy.com）
 * 只代理 releases/download 这类路径，用 releases 页面去探会被误判成 403。
 * 这里在不知道资产地址时，先直连查一次最新 release 拿一个真实资产地址；
 * 直连不通（正是要用加速源的场景）就退回页面地址，不影响后续下载时用真实地址重探。
 */
async function resolveAssetSampleUrl() {
  if (assetSampleUrl) return { url: assetSampleUrl, real: true };
  try {
    const res = await fetch(`${config.apiBase}/repos/${config.repo}/releases?per_page=1`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'blfp-release-mirror/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const asset = Array.isArray(data) ? (data[0]?.assets || []).find((a) => a?.browser_download_url) : null;
      if (asset) {
        assetSampleUrl = asset.browser_download_url;
        return { url: assetSampleUrl, real: true };
      }
    }
  } catch {
    /* 直连不通，退回页面地址 */
  }
  return { url: `https://github.com/${config.repo}/releases/latest`, real: false };
}
function apiSampleUrl() {
  return `${config.apiBase}/repos/${config.repo}/releases?per_page=1`;
}

/**
 * 探测单个加速源：只取前 1KB，测出真实延迟，并确认是否支持 Range（决定能否断点续传）。
 * 会主动取消响应体，避免遇到「无视 Range 直接吐 270MB」的源时把内存撑爆。
 */
export async function probeMirror(prefix, sampleUrl, { timeoutMs = config.mirrorProbeTimeoutMs } = {}) {
  const url = applyMirror(prefix, sampleUrl);
  const startedAt = Date.now();
  const base = { prefix, label: mirrorLabel(prefix), url };
  try {
    const res = await fetch(url, {
      headers: { range: 'bytes=0-1023', accept: '*/*', 'user-agent': 'blfp-release-mirror/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    const contentRange = res.headers.get('content-range') || '';
    const supportsRange = res.status === 206 && /bytes\s+\d+-\d+\//i.test(contentRange);
    let received = 0;
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      try {
        while (received < 1024) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value?.byteLength ?? 0;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    if (!res.ok) {
      return { ...base, ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}` };
    }
    if (received === 0) {
      return { ...base, ok: false, status: res.status, latencyMs, error: '没有返回数据' };
    }
    return { ...base, ok: true, status: res.status, latencyMs, supportsRange, bytes: received };
  } catch (err) {
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err.name === 'TimeoutError' ? `超时(${timeoutMs}ms)` : err.message,
    };
  }
}

/** 并行探测一组加速源，按延迟升序返回（可用的在前） */
export async function probeMirrors(prefixes, sampleUrl, { timeoutMs = config.mirrorProbeTimeoutMs } = {}) {
  const results = await Promise.all(prefixes.map((p) => probeMirror(p, sampleUrl, { timeoutMs })));
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (isDirect(a.prefix) !== isDirect(b.prefix)) return isDirect(a.prefix) ? 1 : -1; // 直连放最后
    return a.latencyMs - b.latencyMs;
  });
}

/** 失败冷却时间：某个源刚失败过就先排到后面，避免每次都撞 */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * 加速源池：负责排序（自动选最快）、缓存探测结果、记录失败并降级。
 */
export class MirrorPool {
  constructor({ kind, mirrors, mode = 'auto', timeoutMs, cacheMs, now = Date.now } = {}) {
    this.kind = kind;
    this.mirrors = parseMirrors(mirrors, []);
    this.mode = mode;
    this.timeoutMs = timeoutMs ?? config.mirrorProbeTimeoutMs;
    this.cacheMs = cacheMs ?? config.mirrorProbeCacheMs;
    this.now = now;
    this.results = [];
    this.probedAt = 0;
    this.ranking = null;
    this.failures = new Map(); // prefix -> 失败时间
    this.sampleUrl = null;
  }

  /** 候选源（配置顺序），直连始终作为最后的兜底 */
  get candidates() {
    const list = [...this.mirrors];
    if (!list.some(isDirect)) list.push(DIRECT);
    return list;
  }

  snapshot() {
    const now = this.now();
    return {
      kind: this.kind,
      mode: this.mode,
      configured: this.mirrors.map(mirrorLabel),
      candidates: this.candidates.map(mirrorLabel),
      ranking: (this.ranking || []).map(mirrorLabel),
      chosen: this.ranking?.[0] !== undefined ? mirrorLabel(this.ranking[0]) : null,
      probedAt: this.probedAt ? new Date(this.probedAt).toISOString() : null,
      sampleIsRealAsset: this.sampleIsRealAsset ?? null,
      cacheSeconds: Math.round(this.cacheMs / 1000),
      cooling: [...this.failures.entries()]
        .filter(([, at]) => now - at < FAILURE_COOLDOWN_MS)
        .map(([p]) => mirrorLabel(p)),
      results: this.results.map((r) => ({
        mirror: r.label,
        ok: r.ok,
        latencyMs: r.latencyMs,
        supportsRange: Boolean(r.supportsRange),
        status: r.status ?? null,
        error: r.error ?? null,
      })),
    };
  }

  reportSuccess(prefix) {
    this.failures.delete(prefix);
    // 成功过的源下次优先用它，避免每次重新探测
    if (!this.ranking || this.ranking[0] !== prefix) {
      this.ranking = [prefix, ...(this.ranking || []).filter((p) => p !== prefix)];
    }
  }

  reportFailure(prefix) {
    if (isDirect(prefix) && this.mirrors.length === 0) return; // 没有配加速源时直连失败无需记录
    this.failures.set(prefix, this.now());
    this.ranking = (this.ranking || []).filter((p) => p !== prefix);
    log.warn(`加速源失败，暂时降级: ${mirrorLabel(prefix)}`);
  }

  /** 缓存是否还有效（同一个样例地址 + 未过期） */
  isFresh(sampleUrl) {
    return Boolean(this.ranking) && this.sampleUrl === sampleUrl && this.now() - this.probedAt < this.cacheMs;
  }

  /** 返回有序候选源（最优在前），自动模式下会先探测 */
  async order(sampleUrl = null, { force = false } = {}) {
    if (this.mode === 'off') return [DIRECT];
    if (this.mode === 'fixed') return this.applyCooldown(this.candidates);

    let sample = sampleUrl;
    if (!sample) {
      const resolved = this.kind === 'asset' ? await resolveAssetSampleUrl() : { url: apiSampleUrl(), real: true };
      sample = resolved.url;
      this.sampleIsRealAsset = resolved.real;
    } else if (this.kind === 'asset') {
      this.sampleIsRealAsset = true;
    }

    if (!force && this.isFresh(sample)) return this.applyCooldown(this.ranking);

    const prefixes = this.candidates;
    const results = await probeMirrors(prefixes, sample, { timeoutMs: this.timeoutMs });
    this.results = results;
    this.probedAt = this.now();
    this.sampleUrl = sample;

    const usable = results.filter((r) => r.ok).map((r) => r.prefix);
    const failed = results.filter((r) => !r.ok).map((r) => r.prefix);
    // 探测失败的源不再优先使用，但保留在末尾兜底（可能是探测时抖动）
    this.ranking = [...usable.filter((p) => !isDirect(p)), ...usable.filter(isDirect), ...failed];

    const detail = results.map((r) => `${r.label}=${r.ok ? `${r.latencyMs}ms${r.supportsRange ? '' : '(无Range)'}` : `失败:${r.error}`}`);
    log.info(`加速源探测完成(${this.kind}): ${detail.join(', ')}`);
    if (usable.length === 0) log.warn(`${this.kind} 没有可用加速源，将使用直连 GitHub`);
    return this.applyCooldown(this.ranking);
  }

  /** 把处于冷却期的源排到后面（不删除，仍可兜底） */
  applyCooldown(ranking) {
    const now = this.now();
    const hot = [];
    const cold = [];
    for (const prefix of ranking) {
      const failedAt = this.failures.get(prefix);
      if (failedAt !== undefined && now - failedAt < FAILURE_COOLDOWN_MS) cold.push(prefix);
      else hot.push(prefix);
    }
    return [...hot, ...cold];
  }
}

const pools = { asset: null, api: null };

function buildPool(kind) {
  return new MirrorPool({
    kind,
    mirrors: kind === 'asset' ? config.assetMirrors : config.apiMirrors,
    mode: config.mirrorMode,
  });
}

export function assetPool() {
  if (!pools.asset) pools.asset = buildPool('asset');
  return pools.asset;
}

export function apiPool() {
  if (!pools.api) pools.api = buildPool('api');
  return pools.api;
}

/** 配置变化后重建池子（settings 更新时调用） */
export function resetMirrorPools() {
  pools.asset = null;
  pools.api = null;
}

export function mirrorSnapshot() {
  return {
    mode: config.mirrorMode,
    asset: assetPool().snapshot(),
    api: apiPool().snapshot(),
  };
}

/** 立刻探测（给 /api/mirrors/probe 用） */
export async function probeNow(kind = 'both') {
  const out = {};
  if (kind === 'asset' || kind === 'both') {
    await assetPool().order(null, { force: true });
    out.asset = assetPool().snapshot();
  }
  if (kind === 'api' || kind === 'both') {
    await apiPool().order(apiSampleUrl(), { force: true });
    out.api = apiPool().snapshot();
  }
  return out;
}

export { apiSampleUrl };
