import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryService } from '../library-service.js';
import { createOperationLock } from '../operation-lock.js';

function fixture(library) {
  const state = { library: structuredClone(library), tabs: new Map(), windows: new Map([[1, { id: 1, type: 'normal' }], [2, { id: 2, type: 'normal' }]]),
    groups: new Map(), calls: [], nextTab: 20, nextWindow: 10, nextGroup: 30 };
  const api = { runtime: { getManifest: () => ({ version: '1.6.0' }) }, tabs: {
    async query(options = {}) { return structuredClone([...state.tabs.values()].filter(tab =>
      (options.windowId === undefined || tab.windowId === options.windowId)
      && (!options.windowType || state.windows.get(tab.windowId)?.type === options.windowType))); },
    async create(values) { const tab = { id: state.nextTab++, windowId: values.windowId || 1, groupId: -1, index: 0,
      pinned: Boolean(values.pinned), url: values.url, title: '' }; state.tabs.set(tab.id, tab); state.calls.push(['create', tab.id, values]); return { ...tab }; },
    async get(id) { if (state.beforeGet) await state.beforeGet(id); if (!state.tabs.has(id)) throw Error('missing'); return { ...state.tabs.get(id) }; },
    async update(id, values) {
      state.calls.push(['update', id, values]);
      const tab = state.tabs.get(id);
      if (state.pendingNavigation && typeof values.url === 'string') {
        Object.assign(tab, { ...values, url: tab.url, pendingUrl: values.url, status: 'loading' });
      } else Object.assign(tab, values);
      return { ...tab };
    },
    async group(values) { state.calls.push(['group', structuredClone(values)]); const groupId = values.groupId ?? state.nextGroup++; for (const id of values.tabIds) state.tabs.get(id).groupId = groupId;
      if (!state.groups.has(groupId)) state.groups.set(groupId, { id: groupId, windowId: values.createProperties.windowId, shared: false }); return groupId; },
  }, windows: {
    async get(id) { if (!state.windows.has(id)) throw Error('missing'); return { ...state.windows.get(id) }; },
    async getLastFocused() { if (!state.windows.has(state.focusedWindowId ?? 1)) throw Error('missing'); return { ...state.windows.get(state.focusedWindowId ?? 1) }; },
    async getAll({ windowTypes } = {}) { return [...state.windows.values()].filter(window => !windowTypes || windowTypes.includes(window.type)).map(window => ({ ...window })); },
    async update(id, values) { state.calls.push(['focus', id, values]); return { ...state.windows.get(id), ...values }; },
    async create(values) { const windowId = state.nextWindow++; const tab = { id: state.nextTab++, windowId, groupId: -1, index: 0,
      pinned: false, url: values.url, title: '' }; state.windows.set(windowId, { id: windowId, type: 'normal' }); state.tabs.set(tab.id, tab);
      state.calls.push(['window', windowId, values]); return { id: windowId, type: 'normal', tabs: [{ ...tab }] }; },
  }, tabGroups: {
    async query() { return structuredClone([...state.groups.values()]); },
    async get(id) { if (!state.groups.has(id)) throw Error('missing group'); return { ...state.groups.get(id) }; },
    async update(id, values) { Object.assign(state.groups.get(id), values); },
  } };
  const store = { async getLibrary() { return structuredClone(state.library); }, async updateLibrary(change) {
    state.library = await change(structuredClone(state.library)); state.library.revision += 1; return state.library;
  } };
  const undo = { async getUndo() { return { items: [] }; } };
  const suppression = { async plan(url) { state.calls.push(['plan', url]); return `token-${state.calls.length}`; },
    async claim(id, _blank, token) {
      const tabId = typeof id === 'object' ? id.id : id;
      state.calls.push(['claim', tabId, token]);
      if (state.claimResult !== false) { if (!state.claimed) state.claimed = new Set(); state.claimed.add(tabId); return true; }
      return false;
    },
    async verify(tab) {
      if (state.navigateAfterClaim) state.tabs.get(tab.id).url = 'https://user.test/';
      return state.verifyResult !== false && state.tabs.get(tab.id)?.url === 'about:blank';
    },
    async contains(tab) { return Boolean(state.claimed?.has(tab.id)); }, async cancel() {} };
  return { state, service: createLibraryService(api, store, undo, suppression, createOperationLock()) };
}
const empty = () => ({ schemaVersion: 1, revision: 0, favorites: [null, null, null], dedupRules: [], workspaces: [] });

test('常用入口跨普通窗口复用安全标签，共享标签不作为复用目标', async () => {
  const library = empty(); library.favorites[0] = { name: '入口', url: 'https://fav.test/' };
  const { state, service } = fixture(library);
  state.tabs.set(1, { id: 1, windowId: 1, groupId: 7, url: 'https://fav.test/' });
  state.groups.set(7, { id: 7, windowId: 1, shared: true });
  assert.equal((await service.openFavorite(1)).action, 'created');
  state.tabs.set(2, { id: 2, windowId: 2, groupId: -1, url: 'https://fav.test/' });
  const result = await service.openFavorite(1);
  assert.deepEqual(result, { action: 'focused', tabId: 2, windowId: 2 });
  assert.ok(state.calls.some(call => call[0] === 'focus' && call[1] === 2));
});

test('常用入口只在显式复核的普通非无痕窗口创建，没有安全窗口时新建普通窗口', async () => {
  const library = empty(); library.favorites[0] = { name: '入口', url: 'https://fav.test/' };
  const existing = fixture(library);
  existing.state.windows.set(1, { id: 1, type: 'normal', incognito: true });
  existing.state.windows.set(2, { id: 2, type: 'normal', incognito: false });
  existing.state.focusedWindowId = 1;
  const created = await existing.service.openFavorite(1);
  assert.equal(created.windowId, 2);
  assert.equal(existing.state.calls.find(call => call[0] === 'create')[2].windowId, 2);
  assert.equal(existing.state.calls.some(call => call[0] === 'window'), false);

  const isolated = fixture(library);
  isolated.state.windows.set(1, { id: 1, type: 'normal', incognito: true });
  isolated.state.windows.set(2, { id: 2, type: 'popup', incognito: false });
  isolated.state.focusedWindowId = 1;
  const fresh = await isolated.service.openFavorite(1);
  assert.equal(fresh.windowId, 10);
  const createWindow = isolated.state.calls.find(call => call[0] === 'window');
  assert.deepEqual(createWindow[2], { type: 'normal', incognito: false, url: 'https://fav.test/', focused: true });
  assert.equal(isolated.state.calls.some(call => call[0] === 'create'), false);
});

test('工作区保存跳过受保护页，恢复精确复用且重试不制造重复或移动已有页', async () => {
  const library = empty();
  const { state, service } = fixture(library);
  state.tabs.set(1, { id: 1, windowId: 1, groupId: -1, index: 0, url: 'https://keep.test/', title: '保留' });
  state.tabs.set(2, { id: 2, windowId: 1, groupId: 8, index: 1, url: 'https://skip.test/', title: '共享' });
  state.groups.set(8, { id: 8, windowId: 1, shared: true });
  const saved = await service.saveWorkspace({ name: '我的工作区', scope: 'current', windowId: 1 });
  assert.equal(saved.saved, 1);
  assert.equal(saved.skipped, 1);
  const workspace = state.library.workspaces[0];
  workspace.windows[0].tabs.push({ ...workspace.windows[0].tabs[0] });
  workspace.windows[0].tabs.push({ url: 'https://new.test/', title: '新页', pinned: true, index: 2,
    group: { key: 'g', title: '恢复组', color: 'blue', collapsed: true } });
  const existingSnapshot = { ...state.tabs.get(1) };
  const first = await service.restoreWorkspace(workspace.id);
  assert.equal(first.reused, 2);
  assert.equal(first.restored, 1);
  assert.deepEqual(state.tabs.get(1), existingSnapshot);
  assert.equal([...state.tabs.values()].filter(tab => tab.url === 'https://new.test/').length, 1);
  assert.ok(state.calls.findIndex(call => call[0] === 'claim') < state.calls.findIndex(call => call[0] === 'update' && call[2].url === 'https://new.test/'));
  const second = await service.restoreWorkspace(workspace.id);
  assert.equal(second.restored, 0);
  assert.equal([...state.tabs.values()].filter(tab => tab.url === 'https://new.test/').length, 1);
});

test('工作区新页在分组前被导航或移动时不覆盖用户状态', async () => {
  const library = empty();
  library.workspaces.push({ id: 'w', name: '恢复', savedAt: 1, windows: [{ tabs: [
    { url: 'https://new.test/', title: '新页', pinned: false, index: 0,
      group: { key: 'g', title: '恢复组', color: 'blue', collapsed: false } },
  ] }] });
  const { state, service } = fixture(library);
  let changed = false;
  state.beforeGet = id => {
    const tab = state.tabs.get(id);
    if (!changed && tab?.url === 'https://new.test/') {
      changed = true;
      tab.url = 'https://user.test/';
      tab.windowId = 1;
    }
  };
  const result = await service.restoreWorkspace('w');
  assert.equal(result.restored, 1);
  assert.equal(result.failed, 1);
  assert.equal([...state.groups.values()].length, 0);
  assert.equal([...state.tabs.values()].find(tab => tab.url === 'https://user.test/').groupId, -1);
});

test('工作区恢复登记失败时保留空白页且绝不导航目标网址', async () => {
  const library = empty();
  library.workspaces.push({ id: 'w', name: '恢复', savedAt: 1, windows: [{ tabs: [
    { url: 'https://secret.test/', title: '目标', pinned: false, index: 0, group: null },
  ] }] });
  const { state, service } = fixture(library);
  state.claimResult = false;
  const result = await service.restoreWorkspace('w');
  assert.equal(result.restored, 0);
  assert.equal(result.failed, 1);
  assert.equal([...state.tabs.values()].some(tab => tab.url === 'https://secret.test/'), false);
  assert.equal([...state.tabs.values()].some(tab => tab.url === 'about:blank'), true);
});

test('工作区允许受控空白页正在导航目标时恢复分组，但拒绝异URL pending', async () => {
  const makeLibrary = () => ({ ...empty(), workspaces: [{ id: 'w', name: '恢复', savedAt: 1, windows: [{ tabs: [
    { url: 'https://target.test/', title: '目标', pinned: false, index: 0,
      group: { key: 'g', title: '恢复组', color: 'blue', collapsed: false } },
  ] }] }] });
  const allowed = fixture(makeLibrary());
  allowed.state.pendingNavigation = true;
  const restored = await allowed.service.restoreWorkspace('w');
  assert.equal(restored.failed, 0);
  const allowedTab = [...allowed.state.tabs.values()].find(tab => tab.pendingUrl === 'https://target.test/');
  assert.equal(allowedTab.url, 'about:blank');
  assert.equal(allowedTab.status, 'loading');
  assert.ok(allowedTab.groupId >= 0);
  const retried = await allowed.service.restoreWorkspace('w');
  assert.equal(retried.restored, 0);
  assert.equal(retried.reused, 1);
  assert.equal([...allowed.state.tabs.values()].filter(tab => tab.pendingUrl === 'https://target.test/').length, 1);

  const rejected = fixture(makeLibrary());
  rejected.state.pendingNavigation = true;
  rejected.state.beforeGet = id => {
    const tab = rejected.state.tabs.get(id);
    if (tab?.pendingUrl === 'https://target.test/') tab.pendingUrl = 'https://other.test/';
  };
  const changed = await rejected.service.restoreWorkspace('w');
  assert.equal(changed.failed, 1);
  assert.equal([...rejected.state.groups.values()].length, 0);
});

test('工作区claim持久化期间用户离开空白页时不覆盖为恢复目标', async () => {
  const library = { ...empty(), workspaces: [{ id: 'w', name: '恢复', savedAt: 1, windows: [{ tabs: [
    { url: 'https://target.test/', title: '目标', pinned: false, index: 0, group: null },
  ] }] }] };
  const { state, service } = fixture(library);
  state.navigateAfterClaim = true;
  const result = await service.restoreWorkspace('w');
  assert.equal(result.failed, 1);
  assert.equal(state.calls.some(call => call[0] === 'update' && call[2].url === 'https://target.test/'), false);
  assert.equal([...state.tabs.values()].some(tab => tab.url === 'https://user.test/'), true);
});

test('同组标签逐个入组，检查后续标签期间前页变化不会被隐式搬回', async () => {
  const group = { key: 'g', title: '恢复组', color: 'blue', collapsed: false };
  const library = { ...empty(), workspaces: [{ id: 'w', name: '恢复', savedAt: 1, windows: [{ tabs: [
    { url: 'https://a.test/', title: 'A', pinned: false, index: 0, group },
    { url: 'https://b.test/', title: 'B', pinned: false, index: 1, group },
  ] }] }] };
  const { state, service } = fixture(library);
  let firstId = null;
  state.beforeGet = id => {
    const tab = state.tabs.get(id);
    if (tab?.url === 'https://a.test/') firstId = id;
    if (tab?.url === 'https://b.test/' && firstId !== null) {
      Object.assign(state.tabs.get(firstId), { url: 'https://user.test/', windowId: 2, groupId: -1 });
    }
  };
  const result = await service.restoreWorkspace('w');
  assert.equal(result.failed, 0);
  const first = state.tabs.get(firstId);
  assert.equal(first.url, 'https://user.test/');
  assert.equal(first.windowId, 2);
  assert.equal(first.groupId, -1);
  assert.ok([...state.tabs.values()].find(tab => tab.url === 'https://b.test/').groupId >= 0);
  assert.deepEqual(state.calls.filter(call => call[0] === 'group').map(call => call[1].tabIds.length), [1, 1]);
});
