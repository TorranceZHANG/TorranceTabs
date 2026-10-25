import { DEFAULT_SETTINGS, validateSettings } from './rules.js';
import { DEFAULT_LIBRARY, validateBackup, validateExistingReading, validateFavorites, validateLibrary, validateStoredReading } from './library-schema.js';
import { normalizeDedupRules } from './url-identity.js';

const TOKEN_TTL = 5 * 60 * 1000;
const IMPORT_TOKEN_KEY = 'configImportToken';
const clone = value => structuredClone(value);

export function createLocalWriteQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

async function digestSnapshot(snapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const value of bytes) { hash ^= value; hash = Math.imul(hash, 16777619); }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

function enriched(library) {
  return { ...clone(library), workspaces: library.workspaces.map(workspace => ({ ...clone(workspace),
    windowCount: workspace.windows.length,
    tabCount: workspace.windows.reduce((sum, window) => sum + window.tabs.length, 0) })) };
}

function conflictsAndMerge(current, incoming, mode) {
  const conflicts = [];
  const different = (left, right) => JSON.stringify(left) !== JSON.stringify(right);
  const summary = { settingsChanged: different(current.settings, incoming.settings), readingAdded: 0, readingReplaced: 0,
    favoritesChanged: 0, dedupRulesChanged: 0, workspacesAdded: 0, workspacesReplaced: 0, totalItems: 0 };
  let settings = incoming.settings;
  let readingList;
  let favorites;
  let dedupRules;
  let workspaces;
  if (mode === 'replace') {
    readingList = incoming.readingList;
    favorites = incoming.favorites;
    dedupRules = incoming.dedupRules;
    workspaces = incoming.workspaces;
    summary.readingAdded = readingList.length;
    summary.favoritesChanged = favorites.filter(Boolean).length;
    summary.dedupRulesChanged = dedupRules.length;
    summary.workspacesAdded = workspaces.length;
  } else {
    const mergedRules = [...current.settings.rules];
    const byPrefix = new Map(mergedRules.map(rule => [rule.prefix, rule]));
    const colors = new Map();
    for (const rule of mergedRules) {
      if (!colors.has(rule.group)) colors.set(rule.group, new Set());
      colors.get(rule.group).add(rule.color);
    }
    let addedRules = 0;
    for (const rule of incoming.settings.rules) {
      const same = byPrefix.get(rule.prefix);
      if (same) {
        if (different(same, rule)) conflicts.push({ section: 'settings.rules', key: rule.prefix, current: same, incoming: rule });
        continue;
      }
      if (colors.has(rule.group) && !colors.get(rule.group).has(rule.color)) {
        conflicts.push({ section: 'settings.rules', key: rule.prefix,
          current: { group: rule.group, colors: [...colors.get(rule.group)] }, incoming: rule });
        continue;
      }
      mergedRules.push(rule);
      byPrefix.set(rule.prefix, rule);
      if (!colors.has(rule.group)) colors.set(rule.group, new Set());
      colors.get(rule.group).add(rule.color);
      addedRules += 1;
    }
    settings = { enabled: current.settings.enabled, duplicatePromptEnabled: current.settings.duplicatePromptEnabled, rules: mergedRules };
    summary.settingsChanged = addedRules > 0;
    const reading = new Map(current.readingList.map(item => [item.url, item]));
    const readingIds = new Map(current.readingList.map(item => [item.id, item]));
    for (const item of incoming.readingList) {
      if (!reading.has(item.url) && readingIds.has(item.id)) {
        conflicts.push({ section: 'readingList', key: item.id, current: readingIds.get(item.id), incoming: item });
        continue;
      }
      if (!reading.has(item.url)) summary.readingAdded += 1;
      else if (different(reading.get(item.url), item)) {
        conflicts.push({ section: 'readingList', key: item.url, current: reading.get(item.url), incoming: item });
        continue;
      }
      reading.set(item.url, item);
      readingIds.set(item.id, item);
    }
    readingList = [...reading.values()];
    favorites = current.library.favorites.map((item, index) => {
      const next = incoming.favorites[index];
      if (next === null) return item;
      if (different(item, next)) {
        if (item) { conflicts.push({ section: 'favorites', key: String(index + 1), current: item, incoming: next }); return item; }
        summary.favoritesChanged += 1;
      }
      return next;
    });
    const rules = new Map(current.library.dedupRules.map(item => [item.origin, item]));
    for (const item of incoming.dedupRules) {
      const before = rules.get(item.origin);
      if (different(before, item)) {
        if (before) { conflicts.push({ section: 'dedupRules', key: item.origin, current: before, incoming: item }); continue; }
        summary.dedupRulesChanged += 1;
      }
      rules.set(item.origin, item);
    }
    dedupRules = [...rules.values()];
    const spaces = new Map(current.library.workspaces.map(item => [item.id, item]));
    for (const item of incoming.workspaces) {
      const before = spaces.get(item.id);
      if (!before) summary.workspacesAdded += 1;
      else if (different(before, item)) {
        conflicts.push({ section: 'workspaces', key: item.id, current: before, incoming: item });
        continue;
      }
      spaces.set(item.id, item);
    }
    workspaces = [...spaces.values()];
  }
  summary.totalItems = readingList.length + favorites.filter(Boolean).length + dedupRules.length + workspaces.length;
  const next = { settings: validateSettings(settings), readingList: validateStoredReading(readingList),
    library: validateLibrary({ schemaVersion: 1, revision: current.library.revision + 1, favorites, dedupRules, workspaces }) };
  return { summary, conflicts, next };
}

export function createLibraryStore(api, enqueue = createLocalWriteQueue(), now = () => Date.now()) {
  async function snapshot() {
    const stored = await api.storage.local.get({ settings: DEFAULT_SETTINGS, readingList: [], library: DEFAULT_LIBRARY });
    return { settings: validateSettings(stored.settings), readingList: validateExistingReading(stored.readingList),
      library: validateLibrary(stored.library) };
  }
  async function getLibrary() { return enriched((await snapshot()).library); }
  async function saveLibrary(message) {
    return enqueue(async () => {
      const current = await snapshot();
      if (!Number.isInteger(message.baseRevision) || message.baseRevision !== current.library.revision) {
        throw Error('工具库已在其他页面更新，请重新读取后再保存。');
      }
      const library = { ...current.library, revision: current.library.revision + 1,
        favorites: validateFavorites(message.favorites), dedupRules: normalizeDedupRules(message.dedupRules) };
      await api.storage.local.set({ library });
      return enriched(library);
    });
  }
  async function saveSettings(settings) {
    return enqueue(async () => { const valid = validateSettings(settings); await api.storage.local.set({ settings: valid }); return valid; });
  }
  async function exportConfig() {
    const current = await snapshot();
    return validateBackup({ schemaVersion: 1, exportedAt: now(), settings: current.settings, readingList: current.readingList,
      favorites: current.library.favorites, dedupRules: current.library.dedupRules, workspaces: current.library.workspaces });
  }
  async function previewConfig(raw, mode) {
    if (!['merge', 'replace'].includes(mode)) throw Error('导入模式无效。');
    const backup = validateBackup(raw);
    const current = await snapshot();
    const prepared = conflictsAndMerge(current, backup, mode);
    const token = crypto.randomUUID();
    await api.storage.session.set({ [IMPORT_TOKEN_KEY]: { token, mode, expiresAt: now() + TOKEN_TTL,
      baseDigest: await digestSnapshot(current), inputDigest: await digestSnapshot(backup) } });
    return { token, summary: prepared.summary, conflicts: prepared.conflicts };
  }
  async function importConfig(token, raw) {
    if (typeof token !== 'string') throw Error('导入确认已失效，请重新预览。');
    const backup = validateBackup(raw);
    return enqueue(async () => {
      const preview = (await api.storage.session.get({ [IMPORT_TOKEN_KEY]: null }))[IMPORT_TOKEN_KEY];
      if (!preview || preview.token !== token || preview.expiresAt < now()) throw Error('导入确认已过期，请重新预览。');
      if (await digestSnapshot(backup) !== preview.inputDigest) throw Error('导入文件已变化，请重新预览。');
      const current = await snapshot();
      if (await digestSnapshot(current) !== preview.baseDigest) throw Error('数据已在其他页面修改，请重新预览后导入。');
      const next = conflictsAndMerge(current, backup, preview.mode).next;
      await api.storage.local.set(next);
      await api.storage.session.remove(IMPORT_TOKEN_KEY).catch(() => {});
      return { imported: true, revision: next.library.revision };
    });
  }
  async function updateLibrary(mutator) {
    return enqueue(async () => {
      const current = await snapshot();
      const changed = await mutator(clone(current.library));
      const library = validateLibrary({ ...changed, revision: current.library.revision + 1 });
      await api.storage.local.set({ library });
      return library;
    });
  }
  return { snapshot, getLibrary, saveLibrary, saveSettings, exportConfig, previewConfig, importConfig, updateLibrary, enqueue };
}
