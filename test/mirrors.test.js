import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 这些用例全部用本地假加速源，不碰真实网络
process.env.MIRROR_MODE = 'off';
process.env.MIRROR_PROBE_TIMEOUT_SECONDS = '3';
process.env.MAX_RETRIES = '2';
process.env.STALL_TIMEOUT_SECONDS = '15';
process.env.LOG_LEVEL = 'error';

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'blfp-mirrors-'));
process.env.DATA_DIR = tmpDir;
process.env.GITHUB_REPO = 'test/repo';

const { startFakeMirror } = await import('./helpers/fake-mirror.js');
const { applyMirror, isDirect, mirrorLabel, parseMirrors } = await import('../src/mirror-list.js');
const { MirrorPool, probeMirror } = await import('../src/mirrors.js');
const { downloadAsset } = await import('../src/downloader.js');

const payload = crypto.randomBytes(300 * 1024);
const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');

test.after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('mirror-list：解析与套用加速源', async (t) => {
  await t.test('前缀式会补上结尾斜杠，并去重', () => {
    assert.deepEqual(parseMirrors('https://a.com,https://b.com/，https://a.com'), ['https://a.com/', 'https://b.com/']);
  });

  await t.test('支持数组形式与 {url} 模板', () => {
    assert.deepEqual(parseMirrors(['https://a/{url}', 'https://b']), ['https://a/{url}', 'https://b/']);
    assert.equal(applyMirror('https://a/{url}', 'https://github.com/x/y'), 'https://a/https://github.com/x/y');
    assert.equal(applyMirror('https://a/', 'https://github.com/x/y'), 'https://a/https://github.com/x/y');
  });

  await t.test('direct 关键字与空列表回退', () => {
    assert.deepEqual(parseMirrors('direct'), ['']);
    assert.equal(isDirect(''), true);
    assert.equal(isDirect('direct'), true);
    assert.equal(mirrorLabel(''), '直连 GitHub');
    assert.deepEqual(parseMirrors('', ['https://fallback/']), ['https://fallback/']);
  });

  await t.test('非法地址直接报错', () => {
    assert.throws(() => parseMirrors('ftp://x/'), /必须是 http\(s\)/);
  });
});

test('镜像池：自动挑延迟最低的源，失败源自动降级', async (t) => {
  const fast = await startFakeMirror({ payload, delayMs: 5 });
  const slow = await startFakeMirror({ payload, delayMs: 260 });
  const broken = await startFakeMirror({ payload, status: 403 });
  const direct = await startFakeMirror({ payload });
  const sampleUrl = `${direct.baseUrl}/asset.bin`;

  t.after(async () => {
    await Promise.all([fast.close(), slow.close(), broken.close(), direct.close()]);
  });

  await t.test('order() 把最快的源排在最前面，并把直连作为兜底', async () => {
    const pool = new MirrorPool({
      kind: 'asset',
      mirrors: [slow.prefix, fast.prefix],
      mode: 'auto',
      timeoutMs: 3000,
      cacheMs: 60000,
    });
    const order = await pool.order(sampleUrl, { force: true });
    assert.equal(order[0], fast.prefix, `最快的源应该排第一，实际: ${JSON.stringify(order)}`);
    assert.ok(order.includes(''), '直连必须作为兜底存在');

    const snap = pool.snapshot();
    assert.equal(snap.chosen, fast.prefix);
    const fastResult = snap.results.find((r) => r.mirror === fast.prefix);
    const slowResult = snap.results.find((r) => r.mirror === slow.prefix);
    assert.ok(fastResult.latencyMs < slowResult.latencyMs, '延迟测量应能区分快慢');
    assert.equal(fastResult.supportsRange, true, '应识别出支持 Range 的源');
  });

  await t.test('探测失败的源仍能通过 order() 保留在末尾（可兜底）', async () => {
    const pool = new MirrorPool({ kind: 'asset', mirrors: [broken.prefix], mode: 'auto', timeoutMs: 3000 });
    const order = await pool.order(sampleUrl, { force: true });
    assert.equal(order[order.length - 1], broken.prefix);
    const snap = pool.snapshot();
    assert.equal(snap.results.find((r) => r.mirror === broken.prefix).ok, false);
  });

  await t.test('reportFailure 后该源被排到后面（冷却）', async () => {
    const pool = new MirrorPool({ kind: 'asset', mirrors: [fast.prefix, slow.prefix], mode: 'auto', timeoutMs: 3000 });
    await pool.order(sampleUrl, { force: true });
    assert.equal(pool.snapshot().chosen, fast.prefix);
    pool.reportFailure(fast.prefix);
    assert.equal(pool.snapshot().chosen, slow.prefix, '失败后应改用次优源');
    assert.deepEqual(pool.snapshot().cooling, [fast.prefix]);
  });

  await t.test('mode=fixed 不探测，按配置顺序；mode=off 只用直连', async () => {
    const fixed = new MirrorPool({ kind: 'asset', mirrors: [slow.prefix, fast.prefix], mode: 'fixed' });
    assert.deepEqual(await fixed.order(sampleUrl), [slow.prefix, fast.prefix, '']);
    assert.equal(fixed.snapshot().probedAt, null, 'fixed 模式不应该探测');

    const off = new MirrorPool({ kind: 'asset', mirrors: [fast.prefix], mode: 'off' });
    assert.deepEqual(await off.order(sampleUrl), ['']);
  });

  await t.test('探测结果有缓存，不重复探测', async () => {
    const pool = new MirrorPool({ kind: 'asset', mirrors: [fast.prefix], mode: 'auto', timeoutMs: 3000, cacheMs: 60000 });
    await pool.order(sampleUrl, { force: true });
    const before = fast.state.requests;
    await pool.order(sampleUrl);
    assert.equal(fast.state.requests, before, '缓存有效期内不应再次探测');
  });

  await t.test('probeMirror 对不可达地址返回失败而不是抛异常', async () => {
    const res = await probeMirror('http://127.0.0.1:1/', sampleUrl, { timeoutMs: 1500 });
    assert.equal(res.ok, false);
    assert.ok(res.error, '应带上失败原因');
  });
});

test('下载走镜像：自动选最快的源', async (t) => {
  const fast = await startFakeMirror({ payload, delayMs: 5 });
  const slow = await startFakeMirror({ payload, delayMs: 200 });
  const direct = await startFakeMirror({ payload });
  t.after(async () => {
    await Promise.all([fast.close(), slow.close(), direct.close()]);
  });

  await t.test('选择延迟最低的源下载，且校验通过', async () => {
    const pool = new MirrorPool({ kind: 'asset', mirrors: [slow.prefix, fast.prefix], mode: 'auto', timeoutMs: 3000 });
    const dest = path.join(tmpDir, 'from-fastest.bin');
    const asset = { fileName: 'from-fastest.bin', size: payload.length, sha256: payloadSha, downloadUrl: `${direct.baseUrl}/a.bin`, mirrorPool: pool };

    const result = await downloadAsset(asset, dest);
    assert.equal(result.mirror, fast.prefix, `应该用最快的源，实际: ${result.mirror}`);
    assert.equal(result.verified, true);
    assert.equal(await fsp.readFile(dest).then((b) => b.length), payload.length);
    // 慢源只被探测过（取 1KB），真正的下载量都在快源上
    assert.ok(fast.state.bytesSent >= payload.length, `快源应承载完整下载，实际 ${fast.state.bytesSent} 字节`);
    assert.ok(
      slow.state.bytesSent < payload.length / 2,
      `慢源不应被用来下载，实际传输 ${slow.state.bytesSent} 字节`,
    );
  });
});

test('下载走镜像：某个源中断后自动换源并续传，最终文件完整', async (t) => {
  // 这个源每次请求只发 64KB 就断开，必然中途失败
  const flaky = await startFakeMirror({ payload, dropAfterBytes: 64 * 1024 });
  const good = await startFakeMirror({ payload, delayMs: 30 });
  t.after(async () => {
    await Promise.all([flaky.close(), good.close()]);
  });

  await t.test('降级到下一个源，保留 .part 继续下载，sha256 校验通过', async () => {
    // 用 fixed 模式固定顺序：先 flaky，失败后换 good
    const pool = new MirrorPool({ kind: 'asset', mirrors: [flaky.prefix, good.prefix], mode: 'fixed' });
    const dest = path.join(tmpDir, 'fallback.bin');
    const asset = { fileName: 'fallback.bin', size: payload.length, sha256: payloadSha, downloadUrl: `${good.baseUrl}/a.bin`, mirrorPool: pool };

    const result = await downloadAsset(asset, dest);
    assert.equal(result.mirror, good.prefix, `应降级到可用源，实际: ${result.mirror}`);
    assert.ok(result.mirrorsTried.includes(flaky.prefix), '应记录先尝试过坏源');
    assert.equal(result.verified, true, 'sha256 必须校验通过');
    const bytes = await fsp.readFile(dest);
    assert.equal(bytes.length, payload.length);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), payloadSha);
    assert.ok(result.resumedFrom > 0, `换源时应续传而不是从头下，实际 resumedFrom=${result.resumedFrom}`);
  });

  await t.test('所有源都失败时给出明确错误，并清掉 .part', async () => {
    const dead = await startFakeMirror({ payload, status: 403 });
    t.after(async () => {
      await dead.close();
    });
    const pool = new MirrorPool({ kind: 'asset', mirrors: [dead.prefix], mode: 'fixed' });
    const dest = path.join(tmpDir, 'all-dead.bin');
    const asset = { fileName: 'all-dead.bin', size: payload.length, sha256: payloadSha, downloadUrl: `${dead.baseUrl}/a.bin`, mirrorPool: pool };

    await assert.rejects(() => downloadAsset(asset, dest), /HTTP 403/);
    await assert.rejects(() => fsp.stat(`${dest}.part`), '失败后不应留下 .part');
  });
});

test('API 走镜像：Release 列表从加速源获取，失败自动换源', async (t) => {
  const releases = [
    {
      tag_name: 'v9.9.9',
      name: 'v9.9.9',
      prerelease: false,
      draft: false,
      published_at: '2026-10-01T00:00:00Z',
      assets: [{ name: 'a.exe', size: 10, state: 'uploaded', browser_download_url: 'https://example.invalid/a.exe', digest: null }],
    },
  ];
  const apiPayload = JSON.stringify(releases);

  const bad = await startFakeMirror({ payload: 'nope', status: 403 });
  const good = await startFakeMirror({ payload: apiPayload });
  t.after(async () => {
    await Promise.all([bad.close(), good.close()]);
  });

  const { listReleases } = await import('../src/github.js');
  const { config } = await import('../src/config.js');

  await t.test('403 的源被跳过，改用可用源并返回 release 列表', async () => {
    const pool = new MirrorPool({ kind: 'api', mirrors: [bad.prefix, good.prefix], mode: 'fixed' });
    // apiBase 指向直连假源，加上加速源前缀后由假加速源应答
    const originalBase = config.apiBase;
    config.apiBase = good.baseUrl;
    try {
      const list = await listReleases({ pool });
      assert.equal(list.length, 1);
      assert.equal(list[0].tag_name, 'v9.9.9');
      assert.ok(bad.state.requests > 0, '应先尝试第一个源');
      assert.ok(good.state.requests > 0, '失败后应换到可用源');
      assert.equal(pool.snapshot().cooling.length >= 0, true);
    } finally {
      config.apiBase = originalBase;
    }
  });
});
