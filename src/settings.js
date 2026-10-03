import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, normalizeRepo } from './config.js';
import { log } from './logger.js';
import { parseMirrors } from './mirror-list.js';
import { resetMirrorPools } from './mirrors.js';
import { parseRegex } from './util.js';

export const SETTINGS_PATH = path.join(config.dataDir, 'settings.json');

export class SettingsError extends Error {
  constructor(message, { field = null } = {}) {
    super(message);
    this.name = 'SettingsError';
    this.field = field;
    this.statusCode = 400;
  }
}

/**
 * 可以在运行时改动的配置项（其余如 DATA_DIR / PORT 需要重启或改环境变量）。
 * 令牌不在这里：GITHUB_TOKEN 只允许通过环境变量提供，避免把密钥写进明文文件。
 */
const FIELDS = {
  repo: { kind: 'repo' },
  apiBase: { kind: 'url' },
  includePrerelease: { kind: 'bool' },
  includeDraft: { kind: 'bool' },
  keepVersions: { kind: 'int', min: 1, max: 100 },
  /** 最新正式版是否始终额外保留（避免被版本号更高的 pre 挤掉后清理） */
  keepStable: { kind: 'bool' },
  assetRegex: { kind: 'regex', nullable: true },
  assetExcludeRegex: { kind: 'regex', nullable: true },
  syncIntervalSeconds: { kind: 'int', min: 0, max: 86400 },
  downloadConcurrency: { kind: 'int', min: 1, max: 8 },
  maxRetries: { kind: 'int', min: 1, max: 10 },
  stallTimeoutSeconds: { kind: 'int', min: 10, max: 3600 },
  publicBaseUrl: { kind: 'url', nullable: true },
  corsOrigin: { kind: 'string' },
  /** 加速源：auto=自动探测选最快 / fixed=按顺序 / off=仅直连 */
  mirrorMode: { kind: 'enum', values: ['auto', 'fixed', 'off'] },
  /** 资产下载加速源列表（逗号分隔，direct 表示直连） */
  assetMirrors: { kind: 'mirrors' },
  /** API 加速源列表 */
  apiMirrors: { kind: 'mirrors' },
};

export const EDITABLE_FIELDS = Object.keys(FIELDS);

/** 进程启动时由环境变量决定的值，作为 settings.json 缺省项的回退 */
const envDefaults = Object.freeze({
  repo: config.repo,
  apiBase: config.apiBase,
  includePrerelease: config.includePrerelease,
  includeDraft: config.includeDraft,
  keepVersions: config.keepVersions,
  keepStable: config.keepStable,
  assetRegex: null,
  assetExcludeRegex: null,
  syncIntervalSeconds: config.syncIntervalSeconds,
  downloadConcurrency: config.downloadConcurrency,
  maxRetries: config.maxRetries,
  stallTimeoutSeconds: config.stallTimeoutSeconds,
  publicBaseUrl: config.publicBaseUrl || null,
  corsOrigin: config.corsOrigin,
  mirrorMode: config.mirrorMode,
  assetMirrors: config.assetMirrors,
  apiMirrors: config.apiMirrors,
});

/** settings.json 里存的内容（原样保存字符串/数字/布尔） */
let fileSettings = {};
/** 每个字段当前的"原始字符串"形式，用于展示与再次校验 */
let raw = {};

function buildRegex(source, field) {
  if (source === null || source === undefined || String(source).trim() === '') return null;
  try {
    return parseRegex(source, field);
  } catch (err) {
    throw new SettingsError(`${field} 不是合法的正则表达式: ${source}（${err.message}）`, { field });
  }
}

function coerce(field, value, spec) {
  if (value === null || value === undefined || (spec.kind !== 'bool' && String(value).trim() === '')) {
    if (spec.nullable) return { value: null, raw: null };
    if (spec.kind === 'regex') return { value: null, raw: null };
    throw new SettingsError(`${field} 不能为空`, { field });
  }
  switch (spec.kind) {
    case 'bool': {
      if (typeof value === 'boolean') return { value, raw: value };
      const text = String(value).trim();
      if (!/^(1|0|true|false|yes|no|on|off)$/i.test(text)) {
        throw new SettingsError(`${field} 必须是布尔值（true/false）`, { field });
      }
      const bool = /^(1|true|yes|on)$/i.test(text);
      return { value: bool, raw: bool };
    }
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new SettingsError(`${field} 必须是整数`, { field });
      }
      if (n < spec.min || n > spec.max) {
        throw new SettingsError(`${field} 必须在 ${spec.min} ~ ${spec.max} 之间，当前 ${n}`, { field });
      }
      return { value: n, raw: n };
    }
    case 'repo': {
      let normalized;
      try {
        normalized = normalizeRepo(value, null);
      } catch {
        throw new SettingsError(`${field} 必须是 "owner/repo" 或 https://github.com/owner/repo 形式`, { field });
      }
      return { value: normalized, raw: normalized };
    }
    case 'url': {
      const text = String(value).trim();
      if (!/^https?:\/\/[^\s]+$/i.test(text)) {
        throw new SettingsError(`${field} 必须是 http(s):// 开头的地址`, { field });
      }
      return { value: text.replace(/\/+$/, ''), raw: text.replace(/\/+$/, '') };
    }
    case 'regex': {
      const text = String(value).trim();
      buildRegex(text, field); // 校验
      return { value: text, raw: text };
    }
    case 'enum': {
      const text = String(value).trim().toLowerCase();
      if (!spec.values.includes(text)) {
        throw new SettingsError(`${field} 只能是 ${spec.values.join(' / ')}，当前值: ${value}`, { field });
      }
      return { value: text, raw: text };
    }
    case 'mirrors': {
      // 既接受数组，也接受逗号分隔字符串；返回统一为数组
      const list = parseMirrors(Array.isArray(value) ? value : String(value).split(/[,\n]/), []);
      if (list.length === 0) throw new SettingsError(`${field} 不能为空（可填 direct 表示直连）`, { field });
      return { value: list, raw: list };
    }
    default: {
      const text = String(value).trim();
      return { value: text, raw: text };
    }
  }
}

/** 把一份完整配置应用到内存中的 config（声明式，无副作用残留） */
function applyToConfig(settings) {
  config.repo = settings.repo;
  config.apiBase = settings.apiBase;
  config.includePrerelease = settings.includePrerelease;
  config.includeDraft = settings.includeDraft;
  config.keepVersions = settings.keepVersions;
  config.keepStable = settings.keepStable;
  config.assetRegex = buildRegex(settings.assetRegex, 'assetRegex');
  config.assetExcludeRegex = buildRegex(settings.assetExcludeRegex, 'assetExcludeRegex');
  config.syncIntervalSeconds = settings.syncIntervalSeconds;
  config.downloadConcurrency = settings.downloadConcurrency;
  config.maxRetries = settings.maxRetries;
  config.stallTimeoutSeconds = settings.stallTimeoutSeconds;
  config.publicBaseUrl = settings.publicBaseUrl || '';
  config.corsOrigin = settings.corsOrigin;
  config.mirrorMode = settings.mirrorMode;
  config.assetMirrors = [...settings.assetMirrors];
  config.apiMirrors = [...settings.apiMirrors];
  raw = { ...settings };
  // 加速源变了要重建池子，让新配置立即生效
  resetMirrorPools();
}

/** env 默认值 + settings.json 覆盖 = 生效配置 */
function merge() {
  const merged = { ...envDefaults };
  for (const key of Object.keys(fileSettings)) {
    if (key in FIELDS) merged[key] = fileSettings[key];
  }
  return merged;
}

function validateAll(candidate) {
  const result = {};
  for (const [field, spec] of Object.entries(FIELDS)) {
    result[field] = coerce(field, candidate[field], spec).value;
  }
  return result;
}

async function writeFileSettings(next) {
  const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
  if (Object.keys(next).length === 0) {
    await fsp.rm(SETTINGS_PATH, { force: true });
    return;
  }
  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, SETTINGS_PATH);
}

/** 启动时调用：读取 settings.json 并覆盖环境变量默认值 */
export async function loadSettings() {
  try {
    const text = await fsp.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(text);
    fileSettings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn(`settings.json 读取失败，将忽略并使用环境变量配置: ${err.message}`);
    }
    fileSettings = {};
  }

  const unknown = Object.keys(fileSettings).filter((k) => !(k in FIELDS));
  if (unknown.length > 0) log.warn(`settings.json 中有无法识别的字段，已忽略: ${unknown.join(', ')}`);

  let effective;
  try {
    effective = validateAll(merge());
  } catch (err) {
    log.error(`settings.json 内容非法，已回退到环境变量配置: ${err.message}`);
    fileSettings = {};
    effective = validateAll(merge());
  }
  applyToConfig(effective);
  if (Object.keys(fileSettings).length > 0) {
    log.info(`已从 ${SETTINGS_PATH} 加载运行时配置`, {
      overridden: Object.keys(fileSettings).filter((k) => k in FIELDS),
      repo: config.repo,
    });
  }
  return currentSettings();
}

/** 更新配置（部分字段即可），写入 settings.json 并立即生效 */
export async function updateSettings(patch, { reset = false } = {}) {
  if (patch !== null && (typeof patch !== 'object' || Array.isArray(patch))) {
    throw new SettingsError('请求体必须是 JSON 对象');
  }
  if ('githubToken' in (patch || {})) {
    throw new SettingsError('出于安全考虑，GITHUB_TOKEN 只能通过环境变量设置，不支持运行时写入');
  }

  const nextFile = reset ? {} : { ...fileSettings };
  const unknownFields = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in FIELDS)) {
      unknownFields.push(key);
      continue;
    }
    const { raw: rawValue } = coerce(key, value, FIELDS[key]);
    nextFile[key] = rawValue;
    if (rawValue === null) delete nextFile[key];
  }
  if (unknownFields.length > 0) {
    throw new SettingsError(`不支持的配置项: ${unknownFields.join(', ')}（可配置: ${EDITABLE_FIELDS.join(', ')}）`);
  }

  const effective = validateAll({ ...envDefaults, ...nextFile });
  await writeFileSettings(nextFile);
  fileSettings = nextFile;
  applyToConfig(effective);
  log.info('运行时配置已更新', { repo: config.repo, overridden: Object.keys(nextFile).filter((k) => k in FIELDS) });
  return currentSettings();
}

export function currentSettings() {
  return {
    ...raw,
    assetRegex: raw.assetRegex ?? null,
    assetExcludeRegex: raw.assetExcludeRegex ?? null,
    settingsFile: SETTINGS_PATH,
    settingsFileActive: Object.keys(fileSettings).length > 0,
    overriddenFields: Object.keys(fileSettings).filter((k) => k in FIELDS),
    envDefaults,
    editableFields: EDITABLE_FIELDS,
    githubTokenConfigured: Boolean(config.token),
    note: 'GITHUB_TOKEN / DATA_DIR / PORT 等只支持环境变量；其余字段可用 POST /api/settings 在运行时修改并持久化到 settings.json',
  };
}

export function settingsFileContent() {
  return { ...fileSettings };
}
