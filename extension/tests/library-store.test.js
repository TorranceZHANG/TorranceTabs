import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, createLocalWriteQueue } from '../library-store.js';

const rule = (prefix, group = '组', color = 'blue') => ({ prefix, group, color, enabled: true });
const workspace = (id, name, url = 'https://example.com/') => ({ id, name, savedAt: 1,
  windows: [{ tabs: [{ url, title: name, pinned: false, index: 0, group: null }] }] });
function fixture() {
  const data = { settings: { enabled: false, duplicatePromptEnabled: true, rules: [rule('https://a.test/')] },
    readingList: [{ id: 'r1', url: 'https://read.test/', title: '本机', savedAt: 1 }],
    library: { schemaVersion: 1, revision: 3, favorites: [{ name: '本机', url: 'https://fav.test/' }, null, null],
      dedupRules: [{ origin: 'https://example.com', ignoreParams: ['local'] }], workspaces: [workspace('w1', '本机工作区')] } };
  const session = {};
  const sets = [];
  const area = state => ({ async get(defaults) { return structuredClone({ ...defaults, ...state }); },
    async set(values) { Object.assign(state, structuredClone(values)); }, async remove(key) { delete state[key]; } });
  const local = area(data);
  const originalSet = local.set;
  local.set = async values => { sets.push(structuredClone(values)); await originalSet(values); };
  const api = { storage: { local, session: area(session) } };
  return { data, sets, store: createLibraryStore(api, createLocalWriteQueue(), () => 100) };
}
function backup() {
  return { schemaVersion: 1, exportedAt: 10,
    settings: { enabled: true, duplicatePromptEnabled: false, rules: [rule('https://a.test/', '另一组', 'red'),
      rule('https://b.test/', '新增组'), rule('https://c.test/', '组', 'red')] },
    readingList: [{ id: 'foreign', url: 'https://read.test/', title: '导入', savedAt: 2 },
      { id: 'r2', url: 'https://new.test/', title: '新增', savedAt: 2 }],
    favorites: [{ name: '导入', url: 'https://fav.test/new' }, { name: '二', url: 'https://two.test/' }, null],
    dedupRules: [{ origin: 'https://example.com', ignoreParams: ['foreign'] },
      { origin: 'https://new.test', ignoreParams: ['utm'] }],
    workspaces: [workspace('w1', '导入工作区'), workspace('w2', '新增工作区', 'https://two.test/')] };
}

test('merge只添加缺少项，所有冲突保留本机且设置开关不变', async () => {
  const { data, sets, store } = fixture();
  const input = backup();
  const preview = await store.previewConfig(input, 'merge');
  for (const section of ['favorites', 'readingList', 'dedupRules', 'workspaces']) {
    assert.ok(preview.conflicts.some(item => item.section === section));
  }
  assert.ok(preview.conflicts.filter(item => item.section === 'settings.rules').length >= 2);
  await store.importConfig(preview.token, input);
  assert.equal(sets.length, 1);
  assert.equal(data.settings.enabled, false);
  assert.equal(data.settings.duplicatePromptEnabled, true);
  assert.deepEqual(data.settings.rules.map(item => item.prefix), ['https://a.test/', 'https://b.test/']);
  assert.equal(data.readingList.find(item => item.url === 'https://read.test/').title, '本机');
  assert.equal(data.library.favorites[0].name, '本机');
  assert.equal(data.library.favorites[1].name, '二');
  assert.deepEqual(data.library.dedupRules.find(item => item.origin === 'https://example.com').ignoreParams, ['local']);
  assert.equal(data.library.workspaces.find(item => item.id === 'w1').name, '本机工作区');
  assert.ok(data.library.workspaces.some(item => item.id === 'w2'));
});

test('禁用规则的同名组颜色冲突也保留本机配置', async () => {
  const { data, store } = fixture();
  const input = backup();
  input.settings.rules = [{ ...rule('https://disabled.test/', '组', 'red'), enabled: false }];
  input.readingList = [];
  input.favorites = [null, null, null];
  input.dedupRules = [];
  input.workspaces = [];
  const preview = await store.previewConfig(input, 'merge');
  assert.ok(preview.conflicts.some(item => item.section === 'settings.rules'));
  await store.importConfig(preview.token, input);
  assert.equal(data.settings.rules.some(item => item.prefix === 'https://disabled.test/'), false);
});

test('preview token跨worker持久且绑定输入与完整底层快照', async () => {
  const first = fixture();
  const input = backup();
  const preview = await first.store.previewConfig(input, 'replace');
  first.data.settings = { ...first.data.settings, enabled: true };
  await assert.rejects(first.store.importConfig(preview.token, input), /其他页面修改/);
  const changed = structuredClone(input);
  changed.favorites[1].name = '篡改';
  await assert.rejects(first.store.importConfig(preview.token, changed), /文件已变化/);
  assert.equal(first.sets.length, 0);
});

test('library revision阻止覆盖，备份严格拒绝未知字段和危险URL', async () => {
  const { store } = fixture();
  await assert.rejects(store.saveLibrary({ baseRevision: 2, favorites: [null, null, null], dedupRules: [] }), /重新读取/);
  const unknown = backup(); unknown.settings.extra = true;
  await assert.rejects(store.previewConfig(unknown, 'merge'), /未知字段/);
  const dangerous = backup(); dangerous.favorites[1].url = 'javascript:alert(1)';
  await assert.rejects(store.previewConfig(dangerous, 'replace'), /网址无效/);
});

test('合并后的整体再次校验数量限制，重复reading id不会产生损坏状态', async () => {
  const full = fixture();
  full.data.library.workspaces = Array.from({ length: 100 }, (_, index) => workspace(`w${index}`, `空间${index}`));
  const extra = backup();
  extra.workspaces = [workspace('new-space', '新增')];
  await assert.rejects(full.store.previewConfig(extra, 'merge'), /工作区数量超过限制/);

  const duplicate = fixture();
  const input = backup();
  input.readingList = [{ id: 'r1', url: 'https://different.test/', title: 'ID冲突', savedAt: 2 }];
  input.workspaces = [];
  const preview = await duplicate.store.previewConfig(input, 'merge');
  assert.ok(preview.conflicts.some(item => item.section === 'readingList' && item.key === 'r1'));
  await duplicate.store.importConfig(preview.token, input);
  assert.equal(duplicate.data.readingList.some(item => item.url === 'https://different.test/'), false);
});

test('旧readingList长标题可读取保留，但导出超出现行schema时明确拒绝', async () => {
  const { data, store } = fixture();
  data.readingList[0].title = '旧'.repeat(400);
  assert.equal((await store.getLibrary()).revision, 3);
  await assert.rejects(store.exportConfig(), /标题无效/);
});
