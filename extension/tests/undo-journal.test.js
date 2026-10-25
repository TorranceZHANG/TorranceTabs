import test from 'node:test';
import assert from 'node:assert/strict';
import { createUndoJournal } from '../undo-journal.js';
import { createLocalWriteQueue } from '../library-store.js';
import { createOperationLock } from '../operation-lock.js';

function fixture(initial = null) {
  const data = { cleanupUndo: initial };
  const session = {};
  const tabs = new Map([[1, { id: 1, windowId: 1, url: 'https://same.test/', groupId: -1 }]]);
  const groups = new Map();
  const controls = { claimResult: true, verifyResult: true, navigateAfterClaim: false, nextWindow: 99, windowCreates: 0,
    allowNewWindow: false, groupSucceeds: false, shareAfterUpdate: false,
    pendingNavigation: false, pendingOverride: null };
  let nextId = 2;
  const api = { storage: { local: {
    async get(defaults) { return structuredClone({ ...defaults, ...data }); },
    async set(values) { Object.assign(data, structuredClone(values)); },
  }, session: {
    async get(defaults) { return structuredClone({ ...defaults, ...session }); },
    async set(values) { Object.assign(session, structuredClone(values)); },
  } }, tabs: {
    async create(values) { const tab = { id: nextId++, windowId: values.windowId || 1, url: values.url, groupId: -1 }; tabs.set(tab.id, tab); return { ...tab }; },
    async get(id) { if (!tabs.has(id)) throw Error('missing'); return { ...tabs.get(id) }; },
    async update(id, values) {
      const tab = tabs.get(id);
      if (controls.pendingNavigation && typeof values.url === 'string') {
        Object.assign(tab, { ...values, url: tab.url,
          pendingUrl: controls.pendingOverride || values.url, status: 'loading' });
      } else Object.assign(tab, values);
      return { ...tab };
    },
    async group(values) {
      if (!controls.groupSucceeds) throw Error('unexpected group');
      const groupId = values.groupId ?? 50;
      if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: values.createProperties.windowId, shared: false });
      for (const id of values.tabIds) tabs.get(id).groupId = groupId;
      return groupId;
    },
  }, windows: { async get(id) { return { id, type: 'normal', incognito: false }; }, async create(values) {
    if (!controls.allowNewWindow) throw Error('unexpected window');
    const windowId = controls.nextWindow++;
    controls.windowCreates += 1;
    const tab = { id: nextId++, windowId, url: values.url, groupId: -1 };
    tabs.set(tab.id, tab);
    return { id: windowId, type: 'normal', tabs: [{ ...tab }] };
  } },
  tabGroups: {
    async get(id) { if (!groups.has(id)) throw Error('missing group'); return { ...groups.get(id) }; },
    async update(id, values) {
      Object.assign(groups.get(id), values);
      if (controls.shareAfterUpdate) groups.get(id).shared = true;
    },
  } };
  const suppression = { async plan() { return 'token'; }, async claim() { return controls.claimResult; },
    async verify(tab) {
      if (controls.navigateAfterClaim) tabs.get(tab.id).url = 'https://user.test/';
      return controls.verifyResult && tabs.get(tab.id)?.url === 'about:blank';
    }, async cancel() {} };
  const create = () => createUndoJournal(api, createLocalWriteQueue(), suppression, createOperationLock(), () => 10);
  return { data, session, tabs, groups, controls, create };
}

test('普通GET不把本worker正在关闭的记录误报中断，新worker恢复时才转换', async () => {
  const { create } = fixture();
  const first = create();
  const id = await first.prepare(first.begin(), { id: 2, url: 'https://same.test/', title: '重复', windowId: 1, index: 1 });
  assert.deepEqual((await first.getUndo()).items, []);
  const restarted = create();
  assert.deepEqual((await restarted.getUndo()).items.map(item => ({ id: item.id, status: item.status })), [{ id, status: 'interrupted' }]);
});

test('每条已关闭记录独立新建恢复，即使keeper同URL仍在；重复点击不再创建', async () => {
  const { tabs, create } = fixture();
  const journal = create();
  const batch = journal.begin();
  const id = await journal.prepare(batch, { id: 2, url: 'https://same.test/', title: '重复', windowId: 1, index: 1 });
  await journal.settle(batch, new Map([[id, 'closed']]));
  const first = await journal.restore([id]);
  assert.equal(first.restored, 1);
  assert.equal([...tabs.values()].filter(tab => tab.url === 'https://same.test/').length, 2);
  assert.equal((await journal.restore([id])).restored, 0);
  assert.equal(tabs.size, 2);
});

test('journal容量满时prepare失败且不返回未持久化ID', async () => {
  const items = Array.from({ length: 500 }, (_, index) => ({ id: `i${index}`, url: 'https://x.test/', title: '',
    windowId: 1, index, pinned: false, group: null, status: 'available', preparedAt: 1 }));
  const { create } = fixture({ schemaVersion: 1, batches: [{ id: 'old', createdAt: 1, items }] });
  await assert.rejects(create().prepare('new', { id: 2, url: 'https://x.test/', windowId: 1 }), /500 条上限/);
});

test('撤销恢复登记失败时不导航原网址，记录保持可重试', async () => {
  const { tabs, controls, create } = fixture();
  const journal = create();
  const batch = journal.begin();
  const id = await journal.prepare(batch, { id: 2, url: 'https://same.test/', title: '重复', windowId: 1, index: 1 });
  await journal.settle(batch, new Map([[id, 'closed']]));
  controls.claimResult = false;
  const result = await journal.restore([id]);
  assert.equal(result.restored, 0);
  assert.equal(result.failed, 1);
  assert.equal([...tabs.values()].filter(tab => tab.url === 'https://same.test/').length, 1);
  assert.equal((await journal.getUndo()).items.find(item => item.id === id).status, 'available');
});

test('网址恢复成功后分组失败仍提交为已恢复，重复点击不再开页', async () => {
  const { tabs, create } = fixture();
  const journal = create();
  const batch = journal.begin();
  const id = await journal.prepare(batch, { id: 2, url: 'https://same.test/', title: '重复', windowId: 1, index: 1 },
    { title: '原组', color: 'blue', collapsed: true });
  await journal.settle(batch, new Map([[id, 'closed']]));
  const first = await journal.restore([id]);
  assert.equal(first.restored, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.items[0].partial, true);
  assert.equal(tabs.size, 2);
  assert.equal((await journal.restore([id])).restored, 0);
  assert.equal(tabs.size, 2);
});

test('浏览器会话变化后不复用可能已被重编号的旧窗口', async () => {
  const { session, tabs, controls, create } = fixture();
  const journal = create();
  const batch = journal.begin();
  const id = await journal.prepare(batch, { id: 2, url: 'https://same.test/', title: '重复', windowId: 1, index: 1 });
  await journal.settle(batch, new Map([[id, 'closed']]));
  for (const key of Object.keys(session)) delete session[key];
  controls.allowNewWindow = true;
  const result = await create().restore([id]);
  assert.equal(result.restored, 1);
  const restored = [...tabs.values()].find(tab => tab.id !== 1 && tab.url === 'https://same.test/');
  assert.equal(restored.windowId, 99);
});

test('复用恢复组前重读目标组，共享或移窗后不再把后续标签加入', async () => {
  const { tabs, groups, controls, create } = fixture();
  controls.groupSucceeds = true;
  controls.shareAfterUpdate = true;
  const journal = create();
  const batch = journal.begin();
  const group = { title: '原组', color: 'blue', collapsed: true };
  const firstId = await journal.prepare(batch, { id: 2, url: 'https://first.test/', title: '一', windowId: 1, index: 1 }, group);
  const secondId = await journal.prepare(batch, { id: 3, url: 'https://second.test/', title: '二', windowId: 1, index: 2 }, group);
  await journal.settle(batch, new Map([[firstId, 'closed'], [secondId, 'closed']]));
  const result = await journal.restore([firstId, secondId]);
  assert.equal(result.restored, 2);
  assert.equal(result.failed, 1);
  assert.equal(groups.get(50).shared, true);
  assert.equal([...tabs.values()].find(tab => tab.url === 'https://first.test/').groupId, 50);
  assert.equal([...tabs.values()].find(tab => tab.url === 'https://second.test/').groupId, -1);
});

test('清理恢复记录只删除非活跃项，并可解除容量占用', async () => {
  const { data, create } = fixture();
  const journal = create();
  const availableBatch = journal.begin();
  const availableId = await journal.prepare(availableBatch,
    { id: 2, url: 'https://available.test/', title: '可恢复', windowId: 1, index: 1 });
  await journal.settle(availableBatch, new Map([[availableId, 'closed']]));
  const activeId = await journal.prepare(journal.begin(),
    { id: 3, url: 'https://active.test/', title: '处理中', windowId: 1, index: 2 });
  assert.deepEqual(await journal.discard([availableId, activeId]), { discarded: 1 });
  assert.equal(data.cleanupUndo.batches.flatMap(batch => batch.items).some(item => item.id === activeId), true);

  const restarted = create();
  assert.equal((await restarted.getUndo()).items.find(item => item.id === activeId).status, 'interrupted');
  assert.deepEqual(await restarted.discard(), { discarded: 1 });
  assert.deepEqual(data.cleanupUndo.batches, []);
  await assert.rejects(restarted.discard('not-an-array'), /记录无效/);
});

test('撤销允许受控空白页正在导航原URL时恢复分组，但拒绝异URL pending', async () => {
  const run = async pendingOverride => {
    const value = fixture();
    value.controls.groupSucceeds = true;
    value.controls.pendingNavigation = true;
    value.controls.pendingOverride = pendingOverride;
    const journal = value.create();
    const batch = journal.begin();
    const id = await journal.prepare(batch,
      { id: 2, url: 'https://target.test/', title: '目标', windowId: 1, index: 1 },
      { title: '原组', color: 'blue', collapsed: false });
    await journal.settle(batch, new Map([[id, 'closed']]));
    return { value, result: await journal.restore([id]) };
  };

  const allowed = await run(null);
  assert.equal(allowed.result.failed, 0);
  const allowedTab = [...allowed.value.tabs.values()].find(tab => tab.pendingUrl === 'https://target.test/');
  assert.equal(allowedTab.url, 'about:blank');
  assert.equal(allowedTab.status, 'loading');
  assert.equal(allowedTab.groupId, 50);

  const rejected = await run('https://other.test/');
  assert.equal(rejected.result.restored, 1);
  assert.equal(rejected.result.failed, 1);
  const rejectedTab = [...rejected.value.tabs.values()].find(tab => tab.pendingUrl === 'https://other.test/');
  assert.equal(rejectedTab.groupId, -1);
});

test('撤销claim持久化期间用户离开空白页时不覆盖为原网址', async () => {
  const { tabs, controls, create } = fixture();
  controls.navigateAfterClaim = true;
  const journal = create();
  const batch = journal.begin();
  const id = await journal.prepare(batch,
    { id: 2, url: 'https://target.test/', title: '目标', windowId: 1, index: 1 });
  await journal.settle(batch, new Map([[id, 'closed']]));
  const result = await journal.restore([id]);
  assert.equal(result.restored, 0);
  assert.equal(result.failed, 1);
  assert.equal([...tabs.values()].some(tab => tab.url === 'https://target.test/'), false);
  assert.equal([...tabs.values()].some(tab => tab.url === 'https://user.test/'), true);
});

test('跨浏览器会话按旧窗口复用fallback窗口，不为每条记录新建窗口', async () => {
  const { session, tabs, controls, create } = fixture();
  const journal = create();
  const batch = journal.begin();
  const ids = [];
  for (const [index, windowId] of [1, 1, 2].entries()) {
    ids.push(await journal.prepare(batch, { id: index + 2, url: `https://restore.test/${index}`,
      title: String(index), windowId, index }));
  }
  await journal.settle(batch, new Map(ids.map(id => [id, 'closed'])));
  for (const key of Object.keys(session)) delete session[key];
  controls.allowNewWindow = true;
  const result = await create().restore(ids);
  assert.equal(result.restored, 3);
  assert.equal(controls.windowCreates, 2);
  const restored = [...tabs.values()].filter(tab => tab.url.startsWith('https://restore.test/'));
  assert.deepEqual(restored.map(tab => tab.windowId), [99, 99, 100]);
});
