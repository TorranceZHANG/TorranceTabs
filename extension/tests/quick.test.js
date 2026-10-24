import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SCRIPT = readFileSync(new URL('../quick.js', import.meta.url), 'utf8');
const IDS = [
  'refresh-data',
  'cleanup-tabs',
  'cleanup-button-label',
  'tab-count',
  'duplicate-count',
  'snapshot-time',
  'cleanup-state',
  'operation-status',
  'operation-summary',
  'operation-details',
  'native-prompt-hint',
  'load-error',
  'load-error-text',
  'retry-load',
  'shortcut-value',
  'edit-shortcut',
  'open-dashboard',
  'open-settings',
];

const settle = async () => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

function gate() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class MockElement {
  constructor() {
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    return this.listeners.get('click')?.({ isTrusted: true });
  }
}

function fakeClock(initialNow = 10_000) {
  let now = initialNow;
  let nextId = 1;
  const timers = new Map();
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  return {
    Date: FakeDate,
    setTimeout(callback, delay = 0) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, due: now + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      let due;
      do {
        due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort((left, right) => left[1].due - right[1].due);
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.callback();
        }
      } while (due.length > 0);
    },
    now: () => now,
  };
}

function fixture(options = {}) {
  const elements = Object.fromEntries(IDS.map(id => [id, new MockElement()]));
  const clock = fakeClock(options.now);
  const state = {
    tabs: options.tabs ?? [
      { id: 1, url: 'https://example.test/page?q=1#part', incognito: false },
      { id: 2, url: 'https://example.test/page?q=1#part', incognito: false },
      { id: 3, url: 'https://example.test/page?q=2#part', incognito: false },
      { id: 4, url: 'chrome://settings', incognito: false },
      { id: 5, url: 'https://example.test/page?q=1#part', incognito: true },
    ],
    backendStatus: options.status ?? { state: 'idle' },
    shortcut: options.shortcut ?? 'Command+Shift+Y',
    deduplicateResponse: options.deduplicateResponse ?? {
      ok: true,
      closed: 1,
      skipped: 0,
      failed: 0,
      remaining: 0,
    },
    failTabs: Boolean(options.failTabs),
    failStatus: Boolean(options.failStatus),
    failShortcut: Boolean(options.failShortcut),
    deduplicateReject: options.deduplicateReject ?? null,
    queryHandler: options.queryHandler ?? null,
    statusHandler: options.statusHandler ?? null,
    calls: [],
    storageListener: null,
    statusRequestCount: 0,
  };
  const chrome = {
    tabs: {
      async query(query) {
        state.calls.push({ type: 'query', query });
        if (state.failTabs) throw new Error('Tabs unavailable');
        const result = state.queryHandler
          ? await state.queryHandler(query, state.calls.filter(call => call.type === 'query').length)
          : state.tabs;
        return structuredClone(result);
      },
      async create(createProperties) {
        state.calls.push({ type: 'create', createProperties });
        return { id: 99, ...createProperties };
      },
    },
    runtime: {
      getURL(path) { return `chrome-extension://unit/${path}`; },
      async openOptionsPage() { state.calls.push({ type: 'options' }); },
      async sendMessage(message) {
        state.calls.push({ type: 'message', message });
        if (message.type === 'GET_CLEANUP_STATUS') {
          state.statusRequestCount += 1;
          if (state.failStatus) throw new Error('Status unavailable');
          if (state.statusHandler) return state.statusHandler(message, state.statusRequestCount);
          return { ok: true, status: structuredClone(state.backendStatus) };
        }
        if (state.deduplicateReject) throw new Error(state.deduplicateReject);
        const response = structuredClone(state.deduplicateResponse);
        if (response.ok) {
          state.backendStatus = {
            state: 'done',
            result: {
              closed: response.closed,
              skipped: response.skipped,
              failed: response.failed,
              remaining: response.remaining,
            },
            startedAt: clock.now(),
            finishedAt: clock.now(),
            origin: 'panel',
            ...(response.warning ? { warning: response.warning } : {}),
          };
        } else {
          state.backendStatus = {
            state: 'error',
            operationId: 'panel-error',
            error: response.error || '清理失败。',
            startedAt: clock.now(),
            finishedAt: clock.now(),
            origin: 'panel',
          };
        }
        return response;
      },
    },
    commands: {
      async getAll() {
        state.calls.push({ type: 'commands' });
        if (state.failShortcut) throw new Error('Commands unavailable');
        return [{ name: 'deduplicate-tabs', shortcut: state.shortcut }];
      },
    },
    storage: {
      onChanged: {
        addListener(listener) { state.storageListener = listener; },
      },
    },
  };
  const context = {
    chrome,
    document: {
      querySelector(selector) { return elements[selector.slice(1)]; },
    },
    URL: globalThis.URL,
    Date: clock.Date,
    Promise,
    Object,
    Set,
    Map,
    console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  vm.createContext(context);
  const run = () => vm.runInContext(SCRIPT, context);
  const pushStatus = status => {
    state.backendStatus = structuredClone(status);
    state.storageListener(
      { cleanupStatus: { newValue: structuredClone(status) } },
      'session',
    );
  };
  return { elements, clock, state, run, pushStatus };
}

test('初始化按完整网址统计并显示实际快捷键，用户点击前不导航', async () => {
  const popup = fixture();
  popup.run();
  await settle();

  assert.equal(popup.elements['tab-count'].textContent, '3');
  assert.equal(popup.elements['duplicate-count'].textContent, '1');
  assert.equal(popup.elements['shortcut-value'].textContent, 'Command+Shift+Y');
  assert.equal(popup.elements['cleanup-tabs'].disabled, false);
  assert.equal(popup.state.calls.some(call => ['create', 'options'].includes(call.type)), false);

  await popup.elements['open-dashboard'].click();
  await popup.elements['open-settings'].click();
  await popup.elements['edit-shortcut'].click();
  assert.deepEqual(
    popup.state.calls.filter(call => call.type === 'create').map(call => call.createProperties.url),
    ['chrome-extension://unit/dashboard.html', 'chrome://extensions/shortcuts'],
  );
  assert.equal(popup.state.calls.filter(call => call.type === 'options').length, 1);

  const unassigned = fixture({ shortcut: '' });
  unassigned.run();
  await settle();
  assert.equal(unassigned.elements['shortcut-value'].textContent, '未分配');
});

test('部分结果和整体失败都如实展示，且不会自动重试', async () => {
  const partial = fixture({
    deduplicateResponse: {
      ok: true,
      closed: 2,
      skipped: 3,
      failed: 1,
      remaining: 1,
      warning: '结果已完成，但状态保存失败。',
    },
  });
  partial.run();
  await settle();
  await partial.elements['cleanup-tabs'].click();
  await settle();
  assert.match(partial.elements['operation-summary'].textContent, /已关闭 2 个/);
  assert.match(partial.elements['operation-summary'].textContent, /仍有 1 个/);
  assert.match(partial.elements['operation-details'].textContent, /跳过 3 个/);
  assert.match(partial.elements['operation-details'].textContent, /失败 1 个/);
  assert.match(partial.elements['operation-details'].textContent, /状态保存失败/);
  assert.equal(partial.state.calls.filter(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS').length, 1);

  const failed = fixture({ deduplicateResponse: { ok: false, error: '无法关闭这些标签。' } });
  failed.run();
  await settle();
  await failed.elements['cleanup-tabs'].click();
  await settle();
  assert.equal(failed.elements['cleanup-state'].textContent, '未完成');
  assert.equal(failed.elements['operation-summary'].textContent, '无法关闭这些标签。');
  assert.match(failed.elements['operation-details'].textContent, /不会自动重试/);
  assert.equal(failed.elements['cleanup-tabs'].disabled, false);
  assert.equal(failed.state.calls.filter(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS').length, 1);
});

test('session从running推到done会更新按钮，5秒后才显示原生提示提醒', async () => {
  const popup = fixture({ now: 20_000 });
  popup.run();
  await settle();

  popup.pushStatus({ state: 'running', startedAt: 18_000, origin: 'shortcut' });
  await settle();
  assert.equal(popup.elements['cleanup-state'].textContent, '清理中');
  assert.equal(popup.elements['cleanup-tabs'].disabled, true);
  assert.equal(popup.elements['native-prompt-hint'].hidden, true);
  popup.clock.advance(2_999);
  assert.equal(popup.elements['native-prompt-hint'].hidden, true);
  popup.clock.advance(1);
  assert.equal(popup.elements['native-prompt-hint'].hidden, false);

  popup.pushStatus({
    state: 'done',
    result: { closed: 4, skipped: 2, failed: 0, remaining: 0 },
    startedAt: 18_000,
    finishedAt: 23_000,
    origin: 'shortcut',
  });
  await settle();
  assert.equal(popup.elements['cleanup-state'].textContent, '已完成');
  assert.match(popup.elements['operation-summary'].textContent, /已关闭 4 个/);
  assert.equal(popup.elements['cleanup-tabs'].disabled, false);
  assert.equal(popup.elements['native-prompt-hint'].hidden, true);
});

test('重开popup能恢复running状态，读取失败后只在显式点击时重试', async () => {
  const reopened = fixture({
    now: 30_000,
    status: { state: 'running', startedAt: 24_000, origin: 'shortcut' },
  });
  reopened.run();
  await settle();
  assert.equal(reopened.elements['cleanup-state'].textContent, '清理中');
  assert.equal(reopened.elements['cleanup-tabs'].disabled, true);
  assert.equal(reopened.elements['native-prompt-hint'].hidden, false);
  assert.equal(reopened.state.calls.some(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS'), false);

  const retry = fixture({ failTabs: true, failStatus: true, failShortcut: true });
  retry.run();
  await settle();
  assert.equal(retry.elements['load-error'].hidden, false);
  assert.match(retry.elements['load-error-text'].textContent, /标签统计读取失败/);
  assert.match(retry.elements['load-error-text'].textContent, /清理状态读取失败/);
  assert.match(retry.elements['load-error-text'].textContent, /快捷键读取失败/);
  assert.equal(retry.elements['cleanup-tabs'].disabled, true);

  const queriesBeforeRetry = retry.state.calls.filter(call => call.type === 'query').length;
  retry.state.failTabs = false;
  retry.state.failStatus = false;
  retry.state.failShortcut = false;
  retry.state.shortcut = '';
  await retry.elements['retry-load'].click();
  await settle();
  assert.equal(retry.state.calls.filter(call => call.type === 'query').length, queriesBeforeRetry + 1);
  assert.equal(retry.elements['load-error'].hidden, true);
  assert.equal(retry.elements['tab-count'].textContent, '3');
  assert.equal(retry.elements['shortcut-value'].textContent, '未分配');
  assert.equal(retry.elements['cleanup-tabs'].disabled, false);
  assert.equal(retry.state.calls.some(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS'), false);
});

test('storage推送和本地清理使更早GET的成功或失败响应失效', async () => {
  for (const staleOutcome of ['success', 'failure']) {
    const statusGate = gate();
    const popup = fixture({
      statusHandler: (_message, request) => request === 1
        ? statusGate.promise
        : { ok: true, status: structuredClone(popup.state.backendStatus) },
    });
    popup.run();
    await settle();

    popup.pushStatus({
      state: 'done',
      result: { closed: 3, skipped: 1, failed: 0, remaining: 0 },
      operationId: 'new-operation',
      finishedAt: 10_000,
      origin: 'shortcut',
    });
    await settle();
    assert.equal(popup.elements['cleanup-state'].textContent, '已完成');
    if (staleOutcome === 'success') {
      statusGate.resolve({ ok: true, status: { state: 'idle' } });
    } else {
      statusGate.reject(new Error('Late status failure'));
    }
    await settle();
    assert.equal(popup.elements['cleanup-state'].textContent, '已完成');
    assert.match(popup.elements['operation-summary'].textContent, /已关闭 3 个/);
    assert.equal(popup.elements['load-error'].hidden, true);
    assert.equal(popup.elements['cleanup-tabs'].disabled, false);
  }

  const initialStatus = gate();
  let local;
  local = fixture({
    statusHandler: (_message, request) => request === 1
      ? initialStatus.promise
      : { ok: true, status: structuredClone(local.state.backendStatus) },
    deduplicateResponse: {
      ok: true,
      closed: 1,
      skipped: 0,
      failed: 0,
      remaining: 0,
      warning: '结果已完成，但状态保存失败。',
    },
  });
  local.run();
  await settle();
  local.pushStatus({ state: 'idle', operationId: 'before-click' });
  await settle();
  await local.elements['cleanup-tabs'].click();
  await settle();
  initialStatus.reject(new Error('Late initial GET failure'));
  await settle();
  assert.equal(local.elements['cleanup-state'].textContent, '已完成');
  assert.match(local.elements['operation-summary'].textContent, /已关闭 1 个/);
  assert.equal(local.elements['load-error'].hidden, true);
});

test('终态推送刷新快照，旧查询的成功和失败都不能覆盖新快照', async () => {
  const firstQuery = gate();
  const secondQuery = gate();
  const thirdQuery = gate();
  const fourthQuery = gate();
  const queries = [firstQuery, secondQuery, thirdQuery, fourthQuery];
  const popup = fixture({ queryHandler: (_query, index) => queries[index - 1].promise });
  popup.run();
  await settle();
  assert.equal(popup.state.calls.filter(call => call.type === 'query').length, 1);

  popup.pushStatus({
    state: 'done',
    result: { closed: 1, skipped: 0, failed: 0, remaining: 0 },
    operationId: 'done-operation',
  });
  await settle();
  popup.pushStatus({
    state: 'error',
    error: '清理失败。',
    operationId: 'error-operation',
  });
  await settle();
  popup.pushStatus({
    state: 'interrupted',
    error: '结果无法确认。',
    operationId: 'interrupted-operation',
  });
  await settle();
  assert.equal(popup.state.calls.filter(call => call.type === 'query').length, 4);

  fourthQuery.resolve([{ id: 8, url: 'https://fresh.test/', incognito: false }]);
  await settle();
  assert.equal(popup.elements['tab-count'].textContent, '1');
  assert.equal(popup.elements['duplicate-count'].textContent, '0');

  thirdQuery.resolve([
    { id: 10, url: 'https://stale.test/', incognito: false },
    { id: 11, url: 'https://stale.test/', incognito: false },
  ]);
  secondQuery.reject(new Error('Late tabs failure'));
  firstQuery.resolve([{ id: 12, url: 'https://older.test/', incognito: false }]);
  await settle();
  assert.equal(popup.elements['tab-count'].textContent, '1');
  assert.equal(popup.elements['duplicate-count'].textContent, '0');
  assert.equal(popup.elements['load-error'].hidden, true);
});

test('done缺少有效result时显示读取失败并禁止清理', async () => {
  const malformedInitial = fixture({ status: { state: 'done', result: null } });
  malformedInitial.run();
  await settle();
  assert.equal(malformedInitial.elements['cleanup-state'].textContent, '读取失败');
  assert.equal(malformedInitial.elements['cleanup-tabs'].disabled, true);
  assert.equal(malformedInitial.elements['load-error'].hidden, false);
  assert.doesNotMatch(malformedInitial.elements['operation-summary'].textContent, /没有需要关闭/);

  const malformedPush = fixture();
  malformedPush.run();
  await settle();
  assert.equal(malformedPush.elements['cleanup-tabs'].disabled, false);
  malformedPush.pushStatus({ state: 'done', result: { closed: '0' }, operationId: 'bad-operation' });
  await settle();
  assert.equal(malformedPush.elements['cleanup-state'].textContent, '读取失败');
  assert.equal(malformedPush.elements['cleanup-tabs'].disabled, true);
  assert.match(malformedPush.elements['load-error-text'].textContent, /清理状态读取失败/);
});

test('低频GET在无storage事件时发现running完成和idle首写失败，不会触发清理', async () => {
  const running = fixture({
    now: 40_000,
    status: {
      state: 'running',
      operationId: 'shortcut-running',
      startedAt: 40_000,
      origin: 'shortcut',
    },
  });
  running.run();
  await settle();
  running.state.backendStatus = {
    state: 'done',
    operationId: 'shortcut-running',
    result: { closed: 2, skipped: 0, failed: 0, remaining: 0 },
    startedAt: 40_000,
    finishedAt: 42_000,
    origin: 'shortcut',
  };
  running.clock.advance(2_000);
  await settle();
  assert.equal(running.elements['cleanup-state'].textContent, '已完成');
  assert.match(running.elements['operation-summary'].textContent, /已关闭 2 个/);
  assert.equal(running.state.calls.some(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS'), false);

  const idle = fixture({ now: 50_000 });
  idle.run();
  await settle();
  idle.state.backendStatus = {
    state: 'error',
    operationId: 'shortcut-write-failure',
    error: '无法记录清理状态，尚未开始关闭标签。',
    finishedAt: 55_000,
    origin: 'shortcut',
  };
  idle.clock.advance(5_000);
  await settle();
  assert.equal(idle.elements['cleanup-state'].textContent, '未完成');
  assert.match(idle.elements['operation-summary'].textContent, /无法记录清理状态/);
  assert.equal(idle.state.calls.some(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS'), false);
});

test('running状态连续三次GET失败后停止轮询并等待手动刷新', async () => {
  const popup = fixture({
    now: 60_000,
    status: {
      state: 'running',
      operationId: 'running-failures',
      startedAt: 60_000,
      origin: 'shortcut',
    },
  });
  popup.run();
  await settle();
  popup.state.failStatus = true;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    popup.clock.advance(2_000);
    await settle();
  }
  assert.equal(popup.elements['cleanup-state'].textContent, '暂无法确认');
  assert.match(popup.elements['operation-details'].textContent, /已停止自动同步/);
  assert.equal(popup.elements['cleanup-tabs'].disabled, true);
  const requestsAfterThreeFailures = popup.state.statusRequestCount;

  popup.clock.advance(20_000);
  await settle();
  assert.equal(popup.state.statusRequestCount, requestsAfterThreeFailures);

  popup.state.failStatus = false;
  popup.state.backendStatus = { state: 'idle' };
  await popup.elements['retry-load'].click();
  await settle();
  assert.equal(popup.elements['cleanup-state'].textContent, '就绪');
  assert.equal(popup.elements['cleanup-tabs'].disabled, false);
});

test('DEDUP已确认成功后GET失败保留closed结果并只追加同步警告', async () => {
  let popup;
  popup = fixture({
    statusHandler: (_message, request) => {
      if (request === 1) return { ok: true, status: { state: 'idle' } };
      throw new Error('Status temporarily unavailable');
    },
    deduplicateResponse: {
      ok: true,
      closed: 2,
      skipped: 1,
      failed: 0,
      remaining: 0,
    },
  });
  popup.run();
  await settle();
  await popup.elements['cleanup-tabs'].click();
  await settle();

  assert.equal(popup.elements['cleanup-state'].textContent, '已完成');
  assert.match(popup.elements['operation-summary'].textContent, /已关闭 2 个/);
  assert.match(popup.elements['operation-details'].textContent, /跳过 1 个/);
  assert.match(popup.elements['operation-details'].textContent, /显示上次已确认结果/);
  assert.equal(popup.state.calls.filter(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS').length, 1);
});

test('DEDUP传输拒绝后旧done或idle不能覆盖本次失败，轮询也不自动重试', async () => {
  const popup = fixture({
    now: 70_000,
    status: {
      state: 'done',
      operationId: 'previous-operation',
      result: { closed: 8, skipped: 0, failed: 0, remaining: 0 },
      finishedAt: 69_000,
      origin: 'shortcut',
    },
    deduplicateReject: '无法连接后台清理任务。',
  });
  popup.run();
  await settle();
  assert.match(popup.elements['operation-summary'].textContent, /已关闭 8 个/);

  await popup.elements['cleanup-tabs'].click();
  await settle();
  assert.equal(popup.elements['cleanup-state'].textContent, '未完成');
  assert.equal(popup.elements['operation-summary'].textContent, '无法连接后台清理任务。');
  assert.doesNotMatch(popup.elements['operation-summary'].textContent, /已关闭 8 个/);

  popup.clock.advance(5_000);
  await settle();
  assert.equal(popup.elements['operation-summary'].textContent, '无法连接后台清理任务。');
  assert.equal(popup.state.calls.filter(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS').length, 1);
  assert.equal(popup.elements['cleanup-tabs'].disabled, false);

  const idle = fixture({
    now: 80_000,
    status: { state: 'idle' },
    deduplicateReject: '后台连接已中断。',
  });
  idle.run();
  await settle();
  await idle.elements['cleanup-tabs'].click();
  await settle();
  idle.clock.advance(5_000);
  await settle();
  assert.equal(idle.elements['operation-summary'].textContent, '后台连接已中断。');
  assert.equal(idle.state.calls.filter(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS').length, 1);
});

test('权威GET已确认完成后周期读取失败仍保留真实结果，恢复后更新状态', async () => {
  const popup = fixture();
  popup.run();
  await settle();
  await popup.elements['cleanup-tabs'].click();
  await settle();
  assert.equal(popup.elements['cleanup-state'].textContent, '已完成');
  assert.match(popup.elements['operation-summary'].textContent, /已关闭 1 个/);
  popup.state.failStatus = true;
  popup.clock.advance(5_000);
  await settle();
  assert.equal(popup.elements['cleanup-state'].textContent, '已完成');
  assert.match(popup.elements['operation-summary'].textContent, /已关闭 1 个/);
  assert.match(popup.elements['operation-details'].textContent, /显示上次已确认结果/);
  assert.equal(popup.elements['cleanup-tabs'].disabled, true);
  popup.state.failStatus = false;
  popup.state.backendStatus = { state: 'running', operationId: 'new-shortcut', startedAt: popup.clock.now() };
  popup.clock.advance(5_000);
  await settle();
  assert.equal(popup.elements['cleanup-state'].textContent, '清理中');
  assert.equal(popup.elements['load-error'].hidden, true);
  assert.equal(popup.state.calls.filter(call => call.type === 'message'
    && call.message.type === 'DEDUPLICATE_TABS').length, 1);
});
