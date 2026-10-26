import test from 'node:test';
import assert from 'node:assert/strict';
import { createInlineDuplicateGuard } from '../inline-duplicate-guard.js';

const URL = 'https://example.com/page?q=1#part';
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(tabs = [{ id: 1, url: URL }, { id: 2, url: URL }], options = {}) {
  const state = { tabs: new Map(tabs.map(tab => [tab.id, { windowId: 1, groupId: -1, pinned: false, title: `页面 ${tab.id}`, ...tab }])),
    windows: new Map([[1, { id: 1, type: 'normal' }], [2, { id: 2, type: 'normal' }], [3, { id: 3, type: 'popup' }]]),
    docs: new Map(tabs.map(tab => [tab.id, `doc-${tab.id}`])), groups: new Map(), overlays: new Map(), calls: [], released: [], granted: true,
    session: {}, local: { settings: { enabled: false, duplicatePromptEnabled: true, rules: [] } } };
  const clone = value => structuredClone(value);
  const area = name => ({ async get(defaults) { return clone({ ...defaults, ...state[name] }); },
    async set(values) { if (name === 'session' && state.onSave) await state.onSave(values); Object.assign(state[name], clone(values)); } });
  const api = {
    runtime: { id: 'unit', getURL: file => `chrome-extension://unit/${file}` },
    storage: { session: area('session'), local: area('local') },
    permissions: { async contains() { return state.granted; } },
    scripting: { async executeScript(injection) {
      state.calls.push({ type: 'inject', injection });
      const id = injection.target.tabId;
      const result = [{ frameId: 0, documentId: state.docs.get(id), result: { url: state.tabs.get(id)?.url, ready: !state.noDOM } }];
      if (state.onInject) await state.onInject(id);
      if (state.injectError) throw Error('Restricted site');
      return result;
    } },
    tabs: {
      async get(id) { if (state.onGet) await state.onGet(id); if (!state.tabs.has(id)) throw Error('No tab'); return clone(state.tabs.get(id)); },
      async query(options = {}) { return clone([...state.tabs.values()].filter(tab => !options.windowType || state.windows.get(tab.windowId)?.type === options.windowType)); },
      async update(id, values) { state.calls.push({ type: 'update', id, ...values }); if (state.onUpdate) await state.onUpdate(id, values);
        if (!state.tabs.has(id)) throw Error('No tab'); Object.assign(state.tabs.get(id), values); return clone(state.tabs.get(id)); },
      async remove(id) { state.calls.push({ type: 'remove', id }); if (state.onRemove && await state.onRemove(id) === false) return; state.tabs.delete(id); },
      async sendMessage(id, message, options) {
        state.calls.push({ type: 'message', id, message, options });
        if (state.onMessage) await state.onMessage(id, message);
        if (!state.tabs.has(id) || options?.documentId !== state.docs.get(id)) throw Error('Document changed');
        if (message.type === 'INLINE_DUPLICATE_SHOW') {
          state.overlays.set(id, { token: message.token, url: message.url }); return { shown: true };
        }
        if (message.type === 'INLINE_DUPLICATE_HIDE') {
          if (state.overlays.get(id)?.token === message.token) state.overlays.delete(id);
          return { hidden: true };
        }
        return clone(state.overlays.get(id) || { token: null, url: state.tabs.get(id).url });
      },
    },
    windows: { async get(id) { if (!state.windows.has(id)) throw Error('No window'); return clone(state.windows.get(id)); },
      async create() { state.calls.push({ type: 'create' }); throw Error('Must not create windows'); },
      async update(id, values) { state.calls.push({ type: 'focus', id, ...values }); if (state.onFocus) await state.onFocus(id); return clone(state.windows.get(id)); } },
    tabGroups: { async get(id) { if (!state.groups.has(id)) throw Error('No group'); return clone(state.groups.get(id)); } },
  };
  const release = id => { state.released.push(id); };
  const guard = createInlineDuplicateGuard(api, release, options);
  const record = () => Object.entries(state.session.inlineDuplicateState?.prompts || {})[0];
  const message = (choice = 'switch') => ({ token: record()[0], choice });
  const sender = (id = 2) => ({ id: 'unit', tab: { id }, frameId: 0, documentId: state.docs.get(id), url: state.tabs.get(id).url, documentLifecycle: 'active' });
  const start = async () => { assert.equal(await guard.created({ id: 2 }), true); await settle(); };
  return { state, api, guard, message, sender, record, start, release };
}

test('重复页内SHOW不创建窗口、不改URL、不激活标签或焦点，隔离顶层注入并绑定文档', async () => {
  const { state, start, record } = fixture();
  await start();
  assert.equal(record()[1].phase, 'shown');
  assert.equal(record()[1].documentId, 'doc-2');
  const injection = state.calls.find(call => call.type === 'inject').injection;
  assert.deepEqual(injection.target, { tabId: 2, frameIds: [0] });
  assert.equal(injection.world, 'ISOLATED');
  assert.equal(injection.injectImmediately, true);
  assert.deepEqual(injection.files, ['inline-prompt.js']);
  assert.equal(state.overlays.has(2), true);
  assert.equal(state.tabs.get(2).url, URL);
  assert.equal(state.calls.some(call => ['create', 'focus', 'update', 'remove'].includes(call.type)), false);
  assert.equal(state.local.inlineDuplicateState, undefined);
});

test('未授权、关闭开关、受限站点均保留源，不回退整页或popup', async () => {
  for (const failure of ['permission', 'disabled', 'restricted']) {
    const { state, guard } = fixture();
    if (failure === 'permission') state.granted = false;
    if (failure === 'disabled') state.local.settings.duplicatePromptEnabled = false;
    if (failure === 'restricted') state.injectError = true;
    await guard.created({ id: 2 });
    await settle();
    assert.equal(state.overlays.size, 0);
    assert.equal(state.tabs.get(2).url, URL);
    assert.equal(state.calls.some(call => ['create', 'focus', 'update', 'remove'].includes(call.type)), false);
    assert.equal(state.calls.filter(call => call.type === 'inject').length, failure === 'restricted' ? 1 : 0);
    if (failure === 'restricted') assert.deepEqual(state.released, [2]);
  }
});

test('等待首次目的地提交后注入，保留新标签只清理浮层，不重新导航或聚焦', async () => {
  const { state, guard, message, sender } = fixture([{ id: 1, url: URL }, { id: 2, url: 'about:blank' }]);
  assert.equal(await guard.created({ id: 2 }), false);
  state.tabs.get(2).pendingUrl = URL;
  assert.equal(await guard.updated(2), true);
  await settle();
  assert.equal(state.calls.some(call => call.type === 'inject'), false);
  state.tabs.get(2).url = URL;
  delete state.tabs.get(2).pendingUrl;
  assert.equal(await guard.updated(2), true);
  await settle();
  state.overlays.delete(2); // X/Esc remove their DOM immediately before notifying the worker.
  const result = await guard.chooseInline(message('keep'), sender());
  assert.deepEqual(result, { action: 'kept', releasedId: 2 });
  assert.deepEqual(state.session.inlineDuplicateState, { watch: {}, prompts: {} });
  assert.equal(state.tabs.has(2), true);
  assert.equal(state.calls.some(call => ['create', 'focus', 'update', 'remove'].includes(call.type)), false);
  assert.equal(await guard.updated(2), false);
});

test('注入延迟不阻塞观察，期间导航/移除/撤销后晚结果不能SHOW或复活状态', async () => {
  for (const action of ['navigate', 'remove', 'permission']) {
    const { state, guard } = fixture();
    const pending = gate();
    const started = gate();
    state.onInject = async () => { started.resolve(); await pending.promise; };
    assert.equal(await guard.created({ id: 2 }), true);
    await started.promise;
    if (action === 'navigate') { state.tabs.get(2).url = 'https://elsewhere.test/'; assert.equal(await guard.updated(2), false); }
    if (action === 'remove') { state.tabs.delete(2); await guard.removed(2); }
    if (action === 'permission') { state.granted = false; assert.deepEqual(await guard.permissionsChanged(), [2]); }
    pending.resolve();
    await settle();
    assert.deepEqual(state.session.inlineDuplicateState, { watch: {}, prompts: {} });
    assert.equal(state.calls.some(call => call.message?.type === 'INLINE_DUPLICATE_SHOW'), false);
  }
});

test('无DOM时等待后续事件有限重试，网址改变的注入结果不展示', async () => {
  const { state, guard, record } = fixture();
  state.noDOM = true;
  await guard.created({ id: 2 });
  await settle();
  assert.equal(record()[1].phase, 'waiting');
  state.noDOM = false;
  await guard.updated(2);
  await settle();
  assert.equal(record()[1].phase, 'shown');
  const next = fixture();
  next.state.onInject = () => { next.state.tabs.get(2).url = 'https://elsewhere.test/'; };
  await next.guard.created({ id: 2 });
  await settle();
  assert.equal(next.state.overlays.size, 0);
  assert.deepEqual(next.state.released, [2]);
});

test('同URL刷新或SPA变化后，旧文档消息不能关闭新页面', async () => {
  for (const change of ['document', 'url']) {
    const { state, guard, start, message, sender } = fixture();
    await start();
    const request = message();
    const from = sender();
    if (change === 'document') state.docs.set(2, 'fresh-document');
    else state.tabs.get(2).url = 'https://example.com/other';
    await assert.rejects(guard.chooseInline(request, from));
    assert.equal(state.tabs.has(2), true);
    assert.equal(state.calls.some(call => call.type === 'remove'), false);
    await guard.updated(2);
    assert.deepEqual(state.session.inlineDuplicateState, { watch: {}, prompts: {} });
  }
});

test('Chrome提供的tab/frame/document/url/lifecycle及token必须全部匹配', async () => {
  const { state, guard, start, message, sender } = fixture();
  await start();
  const request = message();
  const from = sender();
  for (const patch of [{ id: 'other' }, { tab: { id: 1 } }, { frameId: 1 }, { frameId: undefined },
    { documentId: 'other' }, { documentId: undefined }, { url: 'https://other.test/' }, { documentLifecycle: 'cached' }]) {
    await assert.rejects(guard.chooseInline(request, { ...from, ...patch }));
  }
  await assert.rejects(guard.chooseInline({ ...request, token: 'inline-00000000-0000-0000-0000-000000000000' }, from));
  await assert.rejects(guard.chooseInline({ ...request, choice: 'erase' }, from));
  assert.equal(state.calls.some(call => call.type === 'remove'), false);
});

test('只有显式switch会切到跨窗口目标，聚焦后仅关闭源重复页', async () => {
  const { state, guard, start, message, sender } = fixture([{ id: 1, url: URL, windowId: 2 }, { id: 2, url: URL }]);
  await start();
  assert.deepEqual(await guard.chooseInline(message(), sender()), { action: 'switched', closed: true });
  assert.equal(state.tabs.has(1), true);
  assert.equal(state.tabs.has(2), false);
  const focus = state.calls.findIndex(call => call.type === 'focus' && call.id === 2);
  const remove = state.calls.findIndex(call => call.type === 'remove' && call.id === 2);
  assert.ok(focus >= 0 && remove > focus);
});

test('忽略参数规则下切换使用目标原始URL，业务参数变化仍拒绝关闭源', async () => {
  const target = 'https://example.com/page?utm=old&item=1';
  const source = 'https://example.com/page?utm=new&item=1';
  const allowed = fixture([{ id: 1, url: target, windowId: 2 }, { id: 2, url: source }]);
  allowed.state.local.library = { schemaVersion: 1, revision: 0, favorites: [null, null, null], workspaces: [],
    dedupRules: [{ origin: 'https://example.com', ignoreParams: ['utm'] }] };
  await allowed.start();
  assert.deepEqual(await allowed.guard.chooseInline(allowed.message(), allowed.sender()), { action: 'switched', closed: true });
  assert.equal(allowed.state.tabs.has(1), true);
  assert.equal(allowed.state.tabs.has(2), false);
  assert.ok(allowed.state.calls.some(call => call.type === 'focus' && call.id === 2));

  const changed = fixture([{ id: 1, url: target }, { id: 2, url: source }]);
  changed.state.local.library = { schemaVersion: 1, revision: 0, favorites: [null, null, null], workspaces: [],
    dedupRules: [{ origin: 'https://example.com', ignoreParams: ['utm'] }] };
  await changed.start();
  changed.state.tabs.get(1).url = 'https://example.com/page?utm=old&item=2';
  await assert.rejects(changed.guard.chooseInline(changed.message(), changed.sender()));
  assert.equal(changed.state.tabs.has(2), true);
  assert.equal(changed.state.calls.some(call => call.type === 'remove'), false);
});

test('目标消失、源移动/改组/变保护或浮层已关闭时均不删除源', async () => {
  for (const change of ['target', 'window', 'group', 'pinned', 'shared', 'split', 'overlay']) {
    const { state, guard, start, message, sender } = fixture();
    await start();
    const request = message();
    const from = sender();
    if (change === 'target') state.tabs.delete(1);
    if (change === 'window') state.tabs.get(2).windowId = 2;
    if (change === 'group') { state.groups.set(7, { id: 7, windowId: 1 }); state.tabs.get(2).groupId = 7; }
    if (change === 'pinned') state.tabs.get(2).pinned = true;
    if (change === 'shared') { state.groups.set(7, { id: 7, windowId: 1, shared: true }); state.tabs.get(2).groupId = 7; }
    if (change === 'split') state.tabs.get(2).splitViewId = 2;
    if (change === 'overlay') state.overlays.delete(2);
    await assert.rejects(guard.chooseInline(request, from));
    assert.equal(state.tabs.has(2), true);
    assert.equal(state.calls.some(call => call.type === 'remove'), false);
  }
});

test('持久化或激活期间来源变化，最终复核不删除源；聚焦失败保持浮层', async () => {
  for (const failure of ['save', 'focus', 'document']) {
    const { state, guard, start, message, sender } = fixture();
    await start();
    if (failure === 'save') state.onSave = values => {
      if (Object.values(values.inlineDuplicateState?.prompts || {}).some(record => record.phase === 'closing')) state.tabs.get(2).url = 'https://new.test/';
    };
    if (failure === 'focus') state.onFocus = () => { throw Error('Focus failed'); };
    if (failure === 'document') state.onFocus = () => { state.docs.set(2, 'fresh-document'); };
    await assert.rejects(guard.chooseInline(message(), sender()));
    assert.equal(state.calls.some(call => call.type === 'remove'), false);
    assert.equal(state.tabs.has(2), true);
  }
});

test('关闭等待在队列外，双击只发一次；X保留可清状态，迟到取消不复活记录', async () => {
  for (const closeEventually of [true, false]) {
    const { state, guard, start, message, sender } = fixture();
    await start();
    const request = message();
    const from = sender();
    const pending = gate();
    const issued = gate();
    state.onRemove = id => { if (id === 2) { issued.resolve(); return pending.promise; } };
    const first = guard.chooseInline(request, from);
    await issued.promise;
    assert.equal(guard.chooseInline(request, from), first);
    assert.equal(await guard.updated(2), true);
    state.overlays.delete(2);
    assert.equal((await guard.chooseInline({ ...request, choice: 'keep' }, from)).action, 'kept');
    pending.resolve(closeEventually);
    assert.equal((await first).closed, closeEventually);
    assert.deepEqual(state.session.inlineDuplicateState, { watch: {}, prompts: {} });
    assert.equal(state.calls.filter(call => call.type === 'remove').length, 1);
  }
});

test('Worker重建可处理原浮层，session清空后旧token不重绑，不猜同URL源', async () => {
  const { state, api, guard, start, message, sender, release } = fixture();
  await start();
  const request = message('keep');
  const from = sender();
  let restarted = createInlineDuplicateGuard(api, release);
  assert.equal((await restarted.chooseInline(request, from)).action, 'kept');
  await guard.created({ id: 2 });
  await settle();
  const old = message();
  state.session = {};
  restarted = createInlineDuplicateGuard(api, release);
  await assert.rejects(restarted.chooseInline(old, from));
  assert.equal(state.tabs.get(2).url, URL);
  assert.equal(state.calls.some(call => call.type === 'remove'), false);
});

test('完整query/hash区别、普通旧导航、保护来源/目标及并发防环保持原语义', async () => {
  for (const url of [URL.replace('q=1', 'q=2'), URL.replace('#part', '#other'), 'https://other.test/']) {
    const { state, guard } = fixture([{ id: 1, url: URL }, { id: 2, url }]);
    assert.equal(await guard.created({ id: 2 }), false);
    state.tabs.get(2).url = URL;
    assert.equal(await guard.updated(2), false);
  }
  for (const id of [1, 2]) {
    const { state, guard } = fixture();
    state.tabs.get(id).pinned = true;
    assert.equal(await guard.created({ id: 2 }), false);
  }
  const { state, guard } = fixture([{ id: 2, url: URL }, { id: 3, url: URL }]);
  assert.deepEqual(await Promise.all([guard.created({ id: 2 }), guard.created({ id: 3 })]), [true, false]);
  await settle();
  assert.equal(state.overlays.size, 1);
  assert.equal(state.tabs.get(3).url, URL);
});

test('撤销权限隐藏已有浮层并释放源，旧版waiting状态不得生成popup/整页', async () => {
  const { state, guard, start } = fixture();
  await start();
  state.granted = false;
  assert.deepEqual(await guard.permissionsChanged(), [2]);
  await settle();
  assert.equal(state.overlays.size, 0);
  state.session.duplicateWatch = { 2: { stage: 'watching' } };
  state.session.duplicatePopupState = { watch: { 2: { stage: 'watching' } }, prompts: {} };
  assert.equal(await guard.updated(2), false);
  assert.equal(state.session.duplicateWatch[2], undefined);
  assert.equal(state.session.duplicatePopupState.watch[2], undefined);
  assert.equal(state.calls.some(call => ['create', 'focus', 'update', 'remove'].includes(call.type)), false);
});

test('权限撤销或开关关闭即使清理事件尚未到达，旧按钮也不能切换/关闭网页', async () => {
  for (const change of ['permission', 'setting']) {
    const { state, guard, start, message, sender } = fixture();
    await start();
    if (change === 'permission') state.granted = false;
    else state.local.settings.duplicatePromptEnabled = false;
    await assert.rejects(guard.chooseInline(message(), sender()), /权限已撤销/);
    assert.equal(state.calls.some(call => ['focus', 'update', 'remove'].includes(call.type)), false);
    assert.deepEqual(await guard.permissionsChanged(), [2]);
    await settle();
    assert.equal(state.overlays.size, 0);
  }
});

test('Worker重建自动恢复丢失的注入，旧注入迟到不能覆盖新尝试', async () => {
  const { state, api, guard, release, record } = fixture();
  const pending = gate();
  const started = gate();
  let injections = 0;
  state.onInject = async () => { if (++injections === 1) { started.resolve(); await pending.promise; } };
  await guard.created({ id: 2 });
  await started.promise;
  const originalAttempt = record()[1].installationId;
  createInlineDuplicateGuard(api, release);
  await settle();
  assert.equal(injections, 2);
  assert.equal(record()[1].phase, 'shown');
  assert.notEqual(record()[1].installationId, originalAttempt);
  pending.resolve();
  await settle();
  assert.equal(record()[1].phase, 'shown');
  assert.equal(state.calls.filter(call => call.message?.type === 'INLINE_DUPLICATE_SHOW').length, 1);
});

test('allowlist和站点暂停阻止提示，暂停动作只信任绑定记录中的origin并立即dismiss', async () => {
  for (const mode of ['allowlist', 'paused']) {
    const policy = {
      async isDuplicateAllowed() { return mode === 'allowlist'; },
      async isPromptPaused() { return true; },
    };
    const { state, guard } = fixture(undefined, { policy });
    assert.equal(await guard.created({ id: 2 }), false);
    assert.equal(state.calls.some(call => call.type === 'inject'), false);
  }

  const paused = [];
  const policy = {
    async isDuplicateAllowed() { return false; },
    async isPromptPaused() { return false; },
    async pauseSite(origin) { paused.push(origin); },
  };
  const { state, guard, start, message, sender } = fixture(undefined, { policy });
  state.local.preferences = { theme: 'dark', density: 'compact' };
  await start();
  const show = state.calls.find(call => call.message?.type === 'INLINE_DUPLICATE_SHOW');
  assert.deepEqual(show.message.preferences, { theme: 'dark', density: 'compact' });
  const forged = { ...message('pause-site'), origin: 'https://evil.test' };
  assert.deepEqual(await guard.chooseInline(forged, sender()), {
    action: 'paused', origin: 'https://example.com', releasedId: 2,
  });
  assert.deepEqual(paused, ['https://example.com']);
  assert.equal(state.overlays.size, 0);
  assert.equal(state.tabs.has(2), true);
});

test('仅切换并关闭路径持有共享operationLock，保留和暂停不持锁', async () => {
  const kinds = [];
  const operationLock = { async run(kind, task) { kinds.push(kind); return task(); } };
  const policy = { async isDuplicateAllowed() { return false; }, async isPromptPaused() { return false; }, async pauseSite() {} };
  const switched = fixture(undefined, { operationLock, policy });
  await switched.start();
  await switched.guard.chooseInline(switched.message('switch'), switched.sender());
  assert.deepEqual(kinds, ['inline-duplicate']);

  const kept = fixture(undefined, { operationLock, policy });
  await kept.start();
  await kept.guard.chooseInline(kept.message('keep'), kept.sender());
  const paused = fixture(undefined, { operationLock, policy });
  await paused.start();
  await paused.guard.chooseInline(paused.message('pause-site'), paused.sender());
  assert.deepEqual(kinds, ['inline-duplicate']);
});

test('聚焦后权限、开关、policy或源目标稳定性变化时终检保留源', async () => {
  for (const change of ['permission', 'setting', 'policy', 'source-reload', 'target-loading',
    'source-shared', 'target-shared', 'source-split']) {
    let paused = false;
    const policy = {
      async isDuplicateAllowed() { return false; },
      async isPromptPaused() { return paused; },
    };
    const current = fixture(undefined, { policy });
    await current.start();
    current.state.onFocus = () => {
      if (change === 'permission') {
        current.state.granted = false;
        void current.guard.permissionsChanged(); // queued cleanup must not be the safety barrier.
      }
      if (change === 'setting') current.state.local.settings.duplicatePromptEnabled = false;
      if (change === 'policy') paused = true;
      if (change === 'source-reload') Object.assign(current.state.tabs.get(2), { pendingUrl: URL, status: 'loading' });
      if (change === 'target-loading') Object.assign(current.state.tabs.get(1), { pendingUrl: URL, status: 'loading' });
      if (change === 'source-shared') {
        current.state.groups.set(7, { id: 7, windowId: 1, shared: true });
        current.state.tabs.get(2).groupId = 7;
      }
      if (change === 'target-shared') {
        current.state.groups.set(7, { id: 7, windowId: 1, shared: true });
        current.state.tabs.get(1).groupId = 7;
      }
      if (change === 'source-split') current.state.tabs.get(2).splitViewId = 4;
    };
    await assert.rejects(current.guard.chooseInline(current.message(), current.sender()));
    assert.equal(current.state.tabs.has(2), true, change);
    assert.equal(current.state.calls.some(call => call.type === 'remove'), false, change);
  }
});
