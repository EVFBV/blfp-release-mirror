import { config } from './config.js';
import { log } from './logger.js';
import { sanitizeFileName } from './util.js';

export class GitHubError extends Error {
  constructor(message, { status, rateLimited = false, resetAt = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
  }
}

function apiHeaders(extra = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'blfp-release-mirror/1.0 (+https://github.com/EVFBV/blfp-client)',
    ...extra,
  };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  return headers;
}

/**
 * 拉取 releases 列表（GitHub 默认就会返回 pre-release，draft 需要权限）。
 */
export async function listReleases({ perPage = 30, timeoutMs = 30000 } = {}) {
  const url = `${config.apiBase}/repos/${config.repo}/releases?per_page=${Math.min(100, Math.max(1, perPage))}`;
  const res = await fetch(url, { headers: apiHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    const rateLimited = (res.status === 403 || res.status === 429) && remaining === '0';
    const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;
    const detail = rateLimited
      ? `GitHub API 速率限制已用尽，${resetAt || '稍后'} 后恢复；建议设置 GITHUB_TOKEN`
      : `GitHub API 请求失败: ${res.status} ${res.statusText} ${body.slice(0, 200)}`;
    throw new GitHubError(detail, { status: res.status, rateLimited, resetAt });
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new GitHubError('GitHub API 返回了非预期的数据格式');
  return data.filter((r) => r && (config.includeDraft || !r.draft));
}

/** 解析 tag 成可比较结构，例如 v2.3.21-pre -> { nums:[2,3,21], pre:['pre'] } */
export function parseTag(tag) {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(tag ?? '').trim());
  if (!m) return null;
  return { nums: m[1].split('.').map(Number), pre: m[2] ? m[2].split('.') : null };
}

/** 版本号比较（语义化）：a>b 返回正数。无法解析时返回 0，由调用方回退到发布时间。 */
export function compareTags(a, b) {
  const pa = parseTag(a);
  const pb = parseTag(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x - y;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1; // 正式版 > 同号 pre
  if (!pb.pre) return -1;
  const preLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < preLen; i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xNum) {
      return -1;
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** releases 从新到旧排序：先按版本号，版本号无法比较时按发布时间。 */
export function sortReleases(releases) {
  return [...releases].sort((a, b) => {
    const cmp = compareTags(a.tag, b.tag);
    if (cmp !== 0) return -cmp;
    const ta = Date.parse(a.publishedAt || 0) || 0;
    const tb = Date.parse(b.publishedAt || 0) || 0;
    return tb - ta;
  });
}

/** 把 GitHub release 对象规范化为内部结构，并按配置过滤资产。 */
export function normalizeRelease(raw) {
  const assets = (raw.assets || [])
    .filter((a) => a && a.state === 'uploaded' && a.name)
    .filter((a) => !config.assetRegex || config.assetRegex.test(a.name))
    .filter((a) => !config.assetExcludeRegex || !config.assetExcludeRegex.test(a.name))
    .map((a) => ({
      name: a.name,
      safeName: sanitizeFileName(a.name),
      size: Number(a.size) || 0,
      sha256: String(a.digest || '').replace(/^sha256:/i, '') || null,
      // 有 token 时走 API 端点（私有仓库也能用）；否则直接用公开下载地址
      downloadUrl: config.token ? a.url : a.browser_download_url || a.url,
      htmlUrl: a.browser_download_url || a.html_url || null,
      updatedAt: a.updated_at || a.created_at || null,
    }));
  return {
    tag: raw.tag_name,
    name: raw.name || raw.tag_name,
    prerelease: Boolean(raw.prerelease),
    draft: Boolean(raw.draft),
    publishedAt: raw.published_at || raw.created_at || null,
    htmlUrl: raw.html_url || null,
    body: raw.body || '',
    assets,
  };
}

/**
 * 依据配置选出要保留的 release（从新到旧），并规划本地文件名（避免不同版本同名资产互相覆盖）。
 */
export function selectReleases(releases, keep = config.keepVersions) {
  const normalized = releases
    .map(normalizeRelease)
    .filter((r) => config.includePrerelease || !r.prerelease)
    .filter((r) => r.assets.length > 0);
  const sorted = sortReleases(normalized);
  const selected = sorted.slice(0, keep);

  const nameCount = new Map();
  for (const r of selected) {
    for (const a of r.assets) nameCount.set(a.safeName, (nameCount.get(a.safeName) || 0) + 1);
  }
  for (const r of selected) {
    for (const a of r.assets) {
      a.fileName = nameCount.get(a.safeName) > 1 ? `${sanitizeFileName(r.tag)}__${a.safeName}` : a.safeName;
    }
  }
  log.debug(`release 选择完成: 共 ${releases.length} 个，过滤后 ${sorted.length} 个，保留 ${selected.length} 个`);
  return selected;
}
