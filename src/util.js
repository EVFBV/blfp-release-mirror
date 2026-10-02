import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APP_NAME = 'blfp-release-mirror';
export const APP_VERSION = '1.0.0';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只保留纯文件名，去掉目录、控制字符和 Windows 非法字符，避免路径穿越。 */
export function sanitizeFileName(name) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned.slice(0, 180) || 'file';
}

/** 按给定并发数执行任务，单个任务抛错不影响其它任务。 */
export async function runPool(items, limit, worker) {
  const queue = [...items];
  const results = [];
  const size = Math.max(1, Math.min(limit, queue.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        results.push(await worker(item));
      } catch (err) {
        results.push({ error: err, item });
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 把文件内容喂给一个已存在的 hash 对象（不 finalize），用于断点续传前续算哈希。
 */
export function updateHashFromFile(file, hash) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash));
  });
}

/**
 * 计算文件 sha256。
 */
export function hashFile(file, hash = crypto.createHash('sha256')) {
  return updateHashFromFile(file, hash).then((h) => h.digest('hex'));
}

export async function fileSha256(file) {
  return hashFile(file, crypto.createHash('sha256'));
}

export function humanBytes(n) {
  const num = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = num;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 环境变量 -> 布尔 */
export function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

/** 环境变量 -> 数字（带默认值与上下限）；未设置/空白一律用默认值，而不是被下限夹住 */
export function parseNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 环境变量 -> 正则，非法时抛错并指出是哪个变量 */
export function parseRegex(value, label) {
  const src = String(value ?? '').trim();
  if (!src) return null;
  try {
    return new RegExp(src, 'i');
  } catch (err) {
    throw new Error(`环境变量 ${label} 不是合法的正则表达式: ${src} (${err.message})`);
  }
}
