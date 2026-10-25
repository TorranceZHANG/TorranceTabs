import { validateSettings } from './rules.js';
import { normalizeDedupRules, safeHttpUrl } from './url-identity.js';

export const SCHEMA_VERSION = 1;
export const DEFAULT_LIBRARY = Object.freeze({ schemaVersion: 1, revision: 0,
  favorites: Object.freeze([null, null, null]), dedupRules: Object.freeze([]), workspaces: Object.freeze([]) });
const LIMITS = { backupBytes: 1024 * 1024, reading: 2000, workspaces: 100, workspaceTabs: 5000, title: 300, name: 80 };
const exactKeys = (value, allowed, message) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw Error(message);
};
const text = (value, limit, message, allowEmpty = false) => {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value.trim())) throw Error(message);
  return value.trim();
};
const validId = value => text(value, 100, 'ID 格式无效。');

export function validateFavorites(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) throw Error('常用入口必须恰好包含三个槽位。');
  return raw.map(item => {
    if (item === null) return null;
    exactKeys(item, ['name', 'url'], '常用入口包含未知字段。');
    const url = safeHttpUrl(item.url);
    if (!url) throw Error('常用入口网址无效。');
    return { name: text(item.name, LIMITS.name, '常用入口名称无效。'), url };
  });
}

export function validateStoredReading(raw) {
  if (!Array.isArray(raw) || raw.length > LIMITS.reading) throw Error('稍后阅读数量超过限制。');
  const ids = new Set();
  return raw.map(item => {
    exactKeys(item, ['id', 'url', 'title', 'savedAt'], '稍后阅读条目包含未知字段。');
    const itemId = validId(item.id);
    const url = safeHttpUrl(item.url);
    if (!url || ids.has(itemId) || !Number.isFinite(item.savedAt)) throw Error('稍后阅读条目无效。');
    ids.add(itemId);
    return { id: itemId, url, title: text(item.title, LIMITS.title, '稍后阅读标题无效。', true), savedAt: item.savedAt };
  });
}

export function validateExistingReading(raw) {
  if (!Array.isArray(raw)) throw Error('稍后阅读清单格式无效。');
  const ids = new Set();
  return raw.map(item => {
    exactKeys(item, ['id', 'url', 'title', 'savedAt'], '稍后阅读条目包含未知字段。');
    const itemId = validId(item.id);
    const url = safeHttpUrl(item.url);
    if (!url || ids.has(itemId) || typeof item.title !== 'string' || !Number.isFinite(item.savedAt)) throw Error('稍后阅读条目无效。');
    ids.add(itemId);
    return { id: itemId, url, title: item.title, savedAt: item.savedAt };
  });
}

function validateGroup(raw) {
  if (raw === null) return null;
  exactKeys(raw, ['key', 'title', 'color', 'collapsed'], '工作区分组包含未知字段。');
  const colors = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
  if (!colors.has(raw.color) || typeof raw.collapsed !== 'boolean') throw Error('工作区分组格式无效。');
  return { key: validId(raw.key), title: text(raw.title, LIMITS.name, '工作区分组名称无效。', true),
    color: raw.color, collapsed: raw.collapsed };
}

function validateWorkspace(raw) {
  exactKeys(raw, ['id', 'name', 'savedAt', 'windows'], '工作区包含未知字段。');
  if (!Number.isFinite(raw.savedAt) || !Array.isArray(raw.windows) || raw.windows.length > 50) throw Error('工作区格式无效。');
  let count = 0;
  const windows = raw.windows.map(window => {
    exactKeys(window, ['tabs'], '工作区窗口包含未知字段。');
    if (!Array.isArray(window.tabs) || window.tabs.length > 1000) throw Error('工作区窗口标签数量超过限制。');
    return { tabs: window.tabs.map(tab => {
      exactKeys(tab, ['url', 'title', 'pinned', 'index', 'group'], '工作区标签包含未知字段。');
      const url = safeHttpUrl(tab.url);
      if (!url || typeof tab.pinned !== 'boolean' || !Number.isInteger(tab.index) || tab.index < 0) throw Error('工作区标签格式无效。');
      count += 1;
      return { url, title: text(tab.title, LIMITS.title, '工作区标签标题无效。', true), pinned: tab.pinned,
        index: tab.index, group: validateGroup(tab.group) };
    }) };
  });
  if (count > LIMITS.workspaceTabs) throw Error('工作区标签总数超过限制。');
  return { id: validId(raw.id), name: text(raw.name, LIMITS.name, '工作区名称无效。'), savedAt: raw.savedAt, windows };
}

export function validateWorkspaces(raw) {
  if (!Array.isArray(raw) || raw.length > LIMITS.workspaces) throw Error('工作区数量超过限制。');
  const ids = new Set();
  return raw.map(value => { const item = validateWorkspace(value); if (ids.has(item.id)) throw Error('工作区 ID 重复。'); ids.add(item.id); return item; });
}

export function validateLibrary(raw) {
  if (raw === undefined || raw === null) return structuredClone(DEFAULT_LIBRARY);
  exactKeys(raw, ['schemaVersion', 'revision', 'favorites', 'dedupRules', 'workspaces'], '本地工具库包含未知字段。');
  if (raw.schemaVersion !== 1 || !Number.isInteger(raw.revision) || raw.revision < 0) throw Error('本地工具库版本无效。');
  return { schemaVersion: 1, revision: raw.revision, favorites: validateFavorites(raw.favorites),
    dedupRules: normalizeDedupRules(raw.dedupRules), workspaces: validateWorkspaces(raw.workspaces) };
}

export function validateBackup(raw) {
  let size;
  try { size = new TextEncoder().encode(JSON.stringify(raw)).length; } catch { throw Error('备份不是有效数据。'); }
  if (size > LIMITS.backupBytes) throw Error('备份超过 1 MB 限制。');
  exactKeys(raw, ['schemaVersion', 'exportedAt', 'settings', 'readingList', 'favorites', 'dedupRules', 'workspaces'], '备份包含未知字段。');
  if (raw.schemaVersion !== 1 || !Number.isFinite(raw.exportedAt)) throw Error('备份版本无效。');
  exactKeys(raw.settings, ['enabled', 'duplicatePromptEnabled', 'rules'], '设置包含未知字段。');
  if (!Array.isArray(raw.settings.rules) || raw.settings.rules.length > 500) throw Error('自动分组规则数量超过限制。');
  for (const rule of raw.settings.rules) {
    exactKeys(rule, ['prefix', 'group', 'color', 'enabled'], '自动分组规则包含未知字段。');
    if (typeof rule.prefix !== 'string' || rule.prefix.length > 8192
      || typeof rule.group !== 'string' || rule.group.length > 80) throw Error('自动分组规则字符串超过限制。');
  }
  return { schemaVersion: 1, exportedAt: raw.exportedAt, settings: validateSettings(raw.settings),
    readingList: validateStoredReading(raw.readingList), favorites: validateFavorites(raw.favorites),
    dedupRules: normalizeDedupRules(raw.dedupRules), workspaces: validateWorkspaces(raw.workspaces) };
}
