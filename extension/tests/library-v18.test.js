import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalDataSize, createLibraryStore, createLocalWriteQueue } from '../library-store.js';

const tab = url => ({ url, title: url, pinned: false, index: 0, group: null });
const workspace = (id, url, savedAt = 1) => ({ id, name: id, savedAt, windows: [{ tabs: [tab(url)] }] });
const settings = { enabled: true, duplicatePromptEnabled: true, rules: [] };

function fixture() {
  const data = { settings, readingList: [], preferences: { theme: 'dark', density: 'compact' },
    duplicateAllowlist: ['https://allowed.test'], workspaceHistory: { schemaVersion: 1, byWorkspace: {} },
    library: { schemaVersion: 1, revision: 2, favorites: [null, null, null], dedupRules: [],
      workspaces: [workspace('w', 'https://old.test/')] } };
  const session = {};
  const sets = [];
  const area = state => ({ async get(defaults) { return structuredClone({ ...(defaults || {}), ...state }); },
    async set(values) { sets.push(structuredClone(values)); if (state.failSet) throw Error('quota'); Object.assign(state, structuredClone(values)); },
    async remove(key) { delete state[key]; } });
  const api = { storage: { local: area(data), session: area(session) } };
  return { data, sets, store: createLibraryStore(api, createLocalWriteQueue(), () => 99) };
}

test('更新工作区以单次set原子写library和历史，保留最近五版并拒绝过期revision', async () => {
  const value = fixture();
  await assert.rejects(value.store.updateWorkspace('w', 1, workspace('w', 'https://stale.test/')), /重新读取/);
  assert.equal(value.sets.length, 0);
  for (let index = 0; index < 6; index += 1) {
    const revision = value.data.library.revision;
    const result = await value.store.updateWorkspace('w', revision, workspace('w', `https://v${index}.test/`, index + 2));
    assert.equal(result.library.revision, revision + 1);
    const lastSet = value.sets.at(-1);
    assert.deepEqual(Object.keys(lastSet).sort(), ['autoSnapshots', 'library', 'workspaceHistory']);
  }
  const history = await value.store.getWorkspaceHistory('w');
  assert.equal(history.length, 5);
  assert.equal(history[0].workspace.windows[0].tabs[0].url, 'https://v4.test/');
  assert.equal(history.at(-1).workspace.windows[0].tabs[0].url, 'https://v0.test/');
});

test('历史与library写入失败时旧数据完整保留', async () => {
  const value = fixture();
  const before = structuredClone(value.data);
  value.data.failSet = true;
  await assert.rejects(value.store.updateWorkspace('w', 2, workspace('w', 'https://new.test/')), /quota/);
  delete before.failSet;
  delete value.data.failSet;
  assert.deepEqual(value.data, before);
});

test('v2备份导出稳定配置，导入旧v1缺失字段时不清空本机新配置', async () => {
  const value = fixture();
  const exported = await value.store.exportConfig();
  assert.equal(exported.schemaVersion, 2);
  assert.deepEqual(exported.preferences, { theme: 'dark', density: 'compact' });
  assert.deepEqual(exported.duplicateAllowlist, ['https://allowed.test']);

  const old = { schemaVersion: 1, exportedAt: 1, settings, readingList: [], favorites: [null, null, null],
    dedupRules: [], workspaces: [] };
  const preview = await value.store.previewConfig(old, 'replace');
  await value.store.importConfig(preview.token, old);
  assert.deepEqual(value.data.preferences, { theme: 'dark', density: 'compact' });
  assert.deepEqual(value.data.duplicateAllowlist, ['https://allowed.test']);
});

test('本地工具数据具有明确5MB总限额', () => {
  assert.throws(() => assertLocalDataSize({ oversized: 'x'.repeat(5 * 1024 * 1024) }), /5 MB/);
});

test('旧版已超5MB时允许净缩减但拒绝继续增长', async () => {
  const value = fixture();
  const hugeTabs = Array.from({ length: 7 }, (_, index) => tab(`https://legacy.test/${index}/${'x'.repeat(7900)}`));
  value.data.library.workspaces = Array.from({ length: 100 }, (_, index) => ({ id: `legacy-${index}`, name: `旧${index}`,
    savedAt: 1, windows: [{ tabs: hugeTabs.map((item, tabIndex) => ({ ...item, index: tabIndex,
      title: '旧页', url: item.url.replace('legacy.test', `legacy-${index}.test`) })) }] }));
  await assert.rejects(value.store.setLocal({ growingMarker: 'x' }), /5 MB/);
  const beforeBytes = new TextEncoder().encode(JSON.stringify(value.data)).length;
  await value.store.updateLibrary(library => ({ ...library, workspaces: library.workspaces.slice(1) }));
  const afterBytes = new TextEncoder().encode(JSON.stringify(value.data)).length;
  assert.ok(afterBytes < beforeBytes);
  assert.equal(value.data.library.workspaces.length, 99);
});

test('历史与自动快照共享1MB预算，新增快照优先并全局淘汰最旧项', async () => {
  const value = fixture();
  const largeWorkspace = (id, stamp) => ({ id, name: id, savedAt: stamp, windows: [{ tabs: Array.from({ length: 30 }, (_, index) =>
    tab(`https://${id}.test/${index}/${'x'.repeat(6900)}`)).map((item, index) => ({ ...item, title: '页', index })) }] });
  value.data.workspaceHistory = { schemaVersion: 1, byWorkspace: { w: [{ versionId: 'old-history', archivedAt: 1,
    workspace: largeWorkspace('w', 1) }] } };
  value.data.autoSnapshotConfig = { enabled: true, intervalMinutes: 30, retention: 5 };
  value.data.autoSnapshots = [2, 3, 4].map(stamp => ({ snapshotId: `s${stamp}`, capturedAt: stamp,
    libraryRevision: stamp, digest: `d${stamp}`, workspaces: [largeWorkspace(`auto-${stamp}`, stamp)] }));
  const newest = { snapshotId: 'newest', capturedAt: 5, libraryRevision: 5, digest: 'newest',
    workspaces: [largeWorkspace('auto-new', 5)] };
  const result = await value.store.saveAutoSnapshot(newest, { manual: true });
  assert.equal(result.captured, true);
  assert.equal(value.data.autoSnapshots.some(item => item.snapshotId === 'newest'), true);
  assert.equal(value.data.workspaceHistory.byWorkspace.w, undefined);
  const archiveBytes = new TextEncoder().encode(JSON.stringify({ workspaceHistory: value.data.workspaceHistory,
    autoSnapshots: value.data.autoSnapshots })).length;
  assert.ok(archiveBytes <= 1024 * 1024);
  assert.deepEqual(Object.keys(value.sets.at(-1)).sort(), ['autoSnapshots', 'workspaceHistory']);
});

test('单份自动快照超过1MB明确拒绝且不截断标签', async () => {
  const value = fixture();
  value.data.autoSnapshotConfig = { enabled: true, intervalMinutes: 30, retention: 5 };
  const oversized = { snapshotId: 'oversized', capturedAt: 2, libraryRevision: 2, digest: 'oversized', workspaces: [{
    id: 'oversized-workspace', name: '过大', savedAt: 2, windows: [{ tabs: Array.from({ length: 140 }, (_, index) => ({
      ...tab(`https://oversized.test/${index}/${'x'.repeat(7900)}`), title: '页', index,
    })) }],
  }] };
  await assert.rejects(value.store.saveAutoSnapshot(oversized, { manual: true }), /1 MB/);
  assert.deepEqual(value.data.autoSnapshots, undefined);
  assert.equal(value.sets.length, 0);
});

test('删除工作区与replace导入在同次写入清理孤立历史', async () => {
  const deleted = fixture();
  deleted.data.workspaceHistory.byWorkspace = { w: [{ versionId: 'v1', archivedAt: 1,
    workspace: workspace('w', 'https://old.test/') }] };
  const result = await deleted.store.deleteWorkspace('w');
  assert.equal(result.deleted, true);
  assert.equal(deleted.data.workspaceHistory.byWorkspace.w, undefined);
  assert.deepEqual(Object.keys(deleted.sets.at(-1)).sort(), ['library', 'workspaceHistory']);

  const replaced = fixture();
  replaced.data.workspaceHistory.byWorkspace = { w: [{ versionId: 'v1', archivedAt: 1,
    workspace: workspace('w', 'https://old.test/') }] };
  const oldBackup = { schemaVersion: 1, exportedAt: 1, settings, readingList: [], favorites: [null, null, null],
    dedupRules: [], workspaces: [workspace('replacement', 'https://replacement.test/')] };
  const preview = await replaced.store.previewConfig(oldBackup, 'replace');
  await replaced.store.importConfig(preview.token, oldBackup);
  assert.deepEqual(replaced.data.workspaceHistory.byWorkspace, {});
  assert.ok(Object.hasOwn(replaced.sets.at(-1), 'workspaceHistory'));
  assert.ok(Object.hasOwn(replaced.sets.at(-1), 'library'));
});
