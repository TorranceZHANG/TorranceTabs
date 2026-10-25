import test from 'node:test';
import assert from 'node:assert/strict';

const URL = 'https://example.com/docs';
const event = () => {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
};
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
let sequence = 0;

async function fixture(t) {
  const state = { tabs: new Map([[1, { id: 1, windowId: 1, groupId: -1, url: URL }],
    [2, { id: 2, windowId: 1, groupId: -1, url: 'about:blank' }]]), session: {}, groups: new Map(), overlays: new Map(), calls: [], reads: 0 };
  const clone = value => structuredClone(value);
  const api = {
    storage: { onChanged: event(),
      local: { async get(defaults) { return clone({ ...defaults, settings: { enabled: true, duplicatePromptEnabled: true,
        rules: [{ prefix: 'https://example.com/', group: '工作', color: 'blue', enabled: true }] } }); },
        async set(values) { state.calls.push({ type: 'local-set', values: clone(values) }); } },
      session: { async get(defaults) { return clone({ ...defaults, ...state.session }); },
        async set(values) { Object.assign(state.session, clone(values)); } },
    },
    permissions: { onRemoved: event(), async contains() { return true; } },
    scripting: { async executeScript({ target }) {
      return [{ frameId: 0, documentId: `doc-${target.tabId}`, result: { url: state.tabs.get(target.tabId).url, ready: true } }];
    } },
    tabs: {
      onCreated: event(), onUpdated: event(), onDetached: event(), onAttached: event(), onRemoved: event(), onReplaced: event(),
      async get(id) {
        if (id === 2) {
          state.reads++;
          const override = state.onSourceGet && await state.onSourceGet(state.reads);
          if (override) return clone(override);
        }
        if (!state.tabs.has(id)) throw Error('No tab');
        return clone(state.tabs.get(id));
      },
      async query(options = {}) { return clone([...state.tabs.values()].filter(tab =>
        (!options.windowType || tab.windowId === 1) && (options.windowId === undefined || options.windowId === tab.windowId))); },
      async update(id, values) { Object.assign(state.tabs.get(id), values); return clone(state.tabs.get(id)); },
      async remove(id) { state.calls.push({ type: 'remove', id }); if (state.onRemove) await state.onRemove(id); state.tabs.delete(id); },
      async sendMessage(id, message) {
        if (message.type === 'INLINE_DUPLICATE_SHOW') {
          state.calls.push({ type: 'inline', id });
          state.overlays.set(id, { token: message.token, url: message.url });
          return { shown: true };
        }
        if (message.type === 'INLINE_DUPLICATE_HIDE') { state.overlays.delete(id); return { hidden: true }; }
        return state.overlays.get(id) || { token: null };
      },
      async group(options) {
        state.calls.push({ type: 'group', options });
        const id = options.groupId ?? 8;
        for (const tabId of [options.tabIds].flat()) state.tabs.get(tabId).groupId = id;
        if (!state.groups.has(id)) state.groups.set(id, { id, windowId: 1 });
        return id;
      },
    },
    tabGroups: {
      async query() { if (state.onGroupQuery) await state.onGroupQuery(); return clone([...state.groups.values()]); },
      async get(id) { if (!state.groups.has(id)) throw Error('No group'); return clone(state.groups.get(id)); },
      async update(id, values) { Object.assign(state.groups.get(id), values); return clone(state.groups.get(id)); },
    },
    windows: {
      async get(id) { return { id, type: id === 1 ? 'normal' : 'popup' }; },
      async create(options) {
        state.calls.push({ type: 'popup', options });
        const tab = { id: 10, windowId: 10, url: options.url, groupId: -1 };
        state.tabs.set(10, tab);
        return { id: 10, type: 'popup', tabs: [clone(tab)] };
      },
    },
    runtime: { id: 'integration', getURL: file => `chrome-extension://integration/${file}`,
      onInstalled: event(), onMessage: event(), async openOptionsPage() {} },
    action: { onClicked: event(), async setBadgeText(value) { state.badge = value.text; },
      async setBadgeBackgroundColor() {}, async setTitle(value) { state.actionTitle = value.title; } },
    commands: { onCommand: event() },
  };
  const previous = globalThis.chrome;
  globalThis.chrome = api;
  t.after(() => { globalThis.chrome = previous; });
  await import(`../background.js?integration=${++sequence}`);
  return { state, api };
}

test('旧创建事件延迟返回blank后，不能覆盖较新重复事件的分组抑制', async t => {
  const { state, api } = await fixture(t);
  const observed = gate();
  const resume = gate();
  state.onSourceGet = async count => {
    if (count !== 2) return;
    const snapshot = structuredClone(state.tabs.get(2));
    observed.resolve();
    await resume.promise;
    return snapshot;
  };
  api.tabs.onCreated.emit({ id: 2 });
  await observed.promise;
  state.tabs.get(2).url = URL;
  api.tabs.onUpdated.emit(2, { url: URL });
  resume.resolve();
  await settle();
  assert.equal(state.calls.filter(call => call.type === 'inline').length, 1);
  assert.equal(state.calls.some(call => call.type === 'popup'), false);
  assert.equal(state.calls.some(call => call.type === 'group'), false);
  assert.equal(state.tabs.get(2).groupId, -1);
  assert.equal(state.session.inlineDuplicateState.watch[2].stage, 'prompt');
});

test('新重复事件入口立即使已经在途的旧自动分组失效', async t => {
  const { state, api } = await fixture(t);
  const grouping = gate();
  const resume = gate();
  state.onSourceGet = count => { if (count === 3) state.tabs.get(2).url = URL; };
  state.onGroupQuery = async () => { grouping.resolve(); await resume.promise; };
  api.tabs.onCreated.emit({ id: 2 });
  await grouping.promise;
  api.tabs.onUpdated.emit(2, { url: URL });
  await settle();
  assert.equal(state.calls.filter(call => call.type === 'inline').length, 1);
  resume.resolve();
  await settle();
  assert.equal(state.calls.some(call => call.type === 'group'), false);
  assert.equal(state.tabs.get(2).groupId, -1);
  assert.equal(state.session.inlineDuplicateState.watch[2].stage, 'prompt');
});

test('popup失效的旧事件结果仍释放源，后续popup事件不丢失分组恢复', async t => {
  const { state, api } = await fixture(t);
  state.tabs.get(2).url = URL;
  const token = 'popup-11111111-1111-1111-1111-111111111111';
  state.session.duplicatePopupState = { watch: { 2: { stage: 'prompt', token } }, prompts: {
    [token]: { source: { id: 2, windowId: 1, groupId: -1 }, url: URL, phase: 'prompt', popupTabId: 10, popupWindowId: 10 },
  } };
  state.tabs.set(10, { id: 10, windowId: 10, groupId: -1, url: `chrome-extension://integration/duplicate.html#${token}` });
  state.tabs.get(10).url = 'https://elsewhere.test/';
  api.tabs.onUpdated.emit(10, { url: state.tabs.get(10).url });
  api.tabs.onUpdated.emit(10, { status: 'complete' });
  await settle();
  assert.deepEqual(state.session.duplicatePopupState, { watch: {}, prompts: {} });
  assert.equal(state.tabs.get(2).groupId, 8);
  assert.equal(state.tabs.get(10).url, 'https://elsewhere.test/');
  assert.equal(state.calls.filter(call => call.type === 'group').length, 1);
});

test('页内保留消息清理浮层并恢复源分组，不创建窗口或改变活跃标签', async t => {
  const { state, api } = await fixture(t);
  state.tabs.get(2).url = URL;
  api.tabs.onCreated.emit({ id: 2 });
  await settle();
  const token = state.session.inlineDuplicateState.watch[2].token;
  const result = await new Promise(resolve => api.runtime.onMessage.emit(
    { type: 'INLINE_DUPLICATE_CHOOSE', token, choice: 'keep' },
    { id: 'integration', tab: { id: 2 }, frameId: 0, documentId: 'doc-2', url: URL }, resolve));
  await settle();
  assert.equal(result.action, 'kept');
  assert.equal(state.tabs.get(2).groupId, 8);
  assert.deepEqual(state.session.inlineDuplicateState, { watch: {}, prompts: {} });
  assert.equal(state.overlays.has(2), false);
  assert.equal(state.calls.some(call => call.type === 'popup'), false);
});

test('快捷键与面板共享真实去重任务，GET状态不被原生关闭等待阻塞', async t => {
  const { state, api } = await fixture(t);
  state.tabs.get(2).url = URL;
  const issued = gate();
  const resume = gate();
  state.onRemove = async () => { issued.resolve(); await resume.promise; };
  api.commands.onCommand.emit('unrelated-command');
  await settle();
  assert.equal(state.calls.some(call => call.type === 'remove'), false);
  api.commands.onCommand.emit('deduplicate-tabs');
  await issued.promise;
  const request = type => new Promise(resolve => api.runtime.onMessage.emit({ type }, { id: 'integration' }, resolve));
  const running = await request('GET_CLEANUP_STATUS');
  assert.equal(running.status.state, 'running');
  assert.equal(running.status.origin, 'shortcut');
  const panel = request('DEDUPLICATE_TABS');
  await settle();
  assert.equal(state.calls.filter(call => call.type === 'remove').length, 1);
  resume.resolve();
  assert.equal((await panel).closed, 1);
  assert.equal((await request('GET_CLEANUP_STATUS')).status.state, 'done');
  assert.equal(state.badge, '1');
});

test('新privileged消息只允许可信扩展页面，content script不能导出或写配置', async t => {
  const { state, api } = await fixture(t);
  const settings = { enabled: false, duplicatePromptEnabled: true, rules: [] };
  const send = sender => new Promise(resolve => api.runtime.onMessage.emit({ type: 'SAVE_SETTINGS', settings }, sender, resolve));
  const rejected = await send({ id: 'integration', url: 'https://example.com/page', tab: { id: 1 } });
  assert.equal(rejected.ok, false);
  assert.equal(state.calls.some(call => call.type === 'local-set'), false);
  const accepted = await send({ id: 'integration', url: 'chrome-extension://integration/settings.html' });
  assert.equal(accepted.ok, true);
  assert.equal(state.calls.filter(call => call.type === 'local-set').length, 1);
  const discard = sender => new Promise(resolve => api.runtime.onMessage.emit({ type: 'UNDO_DISCARD' }, sender, resolve));
  assert.equal((await discard({ id: 'integration', url: 'https://example.com/page', tab: { id: 1 } })).ok, false);
  assert.deepEqual(await discard({ id: 'integration', url: 'chrome-extension://integration/tools.html' }), { ok: true, discarded: 0 });
});
