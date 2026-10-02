import path from 'node:path';
import { parseBool, parseNumber, parseRegex } from './util.js';

const env = process.env;

function normalizeRepo(value, fallback) {
  const raw = String(value ?? '').trim() || fallback;
  const cleaned = raw
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(cleaned)) {
    throw new Error(`GITHUB_REPO 必须是 "owner/repo" 形式，当前值: ${raw}`);
  }
  return cleaned;
}

export { normalizeRepo };

export const config = {
  /** GitHub 仓库 owner/repo */
  repo: normalizeRepo(env.GITHUB_REPO, 'EVFBV/blfp-client'),
  /** GitHub API 基地址，便于测试 / GitHub Enterprise */
  apiBase: (env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, ''),
  /** 可选 token：提升速率限制，私有仓库必需 */
  token: (env.GITHUB_TOKEN || '').trim(),

  /** 是否包含 pre-release（用户要求包含） */
  includePrerelease: parseBool(env.INCLUDE_PRERELEASE, true),
  /** 是否包含 draft */
  includeDraft: parseBool(env.INCLUDE_DRAFT, false),
  /** 本地保留几个最新版本，超出的自动删除 */
  keepVersions: parseNumber(env.KEEP_VERSIONS, 1, { min: 1, max: 100 }),
  /** 只下载名字匹配该正则的资产（留空=全部） */
  assetRegex: parseRegex(env.ASSET_REGEX, 'ASSET_REGEX'),
  /** 排除名字匹配该正则的资产 */
  assetExcludeRegex: parseRegex(env.ASSET_EXCLUDE_REGEX, 'ASSET_EXCLUDE_REGEX'),

  /** 数据目录（挂载卷） */
  dataDir: path.resolve(env.DATA_DIR || '/data'),
  /** 监听端口 */
  port: parseNumber(env.PORT, 8080, { min: 1, max: 65535 }),
  /** 监听地址 */
  host: env.BIND || '0.0.0.0',
  /** 对外公开地址（配置后 API 返回的下载链接会带上它） */
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  /** 定时检查新版本的间隔（秒），0 = 关闭定时 */
  syncIntervalSeconds: parseNumber(env.SYNC_INTERVAL_SECONDS, 600, { min: 0, max: 30 * 24 * 3600 }),
  /** 容器启动后是否立刻同步一次 */
  syncOnStart: parseBool(env.SYNC_ON_START, true),
  /** 同时下载的资产数 */
  downloadConcurrency: parseNumber(env.DOWNLOAD_CONCURRENCY, 2, { min: 1, max: 8 }),
  /** 单个下载任务的最大重试次数 */
  maxRetries: parseNumber(env.MAX_RETRIES, 3, { min: 1, max: 10 }),
  /** 多久没收到数据就视为卡死（秒） */
  stallTimeoutSeconds: parseNumber(env.STALL_TIMEOUT_SECONDS, 60, { min: 10, max: 3600 }),

  /** 设置后：写接口 /api/sync 需要 token */
  apiToken: (env.API_TOKEN || '').trim(),
  /** 设置后：下载接口也需要 token */
  protectDownloads: parseBool(env.PROTECT_DOWNLOADS, false),

  /** 简易 CORS 头，默认放开 GET 接口 */
  corsOrigin: env.CORS_ORIGIN === undefined ? '*' : env.CORS_ORIGIN,
  logLevel: (env.LOG_LEVEL || 'info').trim().toLowerCase(),
};

export const FILES_DIR = path.join(config.dataDir, 'files');
export const MANIFEST_PATH = path.join(config.dataDir, 'manifest.json');

/** 供 /api/status 展示，隐藏敏感值 */
export function publicConfig() {
  return {
    repo: config.repo,
    includePrerelease: config.includePrerelease,
    includeDraft: config.includeDraft,
    keepVersions: config.keepVersions,
    assetFilter: config.assetRegex ? config.assetRegex.source : null,
    assetExclude: config.assetExcludeRegex ? config.assetExcludeRegex.source : null,
    dataDir: config.dataDir,
    syncIntervalSeconds: config.syncIntervalSeconds,
    syncOnStart: config.syncOnStart,
    downloadConcurrency: config.downloadConcurrency,
    protectDownloads: config.protectDownloads,
    githubTokenConfigured: Boolean(config.token),
    apiTokenConfigured: Boolean(config.apiToken),
  };
}
