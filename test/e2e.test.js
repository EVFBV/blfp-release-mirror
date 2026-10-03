import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { startFakeGitHub, makeAsset, releaseSpec } = await import('./helpers/fake-github.js');

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'blfp-e2e-'));
const oldAsset = makeAsset('BLFP-Setup-v2.0.0-pre.exe', 200 * 1024);
const newAsset = makeAsset('BLFP-Setup-v2.1.0-pre.exe', 260 * 1024);
const stableAsset = makeAsset('BLFP-Setup-v1.9.0.exe', 120 * 1024);
const nextAsset = makeAsset('BLFP-Setup-v3.0.0-pre.exe', 210 * 1024);

const fake = await startFakeGitHub({
  repo: 'test/repo',
  releases: [
    releaseSpec('v1.9.0', { assets: [stableAsset], publishedAt: '2026-09-01T00:00:00Z' }),
    releaseSpec('v2.0.0-pre', { prerelease: true, assets: [oldAsset], publishedAt: '2026-09-20T00:00:00Z' }),
  ],
});

// 测试一律直连，不探测真实加速源（镜像逻辑由 mirrors.test.js 用本地假源专门验证）
process.env.MIRROR_MODE = 'off';
process.env.GITHUB_REPO = 'test/repo';
process.env.GITHUB_API_BASE = fake.baseUrl;
process.env.DATA_DIR = tmpDir;
process.env.SYNC_ON_START = 'false';
process.env.SYNC_INTERVAL_SECONDS = '0';
process.env.KEEP_VERSIONS = '1';
process.env.INCLUDE_PRERELEASE = 'true';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';

const { config, FILES_DIR } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const sync = await import('../src/sync.js');
const store = await import('../src/store.js');

await store.ensureDirs();
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const getJson = async (p) => {
  const res = await fetch(`${base}${p}`);
  const body = await res.json().catch(() => null);
  return { res, body };
};

const localNames = async () => (await store.listLocalFiles()).map((f) => f.name).sort();

test.after(async () => {
  sync.stopScheduler();
  await new Promise((resolve) => server.close(resolve));
  await fake.close();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('端到端：同步 / 更新 / 清理旧版本 / 下载 API', async (t) => {
  await t.test('启动同步：下载最新的 pre-release 并校验 sha256', async () => {
    // 首次同步前磁盘为空；本地放一个"上一个版本"的文件，用于验证后续清理
    await fsp.writeFile(path.join(FILES_DIR, stableAsset.name), stableAsset.buffer);

    const result = await sync.syncNow('test');
    assert.equal(result.newestTag, 'v2.0.0-pre', '应选中比 v1.9.0 更新的 pre-release');
    assert.equal(result.downloaded, 1);
    // KEEP_STABLE 默认开启：最新正式版 v1.9.0 不会被版本号更高的 pre 挤掉
    assert.equal(result.pruned, 0, '最新正式版不应被当成旧版本清理');
    assert.equal(result.skipped, 1, 'v1.9.0 已在本地且校验一致，跳过下载');

    assert.deepEqual(await localNames(), [stableAsset.name, oldAsset.name].sort());
    const onDisk = await fsp.readFile(path.join(FILES_DIR, oldAsset.name));
    assert.ok(onDisk.equals(oldAsset.buffer), '本地文件内容应与远端一致');

    const { body } = await getJson('/api/latest');
    assert.equal(body.tag, 'v2.0.0-pre');
    assert.equal(body.prerelease, true);
    assert.equal(body.files[0].sha256, oldAsset.sha256);
    assert.equal(body.files[0].downloaded, true);
    assert.match(body.primaryDownloadUrl, /\/download\/BLFP-Setup-v2\.0\.0-pre\.exe$/);
  });

  await t.test('新版本发布后：只保留最新版，旧文件被删除', async () => {
    fake.setReleases([
      releaseSpec('v2.1.0-pre', { prerelease: true, assets: [newAsset], publishedAt: '2026-10-01T00:00:00Z' }),
      releaseSpec('v2.0.0-pre', { prerelease: true, assets: [oldAsset], publishedAt: '2026-09-20T00:00:00Z' }),
    ]);

    const result = await sync.syncNow('test-upgrade');
    assert.equal(result.newestTag, 'v2.1.0-pre');
    assert.deepEqual(await localNames(), [newAsset.name], '旧版本文件应被删除，只留最新');
    assert.equal(result.pruned, 2, '旧 pre 与已不在远端的正式版都应被清理');

    const { body } = await getJson('/api/latest');
    assert.equal(body.tag, 'v2.1.0-pre');
    const files = await getJson('/api/files');
    assert.equal(files.body.count, 1);
    assert.equal(files.body.files[0].sha256, newAsset.sha256);
    assert.equal(files.body.files[0].tag, 'v2.1.0-pre');
  });

  await t.test('再次同步：已是最新则跳过下载（不重复占带宽）', async () => {
    const before = await fsp.stat(path.join(FILES_DIR, newAsset.name));
    const result = await sync.syncNow('test-noop');
    const after = await fsp.stat(path.join(FILES_DIR, newAsset.name));
    assert.equal(result.downloaded, 0);
    assert.equal(result.skipped, 1);
    assert.equal(after.mtimeMs, before.mtimeMs, '文件不应被重新写入');

    const { body } = await getJson('/api/releases');
    assert.equal(body.releases[0].assets[0].status, 'skipped');
  });

  await t.test('本地文件被删除后能自愈：下次同步自动重新下载', async () => {
    await fsp.rm(path.join(FILES_DIR, newAsset.name));
    const result = await sync.syncNow('test-heal');
    assert.equal(result.downloaded, 1);
    assert.deepEqual(await localNames(), [newAsset.name]);
    const buf = await fsp.readFile(path.join(FILES_DIR, newAsset.name));
    assert.ok(buf.equals(newAsset.buffer));
  });

  await t.test('HTTP：浏览器/curl 直接下载完整文件', async () => {
    const res = await fetch(`${base}/download/${encodeURIComponent(newAsset.name)}`);
    assert.equal(res.status, 200);
    assert.equal(Number(res.headers.get('content-length')), newAsset.size);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.match(res.headers.get('content-disposition'), /attachment/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, newAsset.size);
    assert.ok(buf.equals(newAsset.buffer));

    const inline = await fetch(`${base}/files/${encodeURIComponent(newAsset.name)}`);
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-disposition'), null, '/files/ 直接访问不应强制下载');
  });

  await t.test('HTTP：Range 断点续传与 416', async () => {
    const mid = await fetch(`${base}/download/${encodeURIComponent(newAsset.name)}`, {
      headers: { range: 'bytes=100-199' },
    });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers.get('content-range'), `bytes 100-199/${newAsset.size}`);
    const chunk = Buffer.from(await mid.arrayBuffer());
    assert.equal(chunk.length, 100);
    assert.ok(chunk.equals(newAsset.buffer.subarray(100, 200)));

    const suffix = await fetch(`${base}/download/${encodeURIComponent(newAsset.name)}`, { headers: { range: 'bytes=-50' } });
    assert.equal(suffix.status, 206);
    const tail = Buffer.from(await suffix.arrayBuffer());
    assert.ok(tail.equals(newAsset.buffer.subarray(newAsset.size - 50)));

    const bad = await fetch(`${base}/download/${encodeURIComponent(newAsset.name)}`, {
      headers: { range: `bytes=${newAsset.size + 10}-` },
    });
    assert.equal(bad.status, 416);
  });

  await t.test('HTTP：HEAD 与 /latest 永久指向最新版本', async () => {
    const head = await fetch(`${base}/download/${encodeURIComponent(newAsset.name)}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), newAsset.size);

    const latest = await fetch(`${base}/latest`, { redirect: 'manual' });
    assert.equal(latest.status, 302);
    assert.match(latest.headers.get('location'), /\/download\/BLFP-Setup-v2\.1\.0-pre\.exe$/);

    const latestApi = await getJson('/api/latest');
    assert.equal(latestApi.body.tag, 'v2.1.0-pre');
  });

  await t.test('HTTP：路径穿越与未知路径不会泄露文件', async () => {
    const traversals = [
      `${base}/files/..%2F..%2Fmanifest.json`,
      `${base}/download/..%2F..%2F..%2Fetc%2Fpasswd`,
      `${base}/releases/v2.1.0-pre/..%2F..%2Fmanifest.json`,
    ];
    for (const url of traversals) {
      const res = await fetch(url);
      assert.ok([400, 404].includes(res.status), `${url} 应返回 400/404，实际 ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes('"releases"'), '不应返回 manifest 内容');
    }

    const unknown = await getJson('/definitely-not-here');
    assert.equal(unknown.res.status, 404);
    assert.equal(unknown.body.error, 'not_found');

    const missing = await getJson('/api/latest/not-exists.exe');
    assert.equal(missing.res.status, 404);
  });

  await t.test('HTTP API：状态、健康检查、立即同步（异步与等待模式）', async () => {
    const health = await getJson('/health');
    assert.equal(health.res.status, 200);
    assert.equal(health.body.status, 'ok');

    const status = await getJson('/api/status');
    assert.equal(status.res.status, 200);
    assert.equal(status.body.repo, 'test/repo');
    assert.equal(status.body.storage.fileCount, 1);
    assert.equal(status.body.sync.config.keepVersions, 1);
    assert.ok(status.body.manifest.lastSyncAt);
    assert.equal(status.body.sync.lastError, null);

    const asyncSync = await fetch(`${base}/api/sync`, { method: 'POST' });
    assert.equal(asyncSync.status, 202);
    const asyncBody = await asyncSync.json();
    assert.equal(asyncBody.ok, true);

    const waited = await fetch(`${base}/api/sync?wait=1`, { method: 'POST' });
    assert.equal(waited.status, 200);
    const waitedBody = await waited.json();
    assert.equal(waitedBody.ok, true);
    assert.equal(waitedBody.result.newestTag, 'v2.1.0-pre');

    // 并发触发只应串行执行
    const p1 = sync.syncNow('concurrent-1');
    const p2 = sync.syncNow('concurrent-2');
    assert.equal(p1, p2, '并发调用应复用同一个同步任务');
    await Promise.all([p1, p2]);
  });

  await t.test('/api/check：能发现远端新版本', async () => {
    const before = await getJson('/api/check');
    assert.equal(before.res.status, 200);
    assert.equal(before.body.updateAvailable, false);
    assert.equal(before.body.remoteLatest.tag, 'v2.1.0-pre');

    fake.setReleases([
      releaseSpec('v3.0.0-pre', { prerelease: true, assets: [nextAsset], publishedAt: '2026-10-05T00:00:00Z' }),
      releaseSpec('v2.1.0-pre', { prerelease: true, assets: [newAsset], publishedAt: '2026-10-01T00:00:00Z' }),
    ]);
    const after = await getJson('/api/check');
    assert.equal(after.body.updateAvailable, true);
    assert.equal(after.body.remoteLatest.tag, 'v3.0.0-pre');

    // 真正同步一次，确认新版落地且旧版被清掉
    const result = await sync.syncNow('test-final');
    assert.equal(result.newestTag, 'v3.0.0-pre');
    assert.deepEqual(await localNames(), [nextAsset.name]);
    const finalLatest = await getJson('/api/latest');
    assert.equal(finalLatest.body.tag, 'v3.0.0-pre');
    assert.equal(finalLatest.body.files[0].sha256, nextAsset.sha256);
  });

  await t.test('KEEP_STABLE：正式版始终保留，/stable 直达最新正式版，关掉后恢复"只留 N 个版本"', async () => {
    fake.setReleases([
      releaseSpec('v4.1.0-pre', { prerelease: true, assets: [oldAsset], publishedAt: '2026-10-10T00:00:00Z' }),
      releaseSpec('v4.0.0', { assets: [stableAsset], publishedAt: '2026-10-02T00:00:00Z' }),
    ]);

    const on = await sync.syncNow('keep-stable-on');
    assert.equal(on.newestTag, 'v4.1.0-pre', '最新版本仍是最新的 pre');
    assert.deepEqual(
      await localNames(),
      [stableAsset.name, oldAsset.name].sort(),
      'KEEP_VERSIONS=1 时也要额外保留最新正式版 v4.0.0',
    );

    // /latest 指向最新（pre），/stable 指向最新正式版
    const latestRes = await fetch(`${base}/latest`, { redirect: 'manual' });
    assert.equal(latestRes.status, 302);
    assert.equal(latestRes.headers.get('location'), `/download/${encodeURIComponent(oldAsset.name)}`);

    const stableRes = await fetch(`${base}/stable`, { redirect: 'manual' });
    assert.equal(stableRes.status, 302);
    assert.equal(stableRes.headers.get('location'), `/download/${encodeURIComponent(stableAsset.name)}`);

    // 跟随重定向能拿到完整文件
    const followed = await fetch(`${base}/stable`);
    assert.equal(followed.status, 200);
    const bytes = Buffer.from(await followed.arrayBuffer());
    assert.ok(bytes.equals(stableAsset.buffer), '/stable 应下载到完整且一致的正式版文件');

    // 单个文件的 /stable/<name> 也应可用
    const named = await fetch(`${base}/stable/${encodeURIComponent(stableAsset.name)}`, { redirect: 'manual' });
    assert.equal(named.status, 200);

    // 关掉 KEEP_STABLE：回到严格"只保留最新 N 个版本"
    const saved = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keepStable: false }),
    });
    assert.equal(saved.status, 200);
    await sync.syncNow('keep-stable-off');
    assert.deepEqual(await localNames(), [oldAsset.name], '关掉后正式版会被当成旧版本清理');

    const gone = await fetch(`${base}/stable`, { redirect: 'manual' });
    assert.equal(gone.status, 404, '本地没有正式版时 /stable 应返回 404 而不是报错');
    const goneBody = await gone.json();
    assert.match(goneBody.message, /KEEP_STABLE/);

    // 还原，避免影响后面的用例
    await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keepStable: true }),
    });
  });

  await t.test('INCLUDE_PRERELEASE=false 时不再跟随 pre-release', async () => {
    const saved = config.includePrerelease;
    config.includePrerelease = false;
    try {
      fake.setReleases([
        releaseSpec('v3.0.0-pre', { prerelease: true, assets: [nextAsset], publishedAt: '2026-10-05T00:00:00Z' }),
        releaseSpec('v2.9.0', { assets: [stableAsset], publishedAt: '2026-09-01T00:00:00Z' }),
      ]);
      const result = await sync.syncNow('test-stable-only');
      assert.equal(result.newestTag, 'v2.9.0');
      assert.deepEqual(await localNames(), [stableAsset.name], 'pre 版文件应被清理，只留正式版');
    } finally {
      config.includePrerelease = saved;
    }
  });
});
