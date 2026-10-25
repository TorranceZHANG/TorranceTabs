import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateChecker } from '../update-checker.js';

const api = { runtime: { getManifest: () => ({ version: '1.6.0' }) } };
const response = payload => ({ ok: true, status: 200, headers: { get: () => null }, body: null,
  async text() { return JSON.stringify(payload); } });

test('仅显式调用时请求固定GitHub API且不携带凭据或referrer', async () => {
  let calls = 0;
  const check = createUpdateChecker(api, async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.github.com/repos/TorranceZHANG/TorranceTabs/releases/latest');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.redirect, 'error');
    return response({ tag_name: 'v1.7.0', html_url: 'https://github.com/TorranceZHANG/TorranceTabs/releases/tag/v1.7.0' });
  });
  assert.equal(calls, 0);
  assert.deepEqual(await check(), { current: '1.6.0', latest: '1.7.0', available: true,
    url: 'https://github.com/TorranceZHANG/TorranceTabs/releases/tag/v1.7.0' });
  assert.equal(calls, 1);
});

test('拒绝伪造release链接、预发布和超大响应', async () => {
  await assert.rejects(createUpdateChecker(api, async () => response({ tag_name: 'v1.7.0',
    html_url: 'https://evil.test/v1.7.0' }))(), /链接/);
  await assert.rejects(createUpdateChecker(api, async () => response({ tag_name: 'v1.7.0', prerelease: true,
    html_url: 'https://github.com/TorranceZHANG/TorranceTabs/releases/tag/v1.7.0' }))(), /信息无效/);
  const large = { ok: true, status: 200, headers: { get: () => String(200000) }, body: null, async text() { return ''; } };
  await assert.rejects(createUpdateChecker(api, async () => large)(), /大小限制/);
});

test('超时只报告失败，不自动重试请求', async () => {
  let calls = 0;
  const check = createUpdateChecker(api, (_url, options) => {
    calls += 1;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }))));
  }, 5);
  await assert.rejects(check(), /超时/);
  assert.equal(calls, 1);
});
