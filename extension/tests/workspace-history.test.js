import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_SNAPSHOT_ALARM, createSnapshotService } from '../workspace-history.js';
import { createLibraryStore, createLocalWriteQueue } from '../library-store.js';

const workspace = url => ({ id: 'w', name: '空间', savedAt: 1, windows: [{ tabs: [
  { url, title: url, pinned: false, index: 0, group: null },
] }] });

function fixture() {
  const data = { autoSnapshotConfig: { enabled: false, intervalMinutes: 30 }, autoSnapshots: [] };
  const calls = [];
  const localSets = [];
  const sessionData = {};
  const area = values => ({ async get(defaults) { return structuredClone({ ...(defaults || {}), ...values }); },
    async set(changes) { if (values.failSet) throw Error('quota'); if (values === data) localSets.push(structuredClone(changes)); Object.assign(values, structuredClone(changes)); },
    async remove(key) { delete values[key]; } });
  const local = area(data);
  const api = { storage: { local, session: area(sessionData) }, alarms: { async clear(name) { calls.push(['clear', name]); },
    async create(name, config) { calls.push(['create', name, config]); } } };
  let currentWorkspace = workspace('https://v0.test/');
  data.library = { schemaVersion: 1, revision: 0, favorites: [null, null, null], dedupRules: [], workspaces: [] };
  const store = createLibraryStore(api, createLocalWriteQueue(), () => 100);
  const libraryService = { async captureCurrentWorkspace() { return { workspace: structuredClone(currentWorkspace), saved: 1, skipped: 0 }; } };
  const lock = { run(_name, task) { return task(); } };
  return { data, calls, localSets, setLibrary(value) { data.library = value; currentWorkspace = value.workspaces[0]; },
    service: createSnapshotService(api, store, libraryService, lock, () => 100) };
}

test('自动快照默认关闭，配置仅接受15/30/60分钟并维护alarm', async () => {
  const value = fixture();
  assert.deepEqual((await value.service.getState()).config, { enabled: false, intervalMinutes: 30, retention: 5 });
  assert.deepEqual(await value.service.capture(), { captured: false, reason: 'disabled' });
  await assert.rejects(value.service.configure({ enabled: true, intervalMinutes: 10 }), /无效/);
  const configured = await value.service.configure({ enabled: true, intervalMinutes: 15 });
  assert.deepEqual(configured, { enabled: true, intervalMinutes: 15, retention: 5 });
  assert.deepEqual(value.calls, [['clear', AUTO_SNAPSHOT_ALARM], ['create', AUTO_SNAPSHOT_ALARM, { periodInMinutes: 15 }]]);
});

test('快照读取当前浏览器而非已保存library，内容未变跳过并按配置保留', async () => {
  const value = fixture();
  await value.service.configure({ enabled: true, intervalMinutes: 30, retention: 2 });
  assert.equal((await value.service.capture()).captured, true);
  assert.deepEqual(await value.service.capture(), { captured: false, reason: 'unchanged' });
  assert.deepEqual(await value.service.handleAlarm({ name: 'other' }), { handled: false });
  for (let index = 1; index <= 5; index += 1) {
    value.setLibrary({ schemaVersion: 1, revision: index, favorites: [null, null, null], dedupRules: [],
      workspaces: [workspace(`https://v${index}.test/`)] });
    assert.equal((await value.service.handleAlarm({ name: AUTO_SNAPSHOT_ALARM })).captured, true);
  }
  assert.equal(value.data.autoSnapshots.length, 2);
  const state = await value.service.getState();
  assert.equal(state.snapshots.length, 2);
  assert.equal(state.snapshots[0].workspace.windows[0].tabs[0].url, 'https://v5.test/');
  assert.equal(state.snapshots.some(item => item.workspace.windows[0].tabs[0].url === 'https://v0.test/'), false);
  assert.equal(typeof state.snapshots[0].versionId, 'string');
});

test('快照持久化失败不覆盖上一份', async () => {
  const value = fixture();
  assert.equal((await value.service.capture({ manual: true })).captured, true);
  const before = structuredClone(value.data.autoSnapshots);
  value.data.failSet = true;
  value.setLibrary({ schemaVersion: 1, revision: 1, favorites: [null, null, null], dedupRules: [],
    workspaces: [workspace('https://changed.test/')] });
  await assert.rejects(value.service.capture({ manual: true }), /quota/);
  assert.deepEqual(value.data.autoSnapshots, before);
});

test('retention调小立即以单次写入裁剪已有快照', async () => {
  const value = fixture();
  await value.service.capture({ manual: true });
  value.setLibrary({ schemaVersion: 1, revision: 1, favorites: [null, null, null], dedupRules: [],
    workspaces: [workspace('https://second.test/')] });
  await value.service.capture({ manual: true });
  assert.equal(value.data.autoSnapshots.length, 2);
  await value.service.configure({ enabled: false, intervalMinutes: 30, retention: 1 });
  assert.equal(value.data.autoSnapshots.length, 1);
  const written = value.localSets.at(-1);
  assert.deepEqual(Object.keys(written).sort(), ['autoSnapshotConfig', 'autoSnapshots', 'workspaceHistory']);
  assert.equal(written.autoSnapshots.length, 1);
});
