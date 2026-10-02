import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'blfp-unit-'));
process.env.DATA_DIR = tmpDir;
process.env.GITHUB_REPO = 'test/repo';
process.env.SYNC_ON_START = 'false';
process.env.SYNC_INTERVAL_SECONDS = '0';
process.env.MAX_RETRIES = '2';
process.env.STALL_TIMEOUT_SECONDS = '15';
process.env.LOG_LEVEL = 'error';

const { config, FILES_DIR } = await import('../src/config.js');
const { compareTags, sortReleases, selectReleases } = await import('../src/github.js');
const { sanitizeFileName, fileSha256 } = await import('../src/util.js');
const store = await import('../src/store.js');
const { downloadAsset, verifyExisting } = await import('../src/downloader.js');
const { startFakeGitHub, makeAsset } = await import('./helpers/fake-github.js');

/** 构造 GitHub 原始 release 结构 */
function rawRelease(tag, { prerelease = false, publishedAt = '2026-01-01T00:00:00Z', assets = [] } = {}) {
  return {
    tag_name: tag,
    name: tag,
    draft: false,
    prerelease,
    published_at: publishedAt,
    created_at: publishedAt,
    html_url: `https://github.com/test/repo/releases/tag/${tag}`,
    body: '',
    assets: assets.map((a) => ({
      name: a.name,
      size: a.size ?? 100,
      state: 'uploaded',
      digest: a.sha256 ? `sha256:${a.sha256}` : null,
      url: `https://api.github.com/repos/test/repo/releases/assets/${a.name}`,
      browser_download_url: `https://github.com/test/repo/releases/download/${tag}/${a.name}`,
      updated_at: publishedAt,
    })),
  };
}

/** 临时改配置并在结束后恢复，用来测不同过滤组合 */
async function withConfig(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = config[k];
    config[k] = v;
  }
  try {
    return await fn();
  } finally {
    Object.assign(config, saved);
  }
}

test('compareTags: 语义化版本比较，正式版高于同号 pre', () => {
  assert.ok(compareTags('v2.3.21-pre', 'v2.3.20-pre') > 0);
  assert.ok(compareTags('v2.3.19', 'v2.3.19-pre') > 0);
  assert.ok(compareTags('v2.3.19-pre', 'v2.3.19') < 0);
  assert.ok(compareTags('v2.10.0', 'v2.9.9') > 0);
  assert.equal(compareTags('v2.3.19', '2.3.19'), 0);
  assert.equal(compareTags('not-a-version', 'v1.0.0'), 0);
  assert.ok(compareTags('v1.0.0-beta.2', 'v1.0.0-beta.10') < 0);
});

test('sortReleases: 新版本在前，无法比较版本号时按发布时间', () => {
  const sorted = sortReleases([
    { tag: 'v2.3.19', publishedAt: '2026-01-03T00:00:00Z' },
    { tag: 'v2.3.21-pre', publishedAt: '2026-01-01T00:00:00Z' },
    { tag: 'v2.3.20-pre', publishedAt: '2026-01-02T00:00:00Z' },
  ]);
  assert.deepEqual(
    sorted.map((r) => r.tag),
    ['v2.3.21-pre', 'v2.3.20-pre', 'v2.3.19'],
  );
});

test('selectReleases: 默认包含 pre-release，并选出最新的 pre', () => {
  const selected = selectReleases([
    rawRelease('v2.0.0', { assets: [{ name: 'blfp-setup-v2.0.0.exe' }] }),
    rawRelease('v2.0.0-pre', { prerelease: true, assets: [{ name: 'blfp-setup-v2.0.0-pre.exe' }] }),
    rawRelease('v2.1.0-pre', { prerelease: true, assets: [{ name: 'blfp-setup-v2.1.0-pre.exe' }] }),
    rawRelease('v1.9.0', { assets: [{ name: 'blfp-setup-v1.9.0.exe' }] }),
  ]);
  assert.equal(selected[0].tag, 'v2.1.0-pre');
  assert.equal(selected[0].prerelease, true);
  assert.equal(selected[0].assets[0].fileName, 'blfp-setup-v2.1.0-pre.exe');
});

test('selectReleases: INCLUDE_PRERELEASE=false 时忽略 pre-release', async () => {
  await withConfig({ includePrerelease: false }, () => {
    const selected = selectReleases([
      rawRelease('v2.1.0-pre', { prerelease: true, assets: [{ name: 'a.exe' }] }),
      rawRelease('v2.0.0', { assets: [{ name: 'b.exe' }] }),
    ]);
    assert.equal(selected[0].tag, 'v2.0.0');
    assert.equal(selected.length, 1);
  });
});

test('selectReleases: ASSET_REGEX 过滤资产；无资产匹配的 release 被跳过', async () => {
  await withConfig({ assetRegex: /\.exe$/ }, () => {
    const selected = selectReleases(
      [
        rawRelease('v3.0.0', { assets: [{ name: 'setup.exe' }, { name: 'latest.yml' }] }),
        rawRelease('v2.0.0', { assets: [{ name: 'notes.txt' }] }),
      ],
      5,
    );
    assert.equal(selected.length, 1);
    assert.equal(selected[0].tag, 'v3.0.0');
    assert.deepEqual(
      selected[0].assets.map((a) => a.name),
      ['setup.exe'],
    );
  });
});

test('selectReleases: 同名资产跨版本时自动加 tag 前缀，避免互相覆盖', () => {
  const selected = selectReleases(
    [
      rawRelease('v1.0.0', { assets: [{ name: 'setup.exe' }] }),
      rawRelease('v2.0.0', { assets: [{ name: 'setup.exe' }] }),
    ],
    2,
  );
  const names = selected.flatMap((r) => r.assets.map((a) => a.fileName)).sort();
  assert.deepEqual(names, ['v1.0.0__setup.exe', 'v2.0.0__setup.exe']);
});

test('sanitizeFileName: 阻止路径穿越', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe');
  assert.equal(sanitizeFileName('...hidden'), '_hidden');
  assert.equal(sanitizeFileName('/abs/path/file.exe'), 'file.exe');
});

test('pruneFiles: 删除不在保留列表中的旧版本与过期半成品', async () => {
  await store.ensureDirs();
  await fsp.writeFile(path.join(FILES_DIR, 'new.exe'), Buffer.alloc(10, 1));
  await fsp.writeFile(path.join(FILES_DIR, 'old.exe'), Buffer.alloc(20, 2));
  await fsp.writeFile(path.join(FILES_DIR, 'older.exe'), Buffer.alloc(30, 3));
  await fsp.writeFile(path.join(FILES_DIR, 'new.exe.part'), Buffer.alloc(5, 4));
  const stale = path.join(FILES_DIR, 'stale.exe.part');
  await fsp.writeFile(stale, Buffer.alloc(5, 5));
  const old = new Date(Date.now() - 24 * 3600 * 1000);
  await fsp.utimes(stale, old, old);

  const result = await store.pruneFiles(new Set(['new.exe', 'new.exe.part']));

  const left = (await store.listLocalFiles()).map((f) => f.name).sort();
  assert.deepEqual(left, ['new.exe']);
  const rawLeft = (await fsp.readdir(FILES_DIR)).sort();
  assert.ok(rawLeft.includes('new.exe.part'), '新的 .part 应保留用于续传');
  assert.ok(!rawLeft.includes('stale.exe.part'), '过期 .part 应删除');
  const reasons = result.deleted.map((d) => d.name).sort();
  assert.deepEqual(reasons, ['old.exe', 'older.exe', 'stale.exe.part']);
});

test('pruneFiles: 保留列表为空时拒绝执行，避免误删全部数据', async () => {
  const result = await store.pruneFiles(new Set());
  assert.equal(result.skipped, true);
  assert.ok((await store.listLocalFiles()).length > 0, '文件不应被删除');
});

test('downloadAsset: 断点续传（HTTP Range）后文件与 sha256 都正确', async () => {
  const asset = makeAsset('resume-test.bin', 300 * 1024);
  const fake = await startFakeGitHub({ releases: [{ tag: 'v1.0.0', prerelease: false, publishedAt: new Date().toISOString(), assets: [asset] }] });
  try {
    const dest = path.join(tmpDir, 'dl', asset.name);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const half = Math.floor(asset.size / 2);
    await fsp.writeFile(`${dest}.part`, asset.buffer.subarray(0, half));

    const result = await downloadAsset(
      {
        fileName: asset.name,
        size: asset.size,
        sha256: asset.sha256,
        downloadUrl: `${fake.baseUrl}/dl/${encodeURIComponent(asset.name)}`,
      },
      dest,
    );

    assert.equal(result.resumedFrom, half, '应从半成品继续下载');
    assert.equal(result.size, asset.size);
    assert.equal(result.verified, true);
    const written = await fsp.readFile(dest);
    assert.ok(written.equals(asset.buffer), '内容应与远端完全一致');
    assert.equal(await fileSha256(dest), asset.sha256);
    await assert.rejects(fsp.stat(`${dest}.part`), /ENOENT/, '.part 应被重命名掉');
  } finally {
    await fake.close();
  }
});

test('downloadAsset: sha256 不匹配时报错且清理半成品', async () => {
  const asset = makeAsset('bad-hash.bin', 64 * 1024);
  const fake = await startFakeGitHub({ releases: [{ tag: 'v1.0.0', prerelease: false, publishedAt: new Date().toISOString(), assets: [asset] }] });
  try {
    const dest = path.join(tmpDir, 'dl', 'bad.bin');
    await assert.rejects(
      downloadAsset(
        {
          fileName: 'bad.bin',
          size: asset.size,
          sha256: 'f'.repeat(64),
          downloadUrl: `${fake.baseUrl}/dl/${encodeURIComponent(asset.name)}`,
        },
        dest,
      ),
      /sha256 校验失败/,
    );
    await assert.rejects(fsp.stat(dest), /ENOENT/);
    await assert.rejects(fsp.stat(`${dest}.part`), /ENOENT/, '失败后应清理 .part');
  } finally {
    await fake.close();
  }
});

test('downloadAsset: 首次请求失败（HTTP 500）会重试并最终成功', async () => {
  const asset = makeAsset('retry.bin', 32 * 1024);
  const fake = await startFakeGitHub({
    releases: [{ tag: 'v1.0.0', prerelease: false, publishedAt: new Date().toISOString(), assets: [asset] }],
    failAssetTimes: 1,
  });
  try {
    const dest = path.join(tmpDir, 'dl', 'retry.bin');
    const result = await downloadAsset(
      {
        fileName: 'retry.bin',
        size: asset.size,
        sha256: asset.sha256,
        downloadUrl: `${fake.baseUrl}/dl/${encodeURIComponent(asset.name)}`,
      },
      dest,
    );
    assert.equal(result.size, asset.size);
    assert.equal(await fileSha256(dest), asset.sha256, '重试后内容仍然正确');
    const assetRequests = fake.state.requests.filter((r) => r.path.startsWith('/dl/'));
    assert.equal(assetRequests.length, 2, '应发生一次失败 + 一次成功，共 2 次请求');
  } finally {
    await fake.close();
  }
});

test('verifyExisting: 依据 manifest 记录（size+mtime）跳过重复校验', async () => {
  const target = path.join(tmpDir, 'verify.bin');
  await fsp.writeFile(target, Buffer.from('hello world'));
  const st = await fsp.stat(target);
  const asset = { fileName: 'verify.bin', size: st.size, sha256: await fileSha256(target) };

  const reused = await verifyExisting(target, asset, { size: st.size, mtimeMs: Math.floor(st.mtimeMs), sha256: asset.sha256 });
  assert.equal(reused.reused, true);
  assert.equal(reused.verified, true);

  const recomputed = await verifyExisting(target, asset, null);
  assert.equal(recomputed.verified, true);
  assert.equal(recomputed.sha256, asset.sha256);

  const mismatched = await verifyExisting(target, { ...asset, size: st.size + 1 }, null);
  assert.equal(mismatched, null, '大小不一致应返回 null 触发重新下载');
});

test('downloadAsset: 404 不重试，直接失败', async () => {
  const fake = await startFakeGitHub({ releases: [] });
  try {
    await assert.rejects(
      downloadAsset(
        { fileName: 'gone.exe', size: 100, sha256: null, downloadUrl: `${fake.baseUrl}/dl/gone.exe` },
        path.join(tmpDir, 'dl', 'gone.exe'),
      ),
      /HTTP 404/,
    );
  } finally {
    await fake.close();
  }
});

test('listReleases: 速率限制给出可操作的错误信息', async () => {
  const fake = await startFakeGitHub({ releases: [] });
  fake.setRateLimited(true);
  const { listReleases, GitHubError } = await import('../src/github.js');
  const savedBase = config.apiBase;
  config.apiBase = fake.baseUrl;
  try {
    await assert.rejects(listReleases(), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.rateLimited, true);
      assert.match(err.message, /GITHUB_TOKEN/);
      return true;
    });
  } finally {
    config.apiBase = savedBase;
    await fake.close();
  }
});

test('downloadAsset: 未完成的 .part 收敛为完整文件（大小校验通过）', async () => {
  const asset = makeAsset('sized.bin', 128 * 1024);
  const fake = await startFakeGitHub({ releases: [{ tag: 'v1.0.0', prerelease: false, publishedAt: new Date().toISOString(), assets: [asset] }] });
  try {
    const dest = path.join(tmpDir, 'dl', 'sized.bin');
    // 半成品比真实文件还大 → 应丢弃并重新下载
    await fsp.writeFile(`${dest}.part`, crypto.randomBytes(asset.size + 1024));
    const result = await downloadAsset(
      { fileName: 'sized.bin', size: asset.size, sha256: asset.sha256, downloadUrl: `${fake.baseUrl}/dl/${encodeURIComponent(asset.name)}` },
      dest,
    );
    assert.equal(result.resumedFrom, 0);
    assert.equal(result.size, asset.size);
    assert.equal(await fileSha256(dest), asset.sha256);
  } finally {
    await fake.close();
  }
});
