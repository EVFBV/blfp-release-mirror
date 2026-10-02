import crypto from 'node:crypto';
import http from 'node:http';

/**
 * 假的加速源（镜像）服务器，用于验证「自动选最快 / 失败降级 / 跨源断点续传」。
 *
 * 它不关心请求路径（真实的源是把原始 URL 拼在后面，这里直接忽略），
 * 只按配置返回 payload 的一段或全部：
 *   delayMs        响应前延迟（模拟不同源的延迟差异）
 *   dropAfterBytes 发送这么多字节后直接断开连接（模拟中途失败）
 *   status         直接返回该状态码（模拟 403/404 等）
 *   ignoreRange    true 时无视 Range 返回 200 全量（模拟不支持续传的源）
 */
export async function startFakeMirror({ payload, delayMs = 0, dropAfterBytes = null, status = 200, ignoreRange = false } = {}) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const state = { requests: 0, rangedRequests: 0, bytesSent: 0 };

  const server = http.createServer(async (req, res) => {
    state.requests += 1;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(`fake mirror error ${status}`);
      return;
    }

    const range = ignoreRange ? null : /bytes=(\d+)-(\d*)/i.exec(req.headers.range || '');
    let start = 0;
    let end = buf.length - 1;
    if (range) {
      state.rangedRequests += 1;
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), buf.length - 1);
      if (start >= buf.length) {
        res.writeHead(416, { 'content-range': `bytes */${buf.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${buf.length}`,
        'accept-ranges': 'bytes',
      });
    } else {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(buf.length),
        'accept-ranges': 'bytes',
      });
    }

    // 每次请求只发一小块，顺便给 dropAfterBytes 制造"发到一半断掉"的机会
    const chunkSize = 16 * 1024;
    let offset = start;
    while (offset <= end) {
      const slice = buf.subarray(offset, Math.min(offset + chunkSize, end + 1));
      const ok = res.write(slice);
      state.bytesSent += slice.length;
      offset += slice.length;
      if (dropAfterBytes !== null && state.bytesSent >= dropAfterBytes) {
        // 真实场景下，"源断了"之前已经发出去的数据客户端是收得到的，
        // 所以这里要让先写的分片 flush 出去，再优雅关闭（FIN），而不是直接 RST。
        await new Promise((r) => setTimeout(r, 30));
        res.socket?.end();
        return;
      }
      if (!ok) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    prefix: `http://127.0.0.1:${port}/`,
    state,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
