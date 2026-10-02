import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'blfp-misconfig-'));

process.env.DATA_DIR = tmpDir;
process.env.SYNC_ON_START = 'false';
process.env.SYNC_INTERVAL_SECONDS = '0';
process.env.LOG_LEVEL = 'error';
// 故意制造错误配置：开了下载保护却没有 API_TOKEN
process.env.PROTECT_DOWNLOADS = 'true';
delete process.env.API_TOKEN;

const { createServer } = await import('../src/server.js');
const sync = await import('../src/sync.js');
const store = await import('../src/store.js');

await store.ensureDirs();
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  sync.stopScheduler();
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('PROTECT_DOWNLOADS=true 但未设置 API_TOKEN 时，明确拒绝而不是静默放行', async () => {
  const res = await fetch(`${base}/download/anything.exe`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'misconfigured');
  assert.match(body.message, /API_TOKEN/);
});
