import crypto from 'node:crypto';
import http from 'node:http';

/**
 * 一个最小的假 GitHub API 服务，用来在本地端到端验证同步逻辑：
 * - GET /repos/<owner>/<repo>/releases  返回 releases 列表（含 pre-release）
 * - GET /dl/<assetName>                 返回资产内容，支持 Range（验证断点续传）
 * - GET /assets/<id>                    同上（模拟带 token 的 API 端点）
 */
export function makeAsset(name, bytes) {
  const buffer = crypto.randomBytes(bytes);
  return {
    name,
    buffer,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

export function releaseSpec(tag, { prerelease = false, publishedAt, assets = [] } = {}) {
  return {
    tag,
    prerelease,
    publishedAt: publishedAt || new Date(Date.now() - Math.random() * 1e6).toISOString(),
    assets,
  };
}

export async function startFakeGitHub({
  repo = 'test/repo',
  releases = [],
  failReleasesWith = null,
  failAssetTimes = 0,
} = {}) {
  const state = { releases, rateLimited: false, requests: [], failAssetTimes };
  let assetId = 1000;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    state.requests.push({ method: req.method, path: url.pathname, range: req.headers.range || null });

    if (url.pathname === `/repos/${repo}/releases`) {
      if (state.rateLimited) {
        res.writeHead(403, {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        });
        return res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
      }
      if (failReleasesWith) {
        res.writeHead(failReleasesWith, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'boom' }));
      }
      const body = state.releases.map((rel) => ({
        id: 1,
        tag_name: rel.tag,
        name: rel.tag,
        draft: false,
        prerelease: rel.prerelease,
        published_at: rel.publishedAt,
        created_at: rel.publishedAt,
        html_url: `https://github.com/${repo}/releases/tag/${rel.tag}`,
        body: 'notes',
        assets: rel.assets.map((a) => {
          assetId += 1;
          return {
            id: assetId,
            name: a.name,
            size: a.size,
            state: 'uploaded',
            digest: `sha256:${a.sha256}`,
            created_at: rel.publishedAt,
            updated_at: rel.publishedAt,
            url: `http://127.0.0.1:${server.address().port}/assets/${assetId}`,
            browser_download_url: `http://127.0.0.1:${server.address().port}/dl/${encodeURIComponent(a.name)}`,
          };
        }),
      }));
      const payload = JSON.stringify(body);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      return res.end(payload);
    }

    const assetMatch = /^\/(dl|assets)\/(.+)$/.exec(url.pathname);
    if (assetMatch) {
      // 注入失败：用于验证下载重试逻辑
      if (state.failAssetTimes > 0) {
        state.failAssetTimes -= 1;
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'injected failure' }));
      }
      const wanted = decodeURIComponent(assetMatch[2]);
      const found = state.releases
        .flatMap((r) => r.assets)
        .find((a) => a.name === wanted || String(a.id) === wanted);
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Not Found' }));
      }
      const total = found.buffer.length;
      let start = 0;
      let end = total - 1;
      let status = 200;
      const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
      if (req.headers.range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range));
        if (m) {
          if (m[1] === '') {
            start = Math.max(0, total - Number(m[2]));
          } else {
            start = Number(m[1]);
            if (m[2] !== '') end = Math.min(end, Number(m[2]));
          }
          status = 206;
          headers['content-range'] = `bytes ${start}-${end}/${total}`;
        }
      }
      const slice = found.buffer.subarray(start, end + 1);
      headers['content-length'] = String(slice.length);
      res.writeHead(status, headers);
      return res.end(req.method === 'HEAD' ? undefined : slice);
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'unknown path' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    setReleases(next) {
      state.releases = next;
    },
    setRateLimited(value) {
      state.rateLimited = value;
    },
    failNextAssetRequests(times = 1) {
      state.failAssetTimes = times;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
