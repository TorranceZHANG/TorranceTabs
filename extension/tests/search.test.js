import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchEntries, searchEntries, createSearchService } from '../search.js';
import { DEFAULT_PREFERENCES, validatePreferences } from '../preferences.js';

test('统一索引跳过隐身和非网页，保留分组、来源和状态', () => {
  const entries = buildSearchEntries([
    { id: 1, windowId: 8, groupId: 3, url: 'https://example.com/', title: '当前文档', audible: true, pinned: true },
    { id: 2, windowId: 8, url: 'https://secret.test/', incognito: true },
    { id: 3, windowId: 8, url: 'chrome://settings' },
    { id: 4, windowId: 8, url: 'https://user:password@example.com/' },
  ], [{ id: 3, title: '项目 A', color: 'blue' }], { readingList: [{ id: 'r', title: '稍后阅读', url: 'https://reading.test/' }],
    library: { workspaces: [{ id: 'w', name: '工作现场', savedAt: 12, windows: [{ tabs: [{ title: '已存文档', url: 'https://saved.test/' }] }] }] } }, { 1: 100 });
  assert.equal(entries.length, 3); assert.equal(entries[0].groupTitle, '项目 A'); assert.equal(entries[0].lastAccessed, 100);
  assert.equal(entries[0].audible, true); assert.equal(entries[0].pinned, true);
  assert.deepEqual(entries.map(entry => entry.type), ['tab', 'reading', 'workspace']);
});
test('多关键词匹配上下文，已打开优先，结果可按来源筛选', () => {
  const entries = [
    { key: 'a', type: 'workspace', title: '文档', url: 'https://a/', context: '项目 A', lastAccessed: 20 },
    { key: 'b', type: 'tab', title: '文档', url: 'https://b/', context: '项目 A', lastAccessed: 1 },
    { key: 'c', type: 'tab', title: '文档', url: 'https://c/', context: '项目 B', lastAccessed: 100 },
  ];
  assert.deepEqual(searchEntries(entries, '文档 项目 A').map(entry => entry.key), ['b', 'a']);
  assert.deepEqual(searchEntries(entries, '', 'workspace').map(entry => entry.key), ['a']);
  assert.equal(searchEntries(entries, '', 'all', 1).length, 1);
});
function fixture() {
  const tabs = new Map([[1, { id: 1, windowId: 8, url: 'https://example.com/', title: '文档' }]]); const calls = [];
  const api = { tabs: {
    query: async () => structuredClone([...tabs.values()]), get: async id => structuredClone(tabs.get(id)),
    update: async (id, values) => { calls.push(['update', id, values]); Object.assign(tabs.get(id), values); return tabs.get(id); },
    create: async values => { const tab = { id: 2, windowId: 8, ...values }; tabs.set(2, tab); calls.push(['create', values]); return tab; },
  }, tabGroups: { query: async () => [] }, windows: { get: async () => ({ type: 'normal' }), update: async (...args) => calls.push(['window', ...args]) },
  storage: { local: { get: async defaults => ({ ...defaults, readingList: [{ id: 'r', url: 'https://example.com/', title: '已保存' }] }) },
    session: { get: async defaults => defaults, set: async value => calls.push(['session', value]) } } };
  const suppression = { plan: async () => 'token', claim: async () => true, verify: async () => true, cancel: async () => {} };
  return { tabs, calls, api, service: createSearchService(api, suppression) };
}
test('打开已保存结果会复用现有网页，陈旧网址不被导航覆盖', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.activate({ key: 'reading:r', url: 'https://example.com/' }), { action: 'focused' });
  assert.equal(calls.some(call => call[0] === 'create'), false);
  await assert.rejects(service.activate({ key: 'tab:1', url: 'https://changed.test/' }), /变化/);
});
test('外观偏好只接受明确主题与密度，不允许额外配置混入', () => {
  assert.deepEqual(validatePreferences(), DEFAULT_PREFERENCES);
  assert.deepEqual(validatePreferences({ theme: 'dark', density: 'compact' }), { theme: 'dark', density: 'compact' });
  assert.throws(() => validatePreferences({ theme: 'dark', density: 'compact', syncEnabled: true }));
  assert.throws(() => validatePreferences({ theme: 'unknown', density: 'compact' }));
});
test('多个入口并发打开同一保存链接时只新建一次，其余复用', async () => {
  const { api, service, calls } = fixture();
  api.storage.local.get = async defaults => ({ ...defaults, readingList: [{ id: 'r', url: 'https://new.example/', title: '新保存页面' }] });
  const request = { key: 'reading:r', url: 'https://new.example/' };
  const results = await Promise.all([service.activate(request), service.activate(request), service.activate(request)]);
  assert.equal(calls.filter(call => call[0] === 'create').length, 1);
  assert.deepEqual(results.map(result => result.action), ['opened', 'focused', 'focused']);
});
