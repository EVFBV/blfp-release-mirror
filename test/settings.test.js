import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { startFakeGitHub, makeAsset, releaseSpec } = await import('./helpers/fake-github.js');

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'blfp-settings-'));

const repoAAsset = makeAsset('app-a-1.0.0.exe', 40 * 1024);
const repoBAsset = makeAsset('app-b-2.0.0-pre.exe', 50 * 1024);

// 两个不同的"仓库"，用来验证运行时切换仓库连接
const fake = await startFakeGitHub({
  repo: 'owner-aaa/app-a',
  releases: [releaseSpec('v1.0.0', { assets: [repoAAsset], publishedAt: '2026-10-01T00:00:00Z' })],
});
const fakeB = await startFakeGitHub({
  repo: 'owner-bbb/app-b',
  releases: [releaseSpec('v2.0.0-pre', { prerelease: true, assets: [repoBAsset], publishedAt: '2026-10-02T00:00:00Z' })],
});

// 测试一律直连，不探测真实加速源（镜像逻辑由 mirrors.test.js 用本地假源专门验证）
process.env.MIRROR_MODE = 'off';
process.env.GITHUB_REPO = 'owner-aaa/app-a';
process.env.GITHUB_API_BASE = fake.baseUrl;
process.env.DATA_DIR = tmpDir;
process.env.SYNC_ON_START = 'false';
process.env.SYNC_INTERVAL_SECONDS = '0';
process.env.KEEP_VERSIONS = '1';
process.env.LOG_LEVEL = 'error';

const { config, FILES_DIR } = await import('../src/config.js');
const settings = await import('../src/settings.js');
const { createServer } = await import('../src/server.js');
const sync = await import('../src/sync.js');
const store = await import('../src/store.js');

await store.ensureDirs();
await settings.loadSettings();
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const localNames = async () => (await store.listLocalFiles()).map((f) => f.name).sort();
const postSettings = async (payload) => {
  const res = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
/** 等到条件成立（用于等待"配置变更后排队的补跑同步"） */
async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test.after(async () => {
  sync.stopScheduler();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fake.close();
  await fakeB.close();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('运行时配置：镜像哪个 GitHub 仓库可以随时改', async (t) => {
  await t.test('初始使用环境变量指定的仓库 A', async () => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.repo, 'owner-aaa/app-a');
    assert.equal(body.settingsFileActive, false, '还没写 settings.json');
    assert.ok(body.editableFields.includes('repo'));

    const result = await sync.syncNow('settings-test-a');
    assert.equal(result.newestTag, 'v1.0.0');
    assert.deepEqual(await localNames(), [repoAAsset.name]);
  });

  await t.test('POST /api/settings 切换成仓库 B：立即生效并下载 B 的 pre 版', async () => {
    const { status, body } = await postSettings({
      repo: 'owner-bbb/app-b',
      apiBase: fakeB.baseUrl,
      includePrerelease: true,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.repoChanged, true);
    assert.equal(body.settings.repo, 'owner-bbb/app-b');

    // 配置已经落盘
    const saved = JSON.parse(await fsp.readFile(path.join(tmpDir, 'settings.json'), 'utf8'));
    assert.equal(saved.repo, 'owner-bbb/app-b');

    // 接口触发的后台同步会下载新仓库的文件，并清理旧仓库的文件
    await sync.syncNow('settings-test-b');
    assert.deepEqual(await localNames(), [repoBAsset.name], '旧仓库文件应被清理，只留新仓库的最新版');

    const latest = await (await fetch(`${base}/api/latest`)).json();
    assert.equal(latest.tag, 'v2.0.0-pre');
    assert.equal(latest.files[0].sha256, repoBAsset.sha256);

    const status2 = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status2.repo, 'owner-bbb/app-b');
  });

  await t.test('配置持久化：重启（重新加载）后仍然指向仓库 B', async () => {
    // 模拟进程重启：把 config 改回环境变量值，再走一次启动加载流程
    config.repo = 'owner-aaa/app-a';
    config.apiBase = fake.baseUrl;
    await settings.loadSettings();
    assert.equal(config.repo, 'owner-bbb/app-b', 'settings.json 应覆盖环境变量');

    const body = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(body.settingsFileActive, true);
    assert.ok(body.overriddenFields.includes('repo'));
  });

  await t.test('可运行时修改同步间隔与保留版本数，并校验非法值', async () => {
    const ok = await postSettings({ syncIntervalSeconds: 120, keepVersions: 3, assetRegex: '\\.exe$' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settings.syncIntervalSeconds, 120);
    assert.equal(ok.body.settings.keepVersions, 3);
    assert.equal(ok.body.settings.assetRegex, '\\.exe$');

    const badRepo = await postSettings({ repo: 'not-a-repo' });
    assert.equal(badRepo.status, 400);
    assert.equal(badRepo.body.field, 'repo');

    const badInt = await postSettings({ keepVersions: 0 });
    assert.equal(badInt.status, 400);
    assert.match(badInt.body.message, /keepVersions/);

    const badRegex = await postSettings({ assetRegex: '([' });
    assert.equal(badRegex.status, 400);
    assert.equal(badRegex.body.field, 'assetRegex');

    const unknown = await postSettings({ nope: 1 });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.message, /不支持的配置项/);

    const tokenAttempt = await postSettings({ githubToken: 'abc' });
    assert.equal(tokenAttempt.status, 400);
    assert.match(tokenAttempt.body.message, /环境变量/);

    // 失败不应该污染已有配置
    const after = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(after.repo, 'owner-bbb/app-b');
    assert.equal(after.keepVersions, 3);
    assert.equal(after.syncIntervalSeconds, 120);
  });

  await t.test('畸形请求体返回 400 而不是 500', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_request');
  });

  await t.test('reset 恢复环境变量默认（仓库回到 A），并再次同步回 A', async () => {
    // 先把可能还在后台跑的同步等干净，避免断言到上一次配置的结果
    await sync.syncNow('drain-before-reset');

    const { status, body } = await postSettings({ reset: true });
    assert.equal(status, 200);
    assert.equal(body.settings.repo, 'owner-aaa/app-a');
    assert.equal(body.settings.settingsFileActive, false);
    await assert.rejects(fsp.stat(path.join(tmpDir, 'settings.json')), /ENOENT/, 'settings.json 应被删除');
    assert.equal(config.assetRegex, null);

    const result = await sync.syncNow('settings-test-reset');
    assert.equal(result.newestTag, 'v1.0.0');
    assert.deepEqual(await localNames(), [repoAAsset.name], '应清理仓库 B 的文件并下载回仓库 A');
  });

  await t.test('同步进行中改配置：结束后会自动按新配置补跑一次', async () => {
    const runsBefore = sync.getSyncState().runs;

    // 先占住同步（不 await），模拟"同步很慢的时候用户改了配置"
    const busy = sync.syncNow('busy-test');
    const queued = sync.syncNow('busy-test-queued', { rerunIfBusy: true });
    assert.equal(busy, queued, '进行中时应复用同一个任务');

    await busy;
    // 排队的那次补跑应该在之后自动发生
    await waitFor(() => sync.getSyncState().runs >= runsBefore + 2, { label: '排队补跑同步' });
    assert.ok(sync.getSyncState().runs >= runsBefore + 2, '应该发生了额外一次同步');
    assert.equal(sync.getSyncState().lastResult.newestTag, 'v1.0.0', '补跑使用最新配置');
  });

  await t.test('GET /api/config 同时给出生效配置与运行时配置来源', async () => {
    const body = await (await fetch(`${base}/api/config`)).json();
    assert.equal(body.repo, 'owner-aaa/app-a');
    assert.equal(body.runtime.repo, 'owner-aaa/app-a');
    assert.ok(body.runtime.settingsFile.endsWith('settings.json'));
  });
});
