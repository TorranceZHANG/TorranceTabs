import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoGrouper, createReadingList } from '../grouping.js';
import { validateSettings } from '../rules.js';

function fixture(initialTabs, initialGroups = []) {
  const state = {
    tabs: new Map(initialTabs.map(tab => [tab.id, {
      url: 'https://example.com/one', windowId: 1, groupId: -1, pinned: false, ...tab,
    }])),
    groups: new Map(initialGroups.map(group => [group.id, { color: 'red', collapsed: true, ...group }])),
    data: { settings: validateSettings({ enabled: true, rules: [
      { prefix: 'https://example.com/', group: '工作', color: 'blue', enabled: true },
      { prefix: 'https://other.test/', group: '其他', color: 'green', enabled: true },
    ] }) },
    calls: [], nextGroup: 100,
  };
  const clone = value => structuredClone(value);
  const api = {
    storage: { local: {
      async get(defaults) { return clone({ ...defaults, ...state.data }); },
      async set(value) { Object.assign(state.data, clone(value)); },
    } },
    windows: { async get(id) { return { id, type: 'normal' }; } },
    tabs: {
      async get(id) {
        if (!state.tabs.has(id)) throw new Error('No tab');
        return clone(state.tabs.get(id));
      },
      async query({ windowId }) { return clone([...state.tabs.values()].filter(t => t.windowId === windowId)); },
      async group(options) {
        state.calls.push(clone(options));
        if (state.failGroup) { state.failGroup = false; throw new Error('Simulated tab closure'); }
        const id = options.groupId ?? state.nextGroup++;
        if (!state.groups.has(id)) state.groups.set(id, { id, title: '', windowId: options.createProperties.windowId });
        const group = state.groups.get(id);
        for (const tabId of options.tabIds) {
          const tab = state.tabs.get(tabId);
          if (!tab || tab.pinned) throw new Error('Invalid tab');
          tab.groupId = id;
          // Faithfully model the API's implicit cross-window move.
          tab.windowId = group.windowId;
        }
        return id;
      },
    },
    tabGroups: {
      async query({ windowId }) {
        const result = clone([...state.groups.values()].filter(g => g.windowId === windowId));
        if (state.afterQuery) await state.afterQuery();
        return result;
      },
      async get(id) {
        if (!state.groups.has(id)) throw new Error('No group');
        return clone(state.groups.get(id));
      },
      async update(id, properties) {
        const group = state.groups.get(id);
        if (!group) throw new Error('No group');
        Object.assign(group, clone(properties));
        return clone(group);
      },
    },
  };
  const errors = [];
  return { state, api, errors, engine: createAutoGrouper(api, error => errors.push(error)) };
}

test('同窗口并发标签复用一组，不同窗口独立创建', async () => {
  const { state, engine } = fixture([{ id: 1 }, { id: 2 }, { id: 3, windowId: 2 }]);
  assert.deepEqual(await Promise.all([1, 2, 3].map(id => engine.schedule(id))), ['grouped', 'grouped', 'grouped']);
  assert.equal(state.groups.size, 2);
  assert.equal(state.tabs.get(1).groupId, state.tabs.get(2).groupId);
  assert.notEqual(state.tabs.get(1).groupId, state.tabs.get(3).groupId);
  assert.equal(state.tabs.get(3).windowId, 2);
});

test('先无URL，提交地址后再次处理；不按pendingUrl提前分组', async () => {
  const { state, engine } = fixture([{ id: 1, url: 'about:blank', pendingUrl: 'https://example.com/' }]);
  assert.equal(await engine.schedule(1), 'skipped');
  state.tabs.get(1).url = 'https://example.com/one';
  assert.equal(await engine.schedule(1), 'grouped');
});

test('复用同名组，保留其颜色与折叠；重复同名时保持当前组', async () => {
  const { state, engine } = fixture([{ id: 1, groupId: 8 }], [
    { id: 7, title: '工作', windowId: 1 }, { id: 8, title: '工作', windowId: 1 },
  ]);
  assert.equal(await engine.schedule(1), 'unchanged');
  assert.equal(state.calls.length, 0);
  assert.equal(state.groups.get(8).color, 'red');
  assert.equal(state.groups.get(8).collapsed, true);
});

test('组名中的星号按字面处理，不当作pattern', async () => {
  const { state, engine } = fixture([{ id: 1 }], [{ id: 7, title: '工作abc', windowId: 1 }]);
  state.data.settings.rules[0].group = '工作*';
  await engine.schedule(1);
  assert.equal(state.groups.size, 2);
  assert.equal(state.groups.get(state.tabs.get(1).groupId).title, '工作*');
});

test('无匹配、固定、无痕、分屏、非普通窗口和已关闭标签跳过', async () => {
  const { state, engine, api } = fixture([
    { id: 1, url: 'https://no-match.test/', groupId: 99 }, { id: 2, pinned: true },
    { id: 3, incognito: true }, { id: 4, splitViewId: 12 }, { id: 5, windowId: 2 },
  ]);
  api.windows.get = async id => ({ id, type: id === 2 ? 'popup' : 'normal' });
  for (const id of [1, 2, 3, 4, 5, 6]) assert.equal(await engine.schedule(id), 'skipped');
  assert.equal(state.tabs.get(1).groupId, 99);
  assert.equal(state.calls.length, 0);
});

test('快速A→B导航只应用最新URL，等待中的旧事件不挪组', async () => {
  const { state, engine } = fixture([{ id: 1 }]);
  const first = engine.schedule(1);
  state.tabs.get(1).url = 'https://other.test/';
  const second = engine.schedule(1);
  assert.equal(await first, 'skipped');
  assert.equal(await second, 'grouped');
  assert.equal(state.groups.get(state.tabs.get(1).groupId).title, '其他');
});

test('查询期间关闭、固定、导航或跨窗移动时停止过期任务', async () => {
  for (const mutate of [
    state => state.tabs.delete(1),
    state => { state.tabs.get(1).pinned = true; },
    state => { state.tabs.get(1).url = 'https://other.test/'; },
    state => { state.tabs.get(1).windowId = 2; },
  ]) {
    const { state, engine } = fixture([{ id: 1 }], [{ id: 7, title: '工作', windowId: 1 }]);
    state.afterQuery = () => mutate(state);
    assert.equal(await engine.schedule(1), 'skipped');
    assert.equal(state.calls.length, 0);
  }
});

test('目标组在查询后删除、改名或移窗时不调用分组', async () => {
  for (const mutate of [
    state => state.groups.delete(7),
    state => { state.groups.get(7).title = '用户重命名'; },
    state => { state.groups.get(7).windowId = 2; },
  ]) {
    const { state, engine } = fixture([{ id: 1 }], [{ id: 7, title: '工作', windowId: 1 }]);
    state.afterQuery = () => mutate(state);
    assert.equal(await engine.schedule(1), 'skipped');
    assert.equal(state.calls.length, 0);
    assert.equal(state.tabs.get(1).windowId, 1);
  }
});

test('规则变动使在途任务失效，并按新设置重排', async () => {
  const { state, engine } = fixture([{ id: 1 }]);
  let retry;
  state.afterQuery = () => {
    state.afterQuery = null;
    state.data.settings.rules[0].group = '新组';
    engine.settingsChanged();
    retry = engine.schedule(1);
  };
  assert.equal(await engine.schedule(1), 'skipped');
  assert.equal(await retry, 'grouped');
  assert.equal(state.groups.get(state.tabs.get(1).groupId).title, '新组');
});

test('关闭自动分组阻止在途任务及手动整理', async () => {
  const { state, engine } = fixture([{ id: 1 }]);
  state.afterQuery = () => {
    state.data.settings.enabled = false;
    engine.settingsChanged();
  };
  assert.equal(await engine.schedule(1), 'skipped');
  assert.equal(state.calls.length, 0);
  await assert.rejects(engine.applyWindow(1), /启用/);
});

test('一个API失败后队列继续，整理返回准确统计', async () => {
  const { state, engine, errors } = fixture([{ id: 1 }, { id: 2 }, { id: 3, pinned: true }]);
  state.failGroup = true;
  assert.deepEqual(await engine.applyWindow(1), { grouped: 1, skipped: 1, failed: 1 });
  assert.equal(errors.length, 1);
  assert.equal(state.tabs.get(2).groupId, 100);
});

test('Worker重建后现查已有组，不依赖持久化groupId', async () => {
  const { state, api, engine } = fixture([{ id: 1 }, { id: 2 }]);
  await engine.schedule(1);
  const restarted = createAutoGrouper(api);
  await restarted.schedule(2);
  assert.equal(state.groups.size, 1);
  assert.equal(state.tabs.get(1).groupId, state.tabs.get(2).groupId);
});

test('共享组中的标签不被移出，即使存在本地同名组或规则指向其他组', async () => {
  for (const title of ['工作', '协作组']) {
    const { state, engine } = fixture([{ id: 1, groupId: 7 }], [
      { id: 7, title, windowId: 1, shared: true },
      { id: 8, title: '工作', windowId: 1 },
    ]);
    assert.equal(await engine.schedule(1), 'skipped');
    assert.equal(state.tabs.get(1).groupId, 7);
    assert.equal(state.calls.length, 0);
    assert.deepEqual(await engine.applyWindow(1), { grouped: 0, skipped: 1, failed: 0 });
  }
});

test('仅有同名共享组时跳过，有本地同名组时只复用本地组', async () => {
  const { state, engine } = fixture([{ id: 1 }], [{ id: 7, title: '工作', windowId: 1, shared: true }]);
  assert.equal(await engine.schedule(1), 'skipped');
  assert.equal(state.groups.size, 1);
  state.groups.set(8, { id: 8, title: '工作', windowId: 1 });
  assert.equal(await engine.schedule(1), 'grouped');
  assert.equal(state.tabs.get(1).groupId, 8);
});

test('源组或目标组在查询后变成共享组时跳过', async () => {
  for (const id of [7, 8]) {
    const { state, engine } = fixture([{ id: 1, groupId: 7 }], [
      { id: 7, title: '旧组', windowId: 1 }, { id: 8, title: '工作', windowId: 1 },
    ]);
    state.afterQuery = () => { state.groups.get(id).shared = true; };
    assert.equal(await engine.schedule(1), 'skipped');
    assert.equal(state.calls.length, 0);
  }
});

test('等待时手动换组，不覆盖用户刚做的操作', async () => {
  const { state, engine } = fixture([{ id: 1 }], [{ id: 8, title: '工作', windowId: 1 }]);
  state.afterQuery = () => { state.tabs.get(1).groupId = 9; };
  assert.equal(await engine.schedule(1), 'skipped');
  assert.equal(state.tabs.get(1).groupId, 9);
  assert.equal(state.calls.length, 0);
});

test('稍后读并发保存不丢更新，同URL去重，删除按id，错误不阻塞', async () => {
  const { api, state } = fixture([]);
  const update = createReadingList(api);
  const save = url => update({ type: 'SAVE_READING_ITEM', item: { url, title: '页面' } });
  await Promise.all([save('https://a.test/'), save('https://b.test/'), save('https://a.test/')]);
  assert.equal(state.data.readingList.length, 2);
  await assert.rejects(save('javascript:alert(1)'), /HTTP/);
  await save('https://c.test/');
  const id = state.data.readingList[1].id;
  await update({ type: 'REMOVE_READING_ITEM', id });
  assert.equal(state.data.readingList.length, 2);
  assert.equal(state.data.readingList.some(item => item.id === id), false);
});

test('稍后读新写入遵守标题与数量上限，旧超限数据仍可移除', async () => {
  const { api, state } = fixture([]);
  const update = createReadingList(api);
  await assert.rejects(update({ type: 'SAVE_READING_ITEM', item: {
    url: 'https://new.test/', title: 'x'.repeat(301),
  } }), /300/);
  state.data.readingList = Array.from({ length: 2001 }, (_, index) => ({
    id: `legacy-${index}`, url: `https://legacy.test/${index}`, title: '旧条目', savedAt: index,
  }));
  await assert.rejects(update({ type: 'SAVE_READING_ITEM', item: {
    url: 'https://new.test/', title: '新条目',
  } }), /2000/);
  await update({ type: 'REMOVE_READING_ITEM', id: 'legacy-0' });
  assert.equal(state.data.readingList.length, 2000);
});
