import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeduplicator } from '../deduplication.js';

function fixture(tabs, groups = []) {
  const state = {
    tabs: new Map(tabs.map(tab => [tab.id, {
      windowId: 1, groupId: -1, url: 'https://example.com/page', status: 'complete',
      active: false, pinned: false, audible: false, ...tab,
    }])),
    groups: new Map(groups.map(group => [group.id, { windowId: 1, shared: false, ...group }])),
    windows: new Map([[1, { id: 1, type: 'normal' }], [2, { id: 2, type: 'normal' }], [3, { id: 3, type: 'popup' }]]),
    removed: [], focusedWindow: 1, queryCalls: 0, session: {},
  };
  const api = {
    storage: { session: {
      async get(defaults) { return structuredClone({ ...defaults, ...state.session }); },
      async set(values) { Object.assign(state.session, structuredClone(values)); },
    } },
    tabs: {
      async query(options = {}) {
        state.queryCalls += 1;
        if (state.onQuery) await state.onQuery(options);
        return structuredClone([...state.tabs.values()].filter(tab =>
          !options.windowType || state.windows.get(tab.windowId)?.type === options.windowType));
      },
      async get(id) {
        if (state.onGet) await state.onGet(id);
        if (!state.tabs.has(id)) throw Error('No tab');
        return structuredClone(state.tabs.get(id));
      },
      async remove(id) {
        state.removed.push(id);
        if (state.onRemove) return state.onRemove(id);
        state.tabs.delete(id);
      },
    },
    windows: {
      async get(id) { if (!state.windows.has(id)) throw Error('No window'); return { ...state.windows.get(id) }; },
      async getLastFocused() { return { ...state.windows.get(state.focusedWindow) }; },
    },
    tabGroups: {
      async query() { return structuredClone([...state.groups.values()]); },
      async get(id) { if (!state.groups.has(id)) throw Error('No group'); return { ...state.groups.get(id) }; },
    },
  };
  return { state, api, deduplicate: createDeduplicator(api) };
}

test('跨普通窗口去重保留一份，完整query和fragment不同的不合并', async () => {
  const { state, deduplicate } = fixture([
    { id: 1, url: 'https://example.com/?q=1#a' },
    { id: 2, windowId: 2, url: 'https://example.com/?q=1#a' },
    { id: 3, url: 'https://example.com/?q=2#a' },
    { id: 4, url: 'https://example.com/?q=1#b' },
  ]);
  assert.deepEqual(await deduplicate(), { closed: 1, skipped: 0, failed: 0, remaining: 0 });
  assert.deepEqual([...state.tabs.keys()], [1, 3, 4]);
});

test('保留当前焦点活跃页，其次固定、播放、其他活跃、最近使用和平局id', async () => {
  for (const [left, right, survivor] of [
    [{ id: 1, active: true }, { id: 2, pinned: true }, 1],
    [{ id: 1 }, { id: 2, pinned: true }, 2],
    [{ id: 1 }, { id: 2, audible: true }, 2],
    [{ id: 1 }, { id: 2, windowId: 2, active: true }, 2],
    [{ id: 1, lastAccessed: 100 }, { id: 2, lastAccessed: 200 }, 2],
    [{ id: 2 }, { id: 1 }, 1],
  ]) {
    const { state, deduplicate } = fixture([left, right]);
    await deduplicate();
    assert.deepEqual([...state.tabs.keys()], [survivor]);
  }
});

test('共享、无痕、分屏、导航中及内部页面不被删除或充当唯一保留页', async () => {
  for (const protectedTab of [
    { id: 1, groupId: 9 }, { id: 1, incognito: true }, { id: 1, splitViewId: 5 },
    { id: 1, pendingUrl: 'https://other.test/' }, { id: 1, status: 'loading' },
  ]) {
    const { state, deduplicate } = fixture([protectedTab, { id: 2 }, { id: 3 }], [{ id: 9, shared: true }]);
    const result = await deduplicate();
    assert.equal(result.closed, 1);
    assert.equal(state.tabs.has(1), true);
    assert.equal(state.tabs.has(2), true);
    assert.deepEqual(state.removed, [3]);
  }
  const { state, deduplicate } = fixture([
    { id: 1, url: 'chrome://newtab/' }, { id: 2, url: 'chrome://newtab/' },
    { id: 3, windowId: 3 }, { id: 4 },
  ]);
  assert.equal((await deduplicate()).closed, 0);
  assert.equal(state.removed.length, 0);
});

test('保留页关闭、导航、移窗、成为共享或分屏后停止此URL桶', async () => {
  for (const mutate of [
    state => state.tabs.delete(1),
    state => { state.tabs.get(1).url = 'https://other.test/'; },
    state => { state.tabs.get(1).windowId = 2; },
    state => { state.tabs.get(1).groupId = 9; },
    state => { state.tabs.get(1).splitViewId = 4; },
  ]) {
    const { state, deduplicate } = fixture([{ id: 1 }, { id: 2 }, { id: 3 }], [{ id: 9, shared: true }]);
    let changed = false;
    state.onGet = () => { if (!changed) { changed = true; mutate(state); } };
    await deduplicate();
    assert.equal(state.removed.length, 0);
    assert.equal(state.tabs.has(2), true);
    assert.equal(state.tabs.has(3), true);
  }
});

test('候选导航、固定、激活、播放、改组、分屏或移窗后不关闭', async () => {
  for (const values of [
    { url: 'https://other.test/' }, { pinned: true }, { active: true }, { audible: true },
    { groupId: 9 }, { splitViewId: 2 }, { windowId: 2 }, { pendingUrl: 'https://other.test/' },
  ]) {
    const { state, deduplicate } = fixture([{ id: 1 }, { id: 2 }], [{ id: 9, shared: true }]);
    state.onGet = id => { if (id === 2) Object.assign(state.tabs.get(id), values); };
    assert.equal((await deduplicate()).closed, 0);
    assert.equal(state.tabs.has(2), true);
    assert.equal(state.removed.length, 0);
  }
});

test('读取保留页期间候选才发生导航，最后复核阻止关闭', async () => {
  const { state, deduplicate } = fixture([{ id: 1 }, { id: 2 }]);
  state.onGet = id => { if (id === 1) state.tabs.get(2).url = 'https://other.test/'; };
  assert.equal((await deduplicate()).closed, 0);
  assert.equal(state.removed.length, 0);
});

test('用户切换焦点窗口但两个标签的active均未变化时，不沿用旧保留页', async () => {
  const { state, deduplicate } = fixture([{ id: 1, active: true }, { id: 2, windowId: 2, active: true }]);
  state.onGet = id => { if (id === 2) state.focusedWindow = 2; };
  assert.equal((await deduplicate()).closed, 0);
  assert.equal(state.removed.length, 0);
  assert.equal(state.tabs.size, 2);
});

test('候选或保留页最近访问时间发生变化但active恢复原值时不关闭', async () => {
  for (const changedId of [1, 2]) {
    const { state, deduplicate } = fixture([{ id: 1, lastAccessed: 200 }, { id: 2, lastAccessed: 100 }]);
    state.onGet = id => { if (id === changedId) state.tabs.get(id).lastAccessed = 300; };
    assert.equal((await deduplicate()).closed, 0);
    assert.equal(state.removed.length, 0);
  }
});

test('开始后无法再确认焦点窗口时不关闭，而首次不可用时仍可使用稳定保留规则', async () => {
  const { state, api } = fixture([{ id: 1 }, { id: 2 }]);
  let calls = 0;
  api.windows.getLastFocused = async () => {
    if (++calls > 1) throw Error('Focus unknown');
    return { id: 1, type: 'normal' };
  };
  assert.equal((await createDeduplicator(api)()).closed, 0);
  assert.equal(state.removed.length, 0);

  api.windows.getLastFocused = async () => { throw Error('Unsupported'); };
  assert.equal((await createDeduplicator(api)()).closed, 1);
});

test('连点共享同一在途任务，延迟关闭期间不重复发送删除', async () => {
  const { state, deduplicate } = fixture([{ id: 1 }, { id: 2 }]);
  let resolveRemove;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  state.onRemove = id => new Promise(resolve => {
    resolveRemove = () => { state.tabs.delete(id); resolve(); };
    entered();
  });
  const first = deduplicate();
  await started;
  const second = deduplicate();
  assert.equal(first, second);
  assert.deepEqual(state.removed, [2]);
  resolveRemove();
  assert.equal((await first).closed, 1);
  assert.equal((await second).closed, 1);
  assert.equal((await deduplicate()).closed, 0);
});

test('单次关闭失败后继续处理，最终数字根据实际存活情况返回', async () => {
  const { state, deduplicate } = fixture([{ id: 1 }, { id: 2 }, { id: 3 }]);
  state.onRemove = id => { if (id === 2) throw Error('Blocked'); state.tabs.delete(id); };
  assert.deepEqual(await deduplicate(), { closed: 1, skipped: 0, failed: 1, remaining: 1 });
  assert.equal(state.tabs.has(1), true);
});

test('remove已返回但标签仍存在，不误报为关闭成功', async () => {
  const { state, deduplicate } = fixture([{ id: 1 }, { id: 2 }]);
  state.onRemove = () => {};
  assert.deepEqual(await deduplicate(), { closed: 0, skipped: 1, failed: 0, remaining: 1 });
});

test('标签移到popup不等于已关闭，最终统计查询失败不得报告成功', async () => {
  const { state, deduplicate } = fixture([{ id: 1 }, { id: 2 }]);
  state.onRemove = id => { state.tabs.get(id).windowId = 3; };
  assert.deepEqual(await deduplicate(), { closed: 0, skipped: 1, failed: 0, remaining: 0 });

  const other = fixture([{ id: 1 }, { id: 2 }]);
  other.state.onQuery = () => { if (other.state.queryCalls === 2) throw Error('Read failed'); };
  await assert.rejects(other.deduplicate(), /无法确认最终状态/);
  other.state.onQuery = null;
  assert.equal((await other.deduplicate()).closed, 0);
});

test('运行中新增的标签不纳入当前关闭计划', async () => {
  const { state, deduplicate } = fixture([{ id: 1 }, { id: 2 }]);
  state.onRemove = id => {
    state.tabs.delete(id);
    state.tabs.set(3, { ...state.tabs.get(1), id: 3 });
  };
  assert.deepEqual(await deduplicate(), { closed: 1, skipped: 0, failed: 0, remaining: 1 });
  assert.equal(state.tabs.has(3), true);
});

test('宽松URL分桶后journal持久化，再次严格复核raw URL才允许关闭', async () => {
  const { state, api } = fixture([
    { id: 1, url: 'https://example.com/?id=1&utm=a' },
    { id: 2, url: 'https://example.com/?id=1&utm=b' },
  ]);
  const events = [];
  const journal = { begin: () => 'batch', async prepare(_batch, tab) {
    events.push(`prepare:${tab.id}`);
    state.tabs.get(tab.id).url = 'https://example.com/?id=1&utm=changed';
    return 'item';
  }, async settle(_batch, outcomes) { events.push(outcomes.get('item')); } };
  const deduplicate = createDeduplicator(api, { journal, getRules: async () => [
    { origin: 'https://example.com', ignoreParams: ['utm'] },
  ] });
  assert.deepEqual(await deduplicate(), { closed: 0, skipped: 1, failed: 0, remaining: 1 });
  assert.deepEqual(state.removed, []);
  assert.deepEqual(events, ['prepare:2', '页面仍存在，未记录为可恢复。']);
});

test('journal写入失败或容量已满时绝不关闭页面', async () => {
  const { state, api } = fixture([{ id: 1 }, { id: 2 }]);
  const journal = { begin: () => 'batch', async prepare() { throw Error('Journal full'); }, async settle() {} };
  const result = await createDeduplicator(api, { journal })();
  assert.equal(result.closed, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(state.removed, []);
});

test('journal后等待keeper或焦点期间候选导航，最终candidate复核阻止remove', async () => {
  const { state, api } = fixture([{ id: 1 }, { id: 2 }]);
  let afterPrepare = false;
  const journal = { begin: () => 'batch', async prepare() { afterPrepare = true; return 'item'; }, async settle() {} };
  state.onGet = id => {
    if (afterPrepare && id === 1) state.tabs.get(2).url = 'https://user.test/';
  };
  const result = await createDeduplicator(api, { journal })();
  assert.equal(result.closed, 0);
  assert.equal(state.removed.length, 0);
  assert.equal(state.tabs.get(2).url, 'https://user.test/');
});

test('预览返回固定候选，执行只处理显式选择且token一次性', async () => {
  const { state, api } = fixture([
    { id: 1, title: 'A1', url: 'https://a.test/' }, { id: 2, title: 'A2', url: 'https://a.test/' },
    { id: 3, title: 'B1', url: 'https://b.test/' }, { id: 4, title: 'B2', url: 'https://b.test/' },
  ]);
  const deduplicate = createDeduplicator(api);
  const preview = await deduplicate.preview({ scope: 'all' });
  assert.equal(preview.buckets.length, 2);
  assert.deepEqual(preview.summary, { buckets: 2, duplicates: 2, scope: 'all' });
  assert.deepEqual(Object.keys(preview.buckets[0].tabs[0]).sort(),
    ['active', 'audible', 'groupId', 'id', 'lastAccessed', 'pinned', 'title', 'url', 'windowId'].sort());
  const bucket = preview.buckets.find(item => item.url === 'https://a.test/');
  const result = await deduplicate({ token: preview.token, selections: [{ bucketId: bucket.id, keeperId: 2 }] });
  assert.equal(result.closed, 1);
  assert.deepEqual([...state.tabs.keys()], [2, 3, 4]);
  await assert.rejects(deduplicate({ token: preview.token, selections: [] }), /失效/);
});

test('预览范围不扩容，规则或allowlist变化后拒绝关闭', async () => {
  const base = fixture([
    { id: 1, windowId: 1 }, { id: 2, windowId: 1 },
    { id: 3, windowId: 2 }, { id: 4, windowId: 2 },
  ]);
  let rules = [];
  let allowlist = [];
  const deduplicate = createDeduplicator(base.api, { getRules: async () => rules, getAllowlist: async () => allowlist });
  const preview = await deduplicate.preview({ scope: 'window', windowId: 1 });
  assert.equal(preview.buckets[0].tabs.every(tab => tab.windowId === 1), true);
  rules = [{ origin: 'https://example.com', ignoreParams: ['utm'] }];
  await assert.rejects(deduplicate({ token: preview.token, selections: [{
    bucketId: preview.buckets[0].id, keeperId: preview.buckets[0].keeperId,
  }] }), /已经变化/);
  assert.equal(base.state.removed.length, 0);

  rules = [];
  allowlist = ['https://example.com'];
  const allowedPreview = await deduplicate.preview({ scope: 'all' });
  assert.equal(allowedPreview.buckets.length, 0);
});

test('执行复核拒绝非法keeper、过期token和预览后安全属性变化', async () => {
  let timestamp = 10;
  const invalid = fixture([{ id: 1 }, { id: 2 }]);
  const deduplicate = createDeduplicator(invalid.api, { now: () => timestamp });
  let preview = await deduplicate.preview();
  await assert.rejects(deduplicate({ token: preview.token, selections: [{
    bucketId: preview.buckets[0].id, keeperId: 999,
  }] }), /不属于/);
  assert.equal(invalid.state.removed.length, 0);

  preview = await deduplicate.preview();
  invalid.state.tabs.get(2).pinned = true;
  const unchanged = await deduplicate({ token: preview.token, selections: [{
    bucketId: preview.buckets[0].id, keeperId: preview.buckets[0].keeperId,
  }] });
  assert.equal(unchanged.closed, 0);
  assert.equal(invalid.state.removed.length, 0);

  invalid.state.tabs.get(2).pinned = false;
  preview = await deduplicate.preview();
  timestamp += 5 * 60 * 1000;
  await assert.rejects(deduplicate({ token: preview.token, selections: [] }), /失效/);
});

test('journal.prepare期间规则或allowlist变化会停止计划并结算记录但不删除', async () => {
  for (const change of ['rules', 'allowlist']) {
    const current = fixture([{ id: 1 }, { id: 2 }]);
    let rules = [];
    let allowlist = [];
    const settled = [];
    const journal = {
      begin: () => 'batch',
      async prepare(_batch, tab) {
        if (change === 'rules') rules = [{ origin: 'https://example.com', ignoreParams: ['utm'] }];
        else allowlist = ['https://example.com'];
        return `item-${tab.id}`;
      },
      async settle(_batch, outcomes) { settled.push([...outcomes]); },
    };
    const deduplicate = createDeduplicator(current.api, {
      journal, getRules: async () => rules, getAllowlist: async () => allowlist,
    });
    const preview = await deduplicate.preview();
    const bucket = preview.buckets[0];
    const result = await deduplicate({ token: preview.token, selections: [{
      bucketId: bucket.id, keeperId: bucket.keeperId,
    }] });
    assert.deepEqual(result, { closed: 0, skipped: 1, failed: 0, remaining: 1 });
    assert.deepEqual(current.state.removed, []);
    assert.equal(settled.length, 1);
    assert.match(settled[0][0][1], /页面仍存在/);
  }
});
