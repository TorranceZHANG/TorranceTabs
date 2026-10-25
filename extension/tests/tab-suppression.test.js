import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabSuppression } from '../tab-suppression.js';

function fixture() {
  const session = {};
  const state = { fail: false, tabs: new Map([[9, { id: 9, windowId: 1, groupId: -1, pinned: false, url: 'about:blank' }]]) };
  const api = { storage: { session: {
    async get(defaults) { return structuredClone({ ...defaults, ...session }); },
    async set(values) {
      if (state.fail) throw Error('session failed');
      if (state.navigateDuringSet && values.managedRestoreTabs?.tabs?.[9]) state.tabs.get(9).url = 'https://user.test/';
      Object.assign(session, structuredClone(values));
    },
  } }, tabs: { async get(id) { if (!state.tabs.has(id)) throw Error('missing'); return structuredClone(state.tabs.get(id)); } },
  windows: { async get(id) { return { id, type: 'normal', incognito: false }; } },
  tabGroups: { async get() { throw Error('unexpected group'); } } };
  return { state, session, suppression: createTabSuppression(api, () => 1) };
}

test('计划不会被并发用户空白页或同URL页抢占，只显式token绑定tabId', async () => {
  const { suppression } = fixture();
  const token = await suppression.plan('https://restore.test/');
  assert.equal(await suppression.contains({ id: 7, url: 'about:blank' }), false);
  assert.equal(await suppression.contains({ id: 8, url: 'https://restore.test/' }), false);
  assert.equal(await suppression.claim(9, 'about:blank', token), true);
  assert.equal(await suppression.contains({ id: 9, url: 'https://restore.test/' }), true);
});

test('session登记失败会拒绝plan或claim，调用方不得继续导航', async () => {
  const first = fixture(); first.state.fail = true;
  await assert.rejects(first.suppression.plan('https://restore.test/'), /session failed/);
  const second = fixture();
  const token = await second.suppression.plan('https://restore.test/');
  second.state.fail = true;
  await assert.rejects(second.suppression.claim(9, 'about:blank', token), /session failed/);
});

test('claim前已离开空白页时不消费token或绑定标签', async () => {
  const { state, suppression } = fixture();
  const token = await suppression.plan('https://restore.test/');
  state.tabs.get(9).url = 'https://user.test/';
  assert.equal(await suppression.claim({ id: 9, windowId: 1, groupId: -1, pinned: false }, 'about:blank', token), false);
  assert.equal(await suppression.contains(9), false);
});

test('claim持久化期间离开空白页时调用方二次复核阻止目标导航', async () => {
  const { state, suppression } = fixture();
  const token = await suppression.plan('https://restore.test/');
  const snapshot = structuredClone(state.tabs.get(9));
  state.navigateDuringSet = true;
  assert.equal(await suppression.claim(snapshot, 'about:blank', token), true);
  assert.equal(await suppression.verify(snapshot, 'about:blank'), false);
  let targetUpdateSent = false;
  if (await suppression.verify(snapshot, 'about:blank')) targetUpdateSent = true;
  assert.equal(targetUpdateSent, false);
  assert.equal(state.tabs.get(9).url, 'https://user.test/');
});
