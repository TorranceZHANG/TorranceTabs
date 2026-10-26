import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuplicatePolicy, normalizeDuplicateAllowlist } from '../duplicate-policy.js';

function fixture() {
  const state = { local: {}, session: {} };
  const area = name => ({
    async get(defaults) { return structuredClone({ ...defaults, ...state[name] }); },
    async set(values) { Object.assign(state[name], structuredClone(values)); },
  });
  let timestamp = 1_000;
  let tail = Promise.resolve();
  const enqueue = task => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
  const api = { storage: { local: area('local'), session: area('session') } };
  return { state, policy: createDuplicatePolicy(api, enqueue, () => timestamp), tick: value => { timestamp = value; } };
}

test('allowlist 仅接受不重复的精确 HTTP(S) origin', () => {
  assert.deepEqual(normalizeDuplicateAllowlist(['https://a.test', 'http://b.test:8080']),
    ['https://a.test', 'http://b.test:8080']);
  for (const value of [['https://a.test', 'https://a.test'], ['https://a.test/'],
    ['https://a.test/path'], ['HTTPS://a.test'], ['ftp://a.test'], Array(101).fill('https://a.test')]) {
    assert.throws(() => normalizeDuplicateAllowlist(value));
  }
});

test('站点固定暂停30分钟且到期清理，allowlist同时抑制去重和提示', async () => {
  const { state, policy, tick } = fixture();
  await policy.setAllowlist(['https://allowed.test']);
  assert.equal(await policy.isDuplicateAllowed('https://allowed.test/path'), true);
  assert.equal(await policy.isPromptPaused('https://allowed.test/path'), true);
  assert.equal(await policy.pauseSite('https://paused.test'), 1_801_000);
  assert.equal(await policy.isDuplicateAllowed('https://paused.test/path'), false);
  assert.equal(await policy.isPromptPaused('https://paused.test/path'), true);
  tick(1_801_000);
  assert.equal(await policy.isPromptPaused('https://paused.test/path'), false);
  assert.deepEqual(state.session.duplicatePausedSites, {});
});

test('标签暂停支持并发写、替换迁移和移除清理', async () => {
  const { state, policy } = fixture();
  await Promise.all([policy.pauseTab(1, true), policy.pauseTab(2, true)]);
  assert.deepEqual(state.session.groupingPausedTabs, { 1: true, 2: true });
  assert.equal(await policy.replaced(3, 1), true);
  assert.equal(await policy.isGroupingPaused({ id: 1 }), false);
  assert.equal(await policy.isGroupingPaused({ id: 3 }), true);
  assert.equal(await policy.removed(2), true);
  assert.deepEqual((await policy.getState()).pausedTabs, { 3: true });
});
