import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, createLocalWriteQueue } from '../library-store.js';
import { createSyncService, SYNC_STORAGE_PREFIX } from '../selective-sync.js';

const baseLocal = () => ({ settings: { enabled: true, duplicatePromptEnabled: true, rules: [] }, readingList: [],
  preferences: { theme: 'dark', density: 'compact' }, duplicateAllowlist: [],
  library: { schemaVersion: 1, revision: 1, favorites: [null, null, null], dedupRules: [], workspaces: [] } });
const remote = (deviceId, sections, revision = 1) => ({ schemaVersion: 1, remoteId: deviceId, revision, updatedAt: revision,
  sections });

function fixture() {
  const localData = baseLocal();
  const syncData = {};
  const sessionData = {};
  const calls = { syncGet: 0 };
  const area = (data, kind) => ({ async get(defaults) {
    if (kind === 'sync') calls.syncGet += 1;
    if (defaults === null) return structuredClone(data);
    return structuredClone({ ...(defaults || {}), ...data });
  }, async set(values) {
    if (data.failSet) throw Error(`${kind} quota`);
    Object.assign(data, structuredClone(values));
  }, async remove(key) { delete data[key]; } });
  const api = { storage: { local: area(localData, 'local'), sync: area(syncData, 'sync'), session: area(sessionData, 'session') } };
  const enqueue = createLocalWriteQueue();
  const store = createLibraryStore(api, enqueue, () => 1);
  return { api, localData, syncData, sessionData, calls, store, service: createSyncService(api, store, enqueue, () => 10) };
}

test('同步默认关闭，每设备只写独立槽位并用自身远端摘要防过时', async () => {
  const value = fixture();
  assert.equal((await value.service.getState()).config.enabled, false);
  assert.equal(value.calls.syncGet, 0);
  await assert.rejects(value.service.upload({ sections: ['preferences'], baseRemoteDigest: null }), /显式启用/);
  const configured = await value.service.configure({ enabled: true });
  assert.equal(typeof configured.deviceId, 'string');
  value.syncData[`${SYNC_STORAGE_PREFIX}other`] = remote('other', { preferences: { theme: 'light', density: 'comfortable' } });
  await assert.rejects(value.service.upload({ sections: ['preferences'], baseRemoteDigest: 'stale' }), /已变化/);
  const uploaded = await value.service.upload({ sections: ['preferences'], baseRemoteDigest: null });
  assert.equal(uploaded.revision, 1);
  assert.ok(value.syncData[`${SYNC_STORAGE_PREFIX}${configured.deviceId}`]);
  assert.ok(value.syncData[`${SYNC_STORAGE_PREFIX}other`]);
  const state = await value.service.getState();
  assert.equal(state.devices.length, 2);
  assert.equal(state.deviceId, configured.deviceId);
  assert.equal(state.remoteDigest, uploaded.remoteDigest);
  const second = await value.service.upload({ sections: ['favorites'], baseRemoteDigest: state.remoteDigest });
  assert.equal(second.revision, 2);
  assert.ok(value.syncData[`${SYNC_STORAGE_PREFIX}other`]);
});

test('同设备并发上传经共享队列串行化，同一base摘要至多一次成功', async () => {
  const value = fixture();
  await value.service.configure({ enabled: true });
  const first = value.service.upload({ sections: ['preferences'], baseRemoteDigest: null });
  const second = value.service.upload({ sections: ['favorites'], baseRemoteDigest: null });
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(item => item.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /已变化/);
  assert.equal(Object.keys(value.syncData).filter(key => key.startsWith(SYNC_STORAGE_PREFIX)).length, 1);
});

test('预览必须明确选择设备，应用前同时复核远端和本机且一次写入所选scope', async () => {
  const value = fixture();
  await value.service.configure({ enabled: true });
  value.syncData[`${SYNC_STORAGE_PREFIX}phone`] = remote('phone', {
    preferences: { theme: 'light', density: 'comfortable' },
    favorites: [{ name: '手机', url: 'https://phone.test/' }, null, null],
  });
  await assert.rejects(value.service.preview({ sections: ['preferences'] }), /请选择/);
  const preview = await value.service.preview({ sections: ['preferences', 'favorites'], remoteId: 'phone' });
  assert.equal(preview.changes.preferences, true);
  value.localData.preferences = { theme: 'system', density: 'comfortable' };
  await assert.rejects(value.service.apply({ token: preview.token }), /本机数据已变化/);
  assert.equal(value.localData.library.favorites[0], null);

  value.localData.preferences = { theme: 'dark', density: 'compact' };
  const next = await value.service.preview({ sections: ['preferences', 'favorites'], remoteId: 'phone' });
  const applied = await value.service.apply({ token: next.token });
  assert.deepEqual(applied.sections, ['preferences', 'favorites']);
  assert.deepEqual(value.localData.preferences, { theme: 'light', density: 'comfortable' });
  assert.equal(value.localData.library.favorites[0].url, 'https://phone.test/');
  assert.equal(value.localData.library.revision, 2);
});

test('rules同步仅传规则数组，应用时保留本机两个开关', async () => {
  const value = fixture();
  value.localData.settings = { enabled: false, duplicatePromptEnabled: false, rules: [] };
  await value.service.configure({ enabled: true });
  value.syncData[`${SYNC_STORAGE_PREFIX}phone`] = remote('phone', { rules: [
    { prefix: 'https://rule.test/', group: '同步组', color: 'blue', enabled: true, excludePaths: ['/private'] },
  ] });
  const preview = await value.service.preview({ sections: ['rules'], remoteId: 'phone' });
  assert.ok(Array.isArray(preview.remote.rules));
  await value.service.apply({ token: preview.token });
  assert.equal(value.localData.settings.enabled, false);
  assert.equal(value.localData.settings.duplicatePromptEnabled, false);
  assert.equal(value.localData.settings.rules[0].prefix, 'https://rule.test/');
});

test('远端预览后发生变化会拒绝应用，网络或配额失败不修改local', async () => {
  const value = fixture();
  const configured = await value.service.configure({ enabled: true });
  value.syncData[`${SYNC_STORAGE_PREFIX}phone`] = remote('phone', { preferences: { theme: 'light', density: 'comfortable' } });
  const preview = await value.service.preview({ sections: ['preferences'], remoteId: 'phone' });
  value.syncData[`${SYNC_STORAGE_PREFIX}phone`].revision = 2;
  await assert.rejects(value.service.apply({ token: preview.token }), /云端数据已变化/);
  assert.deepEqual(value.localData.preferences, { theme: 'dark', density: 'compact' });

  const before = structuredClone(value.localData);
  value.syncData.failSet = true;
  await assert.rejects(value.service.upload({ sections: ['preferences'], baseRemoteDigest: null }), /sync quota/);
  delete before.failSet;
  assert.deepEqual(value.localData, before);
  assert.equal(value.localData.selectiveSyncDeviceId, configured.deviceId);
});

test('单设备payload超过7KiB时明确拒绝，云端设备最多八槽', async () => {
  const large = fixture();
  await large.service.configure({ enabled: true });
  large.localData.settings.rules = Array.from({ length: 90 }, (_, index) => ({
    prefix: `https://large.test/${index}/${'x'.repeat(90)}`, group: `group-${index}-${'y'.repeat(30)}`, color: 'blue', enabled: true,
  }));
  await assert.rejects(large.service.upload({ sections: ['rules'], baseRemoteDigest: null }), /7 KB/);
  assert.equal(Object.keys(large.syncData).length, 0);

  const full = fixture();
  await full.service.configure({ enabled: true });
  for (let index = 0; index < 8; index += 1) {
    full.syncData[`${SYNC_STORAGE_PREFIX}d${index}`] = remote(`d${index}`, { preferences: { theme: 'system', density: 'comfortable' } });
  }
  await assert.rejects(full.service.upload({ sections: ['preferences'], baseRemoteDigest: null }), /8 台/);
});
