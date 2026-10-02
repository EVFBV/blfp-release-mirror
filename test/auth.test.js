import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { startFakeGitHub, makeAsset, releaseSpec } = await import('./helpers/fake-github.js');

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'blfp-auth-'));
const asset = makeAsset('BLFP-Setup-v9.9.9.exe', 24 * 1024);
const TOKEN = 'super-secret-token';

const fake = await startFakeGitHub({
  repo: 'test/repo',
  releases: [releaseSpec('v9.9.9', { assets: [asset], publishedAt: '2026-10-01T00:00:00Z' })],
});

process.env.GITHUB_REPO = 'test/repo';
process.env.GITHUB_API_BASE = fake.baseUrl;
process.env.DATA_DIR = tmpDir;
process.env.SYNC_ON_START = 'false';
process.env.SYNC_INTERVAL_SECONDS = '0';
process.env.LOG_LEVEL = 'error';
process.env.API_TOKEN = TOKEN;
process.env.PROTECT_DOWNLOADS = 'true';

const { createServer } = await import('../src/server.js');
const sync = await import('../src/sync.js');
const store = await import('../src/store.js');

await store.ensureDirs();
await sync.syncNow('auth-setup');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  sync.stopScheduler();
  await new Promise((resolve) => server.close(resolve));
  await fake.close();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('API_TOKEN + PROTECT_DOWNLOADS：鉴权行为', async (t) => {
  await t.test('未带 token 时写接口与下载接口返回 401', async () => {
    const syncRes = await fetch(`${base}/api/sync`, { method: 'POST' });
    assert.equal(syncRes.status, 401);
    assert.equal((await syncRes.json()).error, 'unauthorized');

    const dl = await fetch(`${base}/download/${encodeURIComponent(asset.name)}`);
    assert.equal(dl.status, 401);

    const files = await fetch(`${base}/api/files`);
    assert.equal(files.status, 401);
  });

  await t.test('健康检查与状态接口保持开放，方便监控', async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
  });

  await t.test('Authorization: Bearer 正确 token 放行', async () => {
    const res = await fetch(`${base}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 202);

    const dl = await fetch(`${base}/api/files`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(dl.status, 200);
    const body = await dl.json();
    assert.equal(body.count, 1);
    assert.equal(body.files[0].name, asset.name);
  });

  await t.test('X-API-Token 头与 ?token= 查询参数同样有效', async () => {
    const viaHeader = await fetch(`${base}/api/files`, { headers: { 'x-api-token': TOKEN } });
    assert.equal(viaHeader.status, 200);

    const viaQuery = await fetch(`${base}/latest?token=${TOKEN}`, { redirect: 'manual' });
    assert.equal(viaQuery.status, 302);
  });

  await t.test('错误 token 返回 401', async () => {
    const res = await fetch(`${base}/api/files`, { headers: { authorization: 'Bearer wrong-token' } });
    assert.equal(res.status, 401);
    const sameLength = await fetch(`${base}/api/files`, { headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` } });
    assert.equal(sameLength.status, 401);
  });

  await t.test('带 token 的下载能拿到完整文件', async () => {
    const res = await fetch(`${base}/download/${encodeURIComponent(asset.name)}?token=${TOKEN}`);
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.equals(asset.buffer));
  });
});
