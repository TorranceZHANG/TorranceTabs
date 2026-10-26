import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanupController } from '../cleanup-controller.js';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(stored = null, deduplicate = async () => ({ closed: 2, skipped: 0, failed: 0, remaining: 0 })) {
  const state = { data: { cleanupStatus: stored }, badges: [], titles: [], calls: 0 };
  const api = {
    storage: { session: {
      async get(defaults) { return structuredClone({ ...defaults, ...state.data }); },
      async set(values) { if (state.onSet) await state.onSet(values); Object.assign(state.data, structuredClone(values)); },
    } },
    action: {
      async setBadgeText(value) { if (state.badgeError) throw Error('Badge failed'); state.badges.push(value.text); },
      async setBadgeBackgroundColor() {},
      async setTitle(value) { state.titles.push(value.title); },
    },
  };
  const run = async () => { state.calls++; return deduplicate(); };
  return { state, api, run, controller: createCleanupController(api, run) };
}

test('多个入口共享同一个任务，运行状态和结果在后台保存，面板无须持续存在', async () => {
  const pending = gate();
  const started = gate();
  const { state, controller } = fixture(null, async () => { started.resolve(); return pending.promise; });
  const first = controller.run('shortcut');
  const second = controller.run('panel');
  assert.equal(first, second);
  await started.promise;
  assert.equal(state.calls, 1);
  assert.equal((await controller.getStatus()).state, 'running');
  assert.equal(state.data.cleanupStatus.origin, 'shortcut');
  assert.equal(state.badges.at(-1), '…');
  pending.resolve({ closed: 3, skipped: 1, failed: 0, remaining: 1 });
  assert.equal((await first).closed, 3);
  const final = await controller.getStatus();
  assert.equal(final.state, 'done');
  assert.deepEqual(final.result, { closed: 3, skipped: 1, failed: 0, remaining: 1 });
  assert.equal(state.badges.at(-1), '3');
  assert.match(state.titles.at(-1), /剩余 1/);
  await controller.run('panel');
  assert.equal(state.calls, 2);
});

test('worker恢复旧running只报告结果未知，不自动发送清理；下一次显式操作可执行', async () => {
  const { state, controller } = fixture({ state: 'running', operationId: 'old', startedAt: 1 });
  const recovered = await controller.getStatus();
  assert.equal(recovered.state, 'interrupted');
  assert.match(recovered.error, /无法确认/);
  assert.equal(state.data.cleanupStatus.state, 'interrupted');
  assert.equal(state.calls, 0);
  assert.equal(state.badges.at(-1), '!');
  await controller.run();
  assert.equal(state.calls, 1);
  assert.equal((await controller.getStatus()).state, 'done');
});

test('历史完成结果可重读，不因恢复重新运行，徽标显示实际关闭数', async () => {
  const result = { closed: 125, skipped: 0, failed: 0, remaining: 0 };
  const { state, controller } = fixture({ state: 'done', result, finishedAt: 10 });
  assert.deepEqual((await controller.getStatus()).result, result);
  assert.equal(state.calls, 0);
  assert.equal(state.badges.at(-1), '99+');
});

test('失败如实记录，不自动重试；徽标失败不阻止正常清理', async () => {
  const { state, controller } = fixture(null, async () => { throw Error('Cannot confirm final tabs'); });
  state.badgeError = true;
  await assert.rejects(controller.run(), /Cannot confirm/);
  assert.equal(state.calls, 1);
  assert.equal((await controller.getStatus()).state, 'error');
  assert.match(state.data.cleanupStatus.error, /Cannot confirm/);
});

test('开始状态无法保存时不关闭任何标签；结果保存失败保留真实结果并提示', async () => {
  const before = fixture();
  before.state.onSet = () => { throw Error('Storage full'); };
  await assert.rejects(before.controller.run(), /尚未开始/);
  assert.equal(before.state.calls, 0);
  const after = fixture();
  after.state.onSet = values => { if (values.cleanupStatus.state === 'done') throw Error('Storage full'); };
  const result = await after.controller.run();
  assert.equal(after.state.calls, 1);
  assert.equal(result.closed, 2);
  assert.match(result.warning, /未能保存/);
  assert.equal((await after.controller.getStatus()).state, 'done');
});

test('读取历史状态失败仍允许用户显式清理，不误报上次已完成', async () => {
  let runs = 0;
  const api = { storage: { session: { async get() { throw Error('Read failed'); }, async set() {} } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} } };
  const controller = createCleanupController(api, async () => { runs++; return { closed: 0, skipped: 0, failed: 0, remaining: 0 }; });
  assert.equal((await controller.getStatus()).state, 'error');
  await controller.run();
  assert.equal(runs, 1);
});

test('确认请求原样透传给deduplicator且仍受共享operationLock保护', async () => {
  const requests = [];
  const lockCalls = [];
  const api = { storage: { session: { async get(defaults) { return defaults; }, async set() {} } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} } };
  const operationLock = { async run(kind, task) { lockCalls.push(kind); return task(); } };
  const controller = createCleanupController(api, async request => {
    requests.push(request);
    return { closed: 0, skipped: 0, failed: 0, remaining: 0 };
  }, { operationLock });
  const request = { token: 'dedup-token', selections: [{ bucketId: 'bucket', keeperId: 7 }] };
  await controller.run('review', request);
  assert.deepEqual(requests, [request]);
  assert.deepEqual(lockCalls, ['cleanup']);
});
