import test from 'node:test';
import assert from 'node:assert/strict';
import { createPopupDuplicateGuard } from '../popup-duplicate-guard.js';

const URL = 'https://example.com/page?q=1#part';
const PAGE = 'chrome-extension://unit/duplicate.html';
function fixture(tabs = [{ id: 1, url: URL }, { id: 2, url: URL }]) {
  const state = {
    tabs: new Map(tabs.map(tab => [tab.id, { windowId: 1, groupId: -1, pinned: false, title: `页面 ${tab.id}`, ...tab }])),
    windows: new Map([[1, { id: 1, type: 'normal' }], [2, { id: 2, type: 'normal' }], [3, { id: 3, type: 'popup' }]]),
    groups: new Map(), local: { settings: { enabled: false, duplicatePromptEnabled: true, rules: [] } },
    session: {}, calls: [], nextId: 100,
  };
  const clone = value => structuredClone(value);
  const area = name => ({
    async get(defaults) { return clone({ ...defaults, ...state[name] }); },
    async set(values) {
      if (name === 'session' && state.onSessionSet) await state.onSessionSet(values);
      Object.assign(state[name], clone(values));
    },
  });
  const api = {
    runtime: { id: 'unit', getURL: file => `chrome-extension://unit/${file}` },
    storage: { local: area('local'), session: area('session') },
    tabs: {
      async get(id) {
        if (state.onGet) await state.onGet(id);
        if (!state.tabs.has(id)) throw Error('No tab');
        return clone(state.tabs.get(id));
      },
      async query(options = {}) {
        return clone([...state.tabs.values()].filter(tab =>
          (!options.windowType || state.windows.get(tab.windowId)?.type === options.windowType)
          && (options.windowId === undefined || options.windowId === tab.windowId)));
      },
      async update(id, values) {
        state.calls.push({ type: 'update', id, ...values });
        if (state.onUpdate) await state.onUpdate(id, values);
        if (!state.tabs.has(id)) throw Error('No tab');
        Object.assign(state.tabs.get(id), values);
        if (values.url) delete state.tabs.get(id).pendingUrl;
        return clone(state.tabs.get(id));
      },
      async remove(id) {
        state.calls.push({ type: 'remove', id });
        if (state.onRemove && await state.onRemove(id) === false) return;
        state.tabs.delete(id);
      },
    },
    windows: {
      async get(id) { if (!state.windows.has(id)) throw Error('No window'); return clone(state.windows.get(id)); },
      async create(values) {
        state.calls.push({ ...values, windowType: values.type, type: 'create' });
        if (state.onCreate) await state.onCreate(values);
        const id = state.nextId++;
        const tab = { id: state.nextId++, windowId: id, url: values.url, groupId: -1, pinned: false };
        const window = { id, type: values.type };
        state.tabs.set(tab.id, tab);
        state.windows.set(id, window);
        return { ...window, ...(state.omitTabs ? {} : { tabs: [clone(tab)] }) };
      },
      async update(id, values) {
        state.calls.push({ type: 'focus', id, ...values });
        if (state.onFocus) await state.onFocus(id, values);
        if (!state.windows.has(id)) throw Error('No window');
        return clone(state.windows.get(id));
      },
    },
    tabGroups: { async get(id) { if (!state.groups.has(id)) throw Error('No group'); return clone(state.groups.get(id)); } },
  };
  const guard = createPopupDuplicateGuard(api);
  const record = () => Object.entries(state.session.duplicatePopupState?.prompts || {})[0];
  const message = () => { const [token, prompt] = record(); return { token, tabId: prompt.popupTabId }; };
  const sender = () => { const request = message(); return { id: 'unit', url: state.tabs.get(request.tabId).url, tab: { id: request.tabId }, frameId: 0 }; };
  return { state, api, guard, record, message, sender };
}

test('新重复页不替换URL，只创建480×440 popup；popup自身不递归提醒', async () => {
  const { state, guard, record, message, sender } = fixture();
  state.omitTabs = true;
  assert.equal(await guard.created({ id: 2 }), true);
  const [, prompt] = record();
  const created = state.calls.find(call => call.type === 'create');
  assert.equal(created.type, 'create');
  assert.equal(created.windowType, 'popup');
  assert.equal(created.width, 480);
  assert.equal(created.height, 440);
  assert.equal(created.focused, true);
  assert.equal(created.url.includes('example.com'), false);
  assert.equal(state.tabs.get(2).url, URL);
  assert.equal(state.calls.some(call => call.url === URL), false);
  assert.equal(await guard.created({ id: prompt.popupTabId }), false);
  const info = await guard.info(message(), sender());
  assert.equal(info.presentation, 'popup');
  assert.equal(info.sourceAvailable, true);
  assert.deepEqual(info.matches.map(tab => tab.id), [1]);
  assert.equal(state.local.duplicatePrompts, undefined);
});

test('空白新页等待首次网址；完整参数不同及后续普通导航均不提醒', async () => {
  const { state, guard } = fixture([{ id: 1, url: URL }, { id: 2, url: 'about:blank' }]);
  assert.equal(await guard.created({ id: 2 }), false);
  state.tabs.get(2).pendingUrl = URL;
  assert.equal(await guard.updated(2), true);
  assert.equal(state.tabs.get(2).url, 'about:blank');
  for (const url of ['https://other.test/', URL.replace('q=1', 'q=2'), URL.replace('#part', '#other')]) {
    const next = fixture([{ id: 1, url: URL }, { id: 2, url }]);
    assert.equal(await next.guard.created({ id: 2 }), false);
    next.state.tabs.get(2).url = URL;
    assert.equal(await next.guard.updated(2), false);
    assert.equal(next.state.calls.length, 0);
  }
});

test('保留新标签只激活聚焦，不重新导航或关闭源；关闭后不再次提示', async () => {
  const { state, guard, message, sender } = fixture();
  await guard.created({ id: 2 });
  const request = message();
  const response = await guard.choose({ ...request, choice: 'open' }, sender());
  assert.equal(response.action, 'opened');
  assert.equal(response.popupClosed, true);
  assert.equal(response.releasedId, 2);
  assert.equal(state.tabs.get(2).url, URL);
  assert.equal(state.calls.some(call => call.type === 'update' && call.url), false);
  assert.equal(state.calls.some(call => call.type === 'remove' && call.id === 2), false);
  assert.equal(state.tabs.has(request.tabId), false);
  assert.equal(await guard.updated(2), false);
  assert.deepEqual(state.session.duplicatePopupState, { watch: {}, prompts: {} });
});

test('切到跨窗口已有页，聚焦后关闭源重复页及提醒，不关闭已有页', async () => {
  const { state, guard, message, sender } = fixture([{ id: 1, url: URL, windowId: 2 }, { id: 2, url: URL }]);
  await guard.created({ id: 2 });
  const request = message();
  assert.deepEqual(await guard.choose({ ...request, choice: 'switch' }, sender()),
    { action: 'switched', closed: true, popupClosed: true });
  assert.equal(state.tabs.has(1), true);
  assert.equal(state.tabs.has(2), false);
  assert.equal(state.tabs.has(request.tabId), false);
  const focus = state.calls.findIndex(call => call.type === 'focus' && call.id === 2);
  const close = state.calls.findIndex(call => call.type === 'remove' && call.id === 2);
  assert.ok(focus >= 0 && close > focus);
});

test('X关闭弹窗仅清理状态并释放源供分组；源关闭或导航撤销提醒', async () => {
  for (const action of ['popup', 'source', 'navigate']) {
    const { state, guard, message } = fixture();
    await guard.created({ id: 2 });
    const request = message();
    if (action === 'popup') {
      state.tabs.delete(request.tabId);
      assert.deepEqual(await guard.removed(request.tabId), [2]);
      assert.equal(state.tabs.get(2).url, URL);
      assert.equal(await guard.updated(2), false);
    } else if (action === 'source') {
      state.tabs.delete(2);
      await guard.removed(2);
      assert.equal(state.tabs.has(request.tabId), false);
    } else {
      state.tabs.get(2).url = 'https://user-chosen.test/';
      assert.equal(await guard.updated(2), false);
      assert.equal(state.tabs.has(request.tabId), false);
      assert.equal(state.tabs.get(2).url, 'https://user-chosen.test/');
    }
    assert.deepEqual(state.session.duplicatePopupState, { watch: {}, prompts: {} });
    assert.equal(state.tabs.has(1), true);
  }
});

test('创建失败或保存失败保留源；失效提醒不自动重试', async () => {
  for (const failure of ['create', 'before', 'after']) {
    const { state, guard } = fixture();
    if (failure === 'create') state.onCreate = () => { throw Error('Cannot create'); };
    else state.onSessionSet = values => {
      const records = Object.values(values.duplicatePopupState?.prompts || {});
      if (records.some(record => failure === 'before' ? record.popupTabId === null : record.popupTabId !== null)) throw Error('Storage full');
    };
    await assert.rejects(guard.created({ id: 2 }));
    assert.equal(state.tabs.get(2).url, URL);
    assert.equal(state.calls.some(call => call.type === 'update'), false);
    assert.equal(await guard.updated(2), false);
    assert.equal([...state.tabs.values()].filter(tab => tab.url?.startsWith(PAGE)).length, 0);
  }
});

test('弹窗自身导航或移入普通窗口立即释放源，且不关闭弹窗的新页面', async () => {
  for (const mutation of [{ url: 'https://user-chosen.test/' }, { windowId: 1 }]) {
    const { state, guard, message } = fixture();
    await guard.created({ id: 2 });
    const request = message();
    Object.assign(state.tabs.get(request.tabId), mutation);
    assert.deepEqual(await guard.updated(request.tabId), { suppressed: false, releasedIds: [2] });
    assert.deepEqual(state.session.duplicatePopupState, { watch: {}, prompts: {} });
    assert.equal(await guard.updated(2), false);
    assert.equal(state.tabs.has(request.tabId), true);
    assert.equal(state.calls.some(call => call.type === 'remove'), false);
  }
});

test('固定、无痕、共享、分屏、popup两侧跳过；开关独立于分组', async () => {
  for (const values of [{ pinned: true }, { incognito: true }, { splitViewId: 1 }, { groupId: 8 }, { windowId: 3 }]) {
    for (const id of [1, 2]) {
      const { state, guard } = fixture();
      Object.assign(state.tabs.get(id), values);
      state.groups.set(8, { id: 8, windowId: 1, shared: true });
      assert.equal(await guard.created({ id: 2 }), false);
      assert.equal(state.calls.length, 0);
    }
  }
  const { state, guard } = fixture();
  state.local.settings.duplicatePromptEnabled = false;
  assert.equal(await guard.created({ id: 2 }), false);
  assert.equal(state.session.duplicatePopupState, undefined);
});

test('并发新开相同URL不会互相提醒，至少留下一个真实目标', async () => {
  const { state, guard } = fixture([{ id: 2, url: URL }, { id: 3, url: URL }]);
  assert.deepEqual(await Promise.all([guard.created({ id: 2 }), guard.created({ id: 3 })]), [true, false]);
  assert.equal(Object.keys(state.session.duplicatePopupState.prompts).length, 1);
  assert.equal(state.tabs.get(2).url, URL);
  assert.equal(state.tabs.get(3).url, URL);
});

test('操作期间源导航、移动、改组或保护状态变化时不关闭或覆盖源', async () => {
  for (const choice of ['open', 'switch']) {
    for (const mutation of [{ url: 'https://new.test/' }, { pendingUrl: 'https://new.test/' },
      { windowId: 2 }, { groupId: 7 }, { pinned: true }, { splitViewId: 4 }]) {
      const { state, guard, message, sender } = fixture();
      await guard.created({ id: 2 });
      state.groups.set(7, { id: 7, windowId: 1, shared: false });
      state.onSessionSet = values => {
        if (Object.values(values.duplicatePopupState?.prompts || {}).some(record => ['opening', 'closing'].includes(record.phase))) {
          Object.assign(state.tabs.get(2), mutation);
        }
      };
      await assert.rejects(guard.choose({ ...message(), choice }, sender()));
      assert.equal(state.tabs.has(2), true);
      assert.equal(state.calls.some(call => call.type === 'remove' && call.id === 2), false);
      assert.equal(state.calls.some(call => call.type === 'update' && call.url), false);
    }
  }
});

test('目标或popup变化、聚焦失败均不关闭源；popup被导航后不删除新页面', async () => {
  for (const failure of ['target', 'popup', 'popup-closed', 'focus']) {
    const { state, guard, message, sender } = fixture();
    await guard.created({ id: 2 });
    const request = message();
    const from = sender();
    state.onFocus = () => {
      if (failure === 'target') state.tabs.get(1).url = 'https://new.test/';
      if (failure === 'popup') state.tabs.get(request.tabId).url = 'https://new.test/';
      if (failure === 'popup-closed') state.tabs.delete(request.tabId);
      if (failure === 'focus') throw Error('Focus failed');
    };
    await assert.rejects(guard.choose({ ...request, choice: 'switch' }, from));
    assert.equal(state.tabs.has(2), true);
    assert.equal(state.calls.some(call => call.type === 'remove' && call.id === 2), false);
    if (failure === 'popup') {
      state.tabs.get(2).url = 'https://elsewhere.test/';
      await guard.updated(2);
      assert.equal(state.tabs.get(request.tabId).url, 'https://new.test/');
    }
  }
});

test('已有目标消失后仍可保留源；切换取消不会误报关闭或自动再发remove', async () => {
  const { state, guard, message, sender } = fixture();
  await guard.created({ id: 2 });
  const request = message();
  const from = sender();
  state.tabs.delete(1);
  assert.equal((await guard.info(request, from)).matches.length, 0);
  await assert.rejects(guard.choose({ ...request, choice: 'switch' }, from));
  assert.equal((await guard.choose({ ...request, choice: 'open' }, from)).action, 'opened');
  const next = fixture();
  await next.guard.created({ id: 2 });
  next.state.onRemove = id => id === 2 ? false : undefined;
  const result = await next.guard.choose({ ...next.message(), choice: 'switch' }, next.sender());
  assert.equal(result.closed, false);
  assert.equal(next.state.tabs.has(2), true);
  assert.equal(next.state.calls.filter(call => call.type === 'remove' && call.id === 2).length, 1);
});

test('等待原生关闭不阻塞观察队列；X关闭及迟到回调不复活已取消的记录', async () => {
  for (const closeEventually of [true, false]) {
    const { state, guard, message, sender } = fixture();
    await guard.created({ id: 2 });
    const request = message();
    const from = sender();
    let finish;
    let started;
    const issued = new Promise(resolve => { started = resolve; });
    state.onRemove = id => {
      if (id === 2) { started(); return new Promise(resolve => { finish = () => resolve(closeEventually); }); }
    };
    const first = guard.choose({ ...request, choice: 'switch' }, from);
    await issued;
    const second = guard.choose({ ...request, choice: 'open' }, from);
    assert.equal(first, second);
    const info = await guard.info(request, from);
    assert.equal(info.busy, true);
    assert.equal(state.session.duplicatePopupState.prompts[request.token].phase, 'closing');
    assert.equal(await guard.updated(2), true);
    state.tabs.delete(request.tabId);
    assert.deepEqual(await guard.removed(request.tabId), [2]);
    finish();
    const result = await first;
    assert.equal(result.closed, closeEventually);
    assert.deepEqual(state.session.duplicatePopupState, { watch: {}, prompts: {} });
    assert.equal(state.calls.filter(call => call.type === 'remove' && call.id === 2).length, 1);
  }
});

test('Worker重建可继续操作，创建后未写身份可绑定；session清空后绝不猜源ID', async () => {
  const { state, api, guard, record, message, sender } = fixture();
  await guard.created({ id: 2 });
  const request = message();
  const from = sender();
  let restarted = createPopupDuplicateGuard(api);
  assert.equal((await restarted.info(request, from)).sourceAvailable, true);
  const [, prompt] = record();
  prompt.popupTabId = null;
  prompt.popupWindowId = null;
  prompt.phase = 'creating';
  restarted = createPopupDuplicateGuard(api);
  assert.equal((await restarted.info(request, from)).sourceAvailable, true);
  assert.equal(record()[1].popupTabId, request.tabId);
  state.session = {};
  state.tabs.get(2).url = URL; // A coincidentally matching/reused source must not be trusted.
  restarted = createPopupDuplicateGuard(api);
  await assert.rejects(restarted.info(request, from), /提醒已失效/);
  await assert.rejects(restarted.choose({ ...request, choice: 'switch' }, from), /提醒已失效/);
  assert.equal(state.calls.some(call => call.type === 'remove'), false);
});

test('伪造身份、iframe、克隆popup及无效选择不能操作', async () => {
  const { state, guard, message, sender } = fixture();
  await guard.created({ id: 2 });
  const request = message();
  const from = sender();
  for (const invalid of [{ ...from, id: 'other' }, { ...from, url: 'https://bad.test/' },
    { ...from, frameId: 1 }, { ...from, tab: { id: 2 } }]) {
    await assert.rejects(guard.info(request, invalid));
    await assert.rejects(guard.choose({ ...request, choice: 'switch' }, invalid));
  }
  state.tabs.set(500, { ...state.tabs.get(request.tabId), id: 500 });
  await assert.rejects(guard.info({ ...request, tabId: 500 }, { ...from, tab: { id: 500 } }));
  await assert.rejects(guard.choose({ ...request, choice: 'erase' }, from));
  assert.equal(state.calls.some(call => call.type === 'remove'), false);
});

test('旧整页提醒仍能打开原URL，提交后的事件清除local/session记录', async () => {
  const { state, guard } = fixture();
  const token = '11111111-1111-1111-1111-111111111111';
  const url = `${PAGE}#${token}`;
  state.tabs.get(2).url = url;
  state.local.duplicatePrompts = { [token]: { tabId: 2, url: URL, title: '旧版', targetId: 1, phase: 'prompt', createdAt: Date.now() } };
  const oldMessage = { token, tabId: 2 };
  const oldSender = { id: 'unit', url, tab: { id: 2 } };
  assert.equal((await guard.info(oldMessage, oldSender)).presentation, 'page');
  assert.equal((await guard.choose({ ...oldMessage, choice: 'open' }, oldSender)).action, 'opened');
  assert.equal(state.tabs.get(2).url, URL);
  assert.equal(await guard.updated(2), false);
  assert.equal(state.local.duplicatePrompts[token], undefined);
  assert.equal(state.session.duplicateWatch[2], undefined);
});

test('旧整页提醒生命周期继续清理移除状态，并迁移替换后token身份', async () => {
  const { state, guard } = fixture();
  const token = '11111111-1111-1111-1111-111111111111';
  const url = `${PAGE}#${token}`;
  state.tabs.get(2).url = url;
  state.local.duplicatePrompts = { [token]: { tabId: 2, url: URL, targetId: 1, phase: 'prompt', createdAt: Date.now() } };
  const from = id => ({ id: 'unit', url, tab: { id } });
  await guard.info({ token, tabId: 2 }, from(2));
  state.tabs.set(4, { ...state.tabs.get(2), id: 4 });
  state.tabs.delete(2);
  assert.equal(await guard.replaced(4, 2), true);
  assert.equal(state.session.duplicateWatch[2], undefined);
  assert.equal(state.session.duplicateWatch[4].token, token);
  await guard.info({ token, tabId: 4 }, from(4));
  assert.equal(state.local.duplicatePrompts[token].tabId, 4);
  state.tabs.delete(4);
  await guard.removed(4);
  assert.equal(state.session.duplicateWatch[4], undefined);
  assert.equal(state.local.duplicatePrompts[token].url, URL);
});

test('预渲染替换迁移源跟踪，弹窗关闭动作只针对当前token页面', async () => {
  const { state, guard, message, sender } = fixture([{ id: 1, url: URL }, { id: 2, url: 'about:blank' }]);
  await guard.created({ id: 2 });
  state.tabs.delete(2);
  state.tabs.set(4, { id: 4, url: URL, windowId: 1, groupId: -1 });
  assert.equal(await guard.replaced(4, 2), true);
  const request = message();
  const from = sender();
  state.onFocus = () => { state.tabs.get(request.tabId).url = 'https://user-chosen.test/'; };
  const result = await guard.choose({ ...request, choice: 'open' }, from);
  assert.equal(result.popupClosed, false);
  assert.equal(state.tabs.get(request.tabId).url, 'https://user-chosen.test/');
  assert.equal(state.tabs.get(4).url, URL);
});
