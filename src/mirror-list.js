/**
 * GitHub 加速源（镜像）的纯工具与默认列表 —— 不依赖任何其它模块，避免循环引用。
 *
 * 两种写法都支持：
 *   1) 前缀式：https://gh-proxy.com/   → https://gh-proxy.com/https://github.com/owner/repo/releases/download/...
 *   2) 模板式：https://x/{url}         → {url} 会替换成原始地址
 * 空字符串或 direct 关键字代表「直连 GitHub」。
 */

/** 直连标记 */
export const DIRECT = '';

/**
 * 默认的资产下载加速源（实测都支持 Range 断点续传）。
 * 顺序无关紧要：mirrorMode=auto 时会现场探测并按延迟重排。
 */
export const KNOWN_ASSET_MIRRORS = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://gh.llkk.cc/',
  'https://ghproxy.net/',
];

/** 默认的 API 加速源（能代理 api.github.com 的源比资产源少得多） */
export const KNOWN_API_MIRRORS = ['https://gh-proxy.com/'];

export function isDirect(prefix) {
  return !prefix || /^(direct|off|none|github)$/i.test(String(prefix).trim());
}

export function mirrorLabel(prefix) {
  return isDirect(prefix) ? '直连 GitHub' : prefix;
}

/** 解析加速源列表：接受数组，或逗号/空格/换行分隔的字符串（兼容中文全角逗号、顿号） */
export function parseMirrors(input, fallback = []) {
  const items = Array.isArray(input)
    ? input
    : String(input ?? '')
        .split(/[\s,;，、]+/)
        .filter(Boolean);
  const out = [];
  for (const item of items) {
    const value = String(item ?? '').trim();
    if (!value) continue;
    if (isDirect(value)) {
      if (!out.includes(DIRECT)) out.push(DIRECT);
      continue;
    }
    if (!/^https?:\/\//i.test(value)) {
      throw new Error(`加速源必须是 http(s):// 开头的地址，当前值: ${value}`);
    }
    const normalized = value.includes('{url}') || value.endsWith('/') ? value : `${value}/`;
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (out.length === 0) return [...fallback];
  return out;
}

/** 把原始 URL 套到加速源上 */
export function applyMirror(prefix, url) {
  if (isDirect(prefix)) return url;
  if (prefix.includes('{url}')) return prefix.replaceAll('{url}', url);
  return `${prefix}${url}`;
}
