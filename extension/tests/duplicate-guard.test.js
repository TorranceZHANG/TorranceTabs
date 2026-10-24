import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuplicateGuard } from '../duplicate-guard.js';

const URL = 'https://example.com/page?q=1#section';
function fixture(tabs = [{ id: 1, url: URL }, { id: 2, url: URL }]) {
  const state = {
    tabs: new Map(tabs.map(tab => [tab.id, { windowId: 1, groupId: -1, pinned: false, title: `页面 ${tab.id}`, ...tab }])),
    groups: new Map(),
    windows: new Map([[1, { id: 1, type: 'normal' }], [2, { id: 2, type: 'normal' }], [3, { id: 3, type: 'popup' }]]),
    session: {}, local: { settings: { enabled: false, rules: [], duplicatePromptEnabled: true } }, calls: [],
  };
  const clone = value => structuredClone(value);
  const area = name => ({
    async get(defaults) { return clone({ ...defaults, ...state[name] }); },
    async set(values) {
      if (name === 'local' && state.onLocalSet) await state.onLocalSet(values);
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
        if (state.onQuery) await state.onQuery();
        return clone([...state.tabs.values()].filter(tab => !options.windowType || state.windows.get(tab.windowId)?.type === options.windowType));
      },
      async update(id, values) {
        state.calls.push({ type: 'update', id, ...values });
        if (state.onUpdate) await state.onUpdate(id, values);
        const tab = state.tabs.get(id);
        if (!tab) throw Error('No tab');
        if (values.url && state.delayCommit) tab.pendingUrl = values.url;
        else { Object.assign(tab, values); if (values.url) delete tab.pendingUrl; }
        return clone(tab);
      },
      async remove(id) { state.calls.push({ type: 'remove', id }); state.tabs.delete(id); },
    },
    windows: {
      async get(id) { if (!state.windows.has(id)) throw Error('No window'); return clone(state.windows.get(id)); },
      async update(id, values) {
        state.calls.push({ type: 'window', id, ...values });
        if (state.onWindowUpdate) await state.onWindowUpdate(id, values);
        return clone(state.windows.get(id));
      },
    },
    tabGroups: { async get(id) { if (!state.groups.has(id)) throw Error('No group'); return clone(state.groups.get(id)); } },
  };
  const guard = createDuplicateGuard(api);
  const message = (id = 2) => ({ tabId: id, token: state.session.duplicateWatch[id].token });
  const sender = (id = 2) => ({ id: 'unit', url: state.tabs.get(id).url, tab: { id }, frameId: 0 });
  return { state, api, guard, message, sender };
}

test('新建无URL后首次目的地重复，转到只含token的选择页，分组被抑制', async () => {
  const { state, guard, message, sender } = fixture([{ id: 1, url: URL }, { id: 2, url: 'about:blank' }]);
  assert.equal(await guard.created({ id: 2 }), false);
  state.tabs.get(2).pendingUrl = URL;
  assert.equal(await guard.updated(2), true);
  assert.match(state.tabs.get(2).url, /^chrome-extension:\/\/unit\/duplicate.html#[0-9a-f-]+$/);
  assert.equal(state.tabs.get(2).url.includes('example.com'), false);
  const info = await guard.info(message(), sender());
  assert.equal(info.url, URL);
  assert.deepEqual(info.matches.map(tab => tab.id), [1]);
  assert.equal(await guard.updated(2), true);
});

test('首次不重复即消费监控资格，普通旧标签导航不会弹出提醒', async () => {
  const { state, guard } = fixture([{ id: 1, url: URL }, { id: 2, url: 'https://other.test/' }]);
  assert.equal(await guard.created({ id: 2 }), false);
  state.tabs.get(2).url = URL;
  assert.equal(await guard.updated(2), false);
  assert.equal(await guard.updated(1), false);
  assert.equal(state.calls.length, 0);
});

test('比较完整query和fragment，不把不同参数地址合并', async () => {
  for (const url of ['https://example.com/page?q=2#section', 'https://example.com/page?q=1#other']) {
    const { state, guard } = fixture([{ id: 1, url: URL }, { id: 2, url }]);
    assert.equal(await guard.created({ id: 2 }), false);
    assert.equal(state.calls.length, 0);
  }
});

test('提醒开关独立于分组；关闭提醒时不登记新标签', async () => {
  const { state, guard } = fixture();
  state.local.settings.duplicatePromptEnabled = false;
  assert.equal(await guard.created({ id: 2 }), false);
  assert.equal(state.session.duplicateWatch?.[2], undefined);
  state.local.settings.duplicatePromptEnabled = true;
  assert.equal(await guard.created({ id: 2 }), true);
});

test('选择仍打开持久化opening豁免，导航后不再次提示，保留已有页面', async () => {
  const { state, guard, message, sender } = fixture();
  await guard.created({ id: 2 });
  const request = message();
  assert.deepEqual(await guard.choose({ ...request, choice: 'open' }, sender()), { action: 'opened' });
  assert.equal(state.tabs.get(2).url, URL);
  assert.equal(state.local.duplicatePrompts[request.token].phase, 'opening');
  assert.equal(await guard.updated(2), false);
  assert.equal(state.session.duplicateWatch[2], undefined);
  assert.equal(state.local.duplicatePrompts[request.token], undefined);
  assert.equal(await guard.updated(2), false);
  assert.equal(state.tabs.get(1).url, URL);
});

test('跳转到跨窗口已有标签，激活并聚焦成功后只关闭选择页', async () => {
  const { state, guard, message, sender } = fixture([{ id: 1, url: URL, windowId: 2 }, { id: 2, url: URL }]);
  await guard.created({ id: 2 });
  const request = message();
  assert.deepEqual(await guard.choose({ ...request, choice: 'switch' }, sender()), { action: 'switched', closed: true });
  assert.equal(state.tabs.has(1), true);
  assert.equal(state.tabs.has(2), false);
  const focus = state.calls.findIndex(call => call.type === 'window' && call.id === 2 && call.focused);
  const close = state.calls.findIndex(call => call.type === 'remove');
  assert.ok(focus >= 0 && close > focus);
  assert.equal(state.local.duplicatePrompts[request.token], undefined);
});

test('继续打开在持久化后复核来源，期间导航、移动或受保护均不覆盖用户页面', async () => {
  for (const area of ['onLocalSet', 'onSessionSet']) {
    for (const mutation of ['url', 'pendingUrl', 'windowId', 'pinned']) {
      const { state, guard, message, sender } = fixture();
      await guard.created({ id: 2 });
      const request = message();
      const from = sender();
      const changed = mutation === 'windowId' ? 2 : mutation === 'pinned' ? true : 'https://user-chosen.test/new-page';
      state[area] = values => {
        const opening = area === 'onLocalSet' ? values.duplicatePrompts?.[request.token]?.phase === 'opening'
          : values.duplicateWatch?.[2]?.stage === 'opening';
        if (opening) state.tabs.get(2)[mutation] = changed;
      };
      await assert.rejects(guard.choose({ ...request, choice: 'open' }, from), /当前标签已变化/);
      assert.equal(state.tabs.get(2)[mutation], changed);
      assert.equal(state.calls.some(call => call.id === 2 && call.url === URL), false);
      assert.equal(state.local.duplicatePrompts[request.token].phase, 'prompt');
      assert.equal(state.session.duplicateWatch[2].stage, 'prompt');
    }
  }
});

test('旧目标消失仍能打开原URL，且不得关闭最后的选择页', async () => {
  const { state, guard, message, sender } = fixture();
  await guard.created({ id: 2 });
  state.tabs.delete(1);
  assert.equal((await guard.info(message(), sender())).matches.length, 0);
  await assert.rejects(guard.choose({ ...message(), choice: 'switch' }, sender()), /已经关闭或跳转/);
  assert.equal(state.calls.some(call => call.type === 'remove'), false);
  assert.equal((await guard.choose({ ...message(), choice: 'open' }, sender())).action, 'opened');
  assert.equal(state.tabs.get(2).url, URL);
});

test('Worker重建仍能选择；浏览器恢复后按token重绑新tabId，不操作复用旧ID', async () => {
  const { state, api, guard, message, sender } = fixture();
  await guard.created({ id: 2 });
  const request = message();
  let restarted = createDuplicateGuard(api);
  assert.equal((await restarted.info(request, sender())).url, URL);
  const promptUrl = state.tabs.get(2).url;
  state.tabs.set(9, { ...state.tabs.get(2), id: 9 });
  state.tabs.get(2).url = 'https://unrelated.test/';
  state.session = {};
  restarted = createDuplicateGuard(api);
  const restored = { token: request.token, tabId: 9 };
  assert.equal((await restarted.info(restored, { id: 'unit', url: promptUrl, tab: { id: 9 } })).url, URL);
  assert.equal(state.local.duplicatePrompts[request.token].tabId, 9);
  await restarted.choose({ ...restored, choice: 'open' }, { id: 'unit', url: promptUrl, tab: { id: 9 } });
  assert.equal(state.tabs.get(9).url, URL);
  assert.equal(state.tabs.get(2).url, 'https://unrelated.test/');
});

test('关闭提醒保留恢复记录，恢复时不会丢失原始URL', async () => {
  const { state, guard, api, message } = fixture();
  await guard.created({ id: 2 });
  const request = message();
  const prompt = { ...state.tabs.get(2), id: 7 };
  state.tabs.delete(2);
  await guard.removed(2);
  assert.equal(state.local.duplicatePrompts[request.token].url, URL);
  state.tabs.set(7, prompt);
  const restart = createDuplicateGuard(api);
  const info = await restart.info({ token: request.token, tabId: 7 }, { id: 'unit', url: prompt.url });
  assert.equal(info.url, URL);
});

test('固定、无痕、共享、分屏或popup的来源和目标均不参与提醒', async () => {
  for (const values of [{ pinned: true }, { incognito: true }, { splitViewId: 3 }, { windowId: 3 }, { groupId: 8 }]) {
    for (const id of [1, 2]) {
      const { state, guard } = fixture();
      Object.assign(state.tabs.get(id), values);
      state.groups.set(8, { id: 8, windowId: 1, shared: true });
      assert.equal(await guard.created({ id: 2 }), false);
      assert.equal(state.calls.length, 0);
    }
  }
});

test('判定期间来源快速导航或目标变共享，不替换页面', async () => {
  for (const mutate of [
    state => { state.tabs.get(2).url = 'https://other.test/'; },
    state => { state.tabs.get(1).groupId = 8; },
  ]) {
    const { state, guard } = fixture();
    state.groups.set(8, { id: 8, windowId: 1, shared: true });
    state.onLocalSet = values => { if (values.duplicatePrompts) mutate(state); };
    assert.equal(await guard.created({ id: 2 }), false);
    assert.equal(state.calls.length, 0);
  }
});

test('持久记录写入失败时不替换原网页', async () => {
  const { state, guard } = fixture();
  state.onLocalSet = values => { if (values.duplicatePrompts) throw Error('Storage full'); };
  await assert.rejects(guard.created({ id: 2 }), /Storage full/);
  assert.equal(state.tabs.get(2).url, URL);
  assert.equal(state.calls.length, 0);
});

test('并发新开两份相同URL至多一个提示，待转页不能成为另一个提示的目标', async () => {
  for (const delayCommit of [false, true]) {
    const { state, guard } = fixture([{ id: 2, url: URL }, { id: 3, url: URL }]);
    state.delayCommit = delayCommit;
    assert.deepEqual(await Promise.all([guard.created({ id: 2 }), guard.created({ id: 3 })]), [true, false]);
    assert.equal(state.session.duplicateWatch[2].stage, 'prompt');
    assert.equal(state.session.duplicateWatch[3], undefined);
    assert.equal(state.tabs.get(3).url, URL);
    assert.equal(state.calls.filter(call => call.url?.includes('duplicate.html')).length, 1);
  }
});

test('切换中目标导航或聚焦失败保留选择页，来源变为别的网页时不关闭', async () => {
  for (const failure of ['target', 'focus', 'source']) {
    const { state, guard, message, sender } = fixture();
    await guard.created({ id: 2 });
    if (failure === 'target') state.onUpdate = (id, values) => { if (id === 1 && values.active) state.tabs.get(1).url = 'https://other.test/'; };
    if (failure === 'focus') state.onWindowUpdate = () => { throw Error('Cannot focus'); };
    if (failure === 'source') state.onWindowUpdate = () => { state.tabs.get(2).url = 'https://unrelated.test/'; };
    const operation = guard.choose({ ...message(), choice: 'switch' }, sender());
    if (failure === 'source') assert.deepEqual(await operation, { action: 'switched', closed: false });
    else await assert.rejects(operation);
    assert.equal(state.tabs.has(2), true);
    assert.equal(state.calls.some(call => call.type === 'remove'), false);
  }
});

test('伪造token、tabId、来源或frame消息，以及克隆别人提示页不能执行操作', async () => {
  const { state, guard, message, sender } = fixture();
  await guard.created({ id: 2 });
  const request = message();
  const source = sender();
  for (const [msg, from] of [
    [{ ...request, token: '00000000-0000-0000-0000-000000000000' }, source],
    [{ ...request, tabId: 1 }, source],
    [request, { ...source, id: 'other' }],
    [request, { ...source, url: 'https://example.com/' }],
    [request, { ...source, frameId: 1 }],
    [request, { ...source, tab: { id: 9 } }],
  ]) await assert.rejects(guard.info(msg, from));
  state.tabs.set(9, { ...state.tabs.get(2), id: 9 });
  await assert.rejects(guard.info({ token: request.token, tabId: 9 }, { ...source, tab: { id: 9 } }), /另一个标签页/);
  await assert.rejects(guard.choose({ ...request, choice: 'erase' }, source));
  assert.equal(state.calls.some(call => call.type === 'remove'), false);
});

test('两个不同按钮连点只执行第一个选择，后续显式重试不自动重复', async () => {
  const { state, guard, message, sender } = fixture();
  await guard.created({ id: 2 });
  let complete;
  let signal;
  const started = new Promise(resolve => { signal = resolve; });
  state.onUpdate = (id, values) => {
    if (id === 2 && values.url === URL) return new Promise(resolve => { complete = resolve; signal(); });
  };
  const request = message();
  const from = sender();
  const first = guard.choose({ ...request, choice: 'open' }, from);
  await started;
  const second = guard.choose({ ...request, choice: 'switch' }, from);
  assert.equal(first, second);
  complete();
  assert.equal((await first).action, 'opened');
  assert.equal((await second).action, 'opened');
  assert.equal(state.calls.some(call => call.type === 'remove'), false);
});

test('预渲染替换迁移新tab跟踪，已过期提示不能触发导航', async () => {
  const { state, guard, message, sender } = fixture([{ id: 1, url: URL }, { id: 2, url: 'about:blank' }]);
  await guard.created({ id: 2 });
  state.tabs.delete(2);
  state.tabs.set(4, { id: 4, windowId: 1, groupId: -1, url: URL });
  assert.equal(await guard.replaced(4, 2), true);
  const request = message(4);
  state.local.duplicatePrompts[request.token].createdAt = Date.now() - 31 * 86400000;
  await assert.rejects(guard.info(request, sender(4)), /已失效/);
  assert.equal(state.local.duplicatePrompts[request.token], undefined);
  assert.equal(state.calls.some(call => call.type === 'remove'), false);
});
