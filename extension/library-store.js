import { DEFAULT_SETTINGS, validateSettings } from './rules.js';
import { DEFAULT_LIBRARY, validateBackup, validateDuplicateAllowlist, validateExistingReading, validateFavorites, validateLibrary,
  validateStoredReading, validateWorkspace, validateWorkspaceHistory, validateAutoSnapshots, validateSnapshotConfig } from './library-schema.js';
import { normalizeDedupRules } from './url-identity.js';
import { DEFAULT_PREFERENCES, validatePreferences } from './preferences.js';

const TOKEN_TTL = 5 * 60 * 1000;
const IMPORT_TOKEN_KEY = 'configImportToken';
export const LOCAL_DATA_BYTES_LIMIT = 5 * 1024 * 1024;
export const WORKSPACE_ARCHIVE_BYTES_LIMIT = 1024 * 1024;
export const WORKSPACE_HISTORY_KEY = 'workspaceHistory';
const LOCAL_DEFAULTS = Object.freeze({ settings: DEFAULT_SETTINGS, readingList: [], library: DEFAULT_LIBRARY,
  preferences: DEFAULT_PREFERENCES, duplicateAllowlist: [], workspaceHistory: { schemaVersion: 1, byWorkspace: {} },
  autoSnapshotConfig: { enabled: false, intervalMinutes: 30, retention: 5 }, autoSnapshots: [], selectiveSyncConfig: { enabled: false },
  selectiveSyncDeviceId: null });
const clone = value => structuredClone(value);

function byteLength(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; } catch { throw Error('本地数据无法序列化。'); }
}

export function assertLocalDataSize(value) {
  if (byteLength(value) > LOCAL_DATA_BYTES_LIMIT) throw Error('本地工具数据超过 5 MB 总限额，请先删除部分工作区或历史版本。');
}

function archiveBytes(workspaceHistory, autoSnapshots) {
  return byteLength({ workspaceHistory, autoSnapshots });
}

function pruneWorkspaceArchives(rawHistory, rawSnapshots, protectedItem = null) {
  const history = validateWorkspaceHistory(rawHistory);
  let snapshots = validateAutoSnapshots(rawSnapshots);
  if (protectedItem?.entry && byteLength(protectedItem.entry) > WORKSPACE_ARCHIVE_BYTES_LIMIT) {
    throw Error('单个工作区历史或快照超过 1 MB 限额，未保存该版本。');
  }
  const byWorkspace = Object.fromEntries(Object.entries(history.byWorkspace).map(([id, entries]) => [id, [...entries]]));
  while (archiveBytes({ schemaVersion: 1, byWorkspace }, snapshots) > WORKSPACE_ARCHIVE_BYTES_LIMIT) {
    const candidates = [];
    for (const [workspaceId, entries] of Object.entries(byWorkspace)) entries.forEach(entry => {
      if (!(protectedItem?.type === 'history' && protectedItem.id === entry.versionId)) {
        candidates.push({ type: 'history', id: entry.versionId, workspaceId, timestamp: entry.archivedAt });
      }
    });
    snapshots.forEach(entry => {
      if (!(protectedItem?.type === 'snapshot' && protectedItem.id === entry.snapshotId)) {
        candidates.push({ type: 'snapshot', id: entry.snapshotId, timestamp: entry.capturedAt });
      }
    });
    candidates.sort((left, right) => left.timestamp - right.timestamp
      || left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
    const oldest = candidates[0];
    if (!oldest) throw Error('单个工作区历史或快照超过 1 MB 限额，未保存该版本。');
    if (oldest.type === 'snapshot') snapshots = snapshots.filter(item => item.snapshotId !== oldest.id);
    else {
      byWorkspace[oldest.workspaceId] = byWorkspace[oldest.workspaceId].filter(item => item.versionId !== oldest.id);
      if (!byWorkspace[oldest.workspaceId].length) delete byWorkspace[oldest.workspaceId];
    }
  }
  return { workspaceHistory: { schemaVersion: 1, byWorkspace }, autoSnapshots: snapshots };
}

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
    favoritesChanged: 0, dedupRulesChanged: 0, workspacesAdded: 0, workspacesReplaced: 0,
    preferencesChanged: incoming.preferences !== undefined && different(current.preferences, incoming.preferences),
    duplicateAllowlistChanged: 0, totalItems: 0 };
  let settings = incoming.settings;
  let readingList;
  let favorites;
  let dedupRules;
  let workspaces;
  let preferences = current.preferences;
  let duplicateAllowlist = current.duplicateAllowlist;
  if (mode === 'replace') {
    readingList = incoming.readingList;
    favorites = incoming.favorites;
    dedupRules = incoming.dedupRules;
    workspaces = incoming.workspaces;
    summary.readingAdded = readingList.length;
    summary.favoritesChanged = favorites.filter(Boolean).length;
    summary.dedupRulesChanged = dedupRules.length;
    summary.workspacesAdded = workspaces.length;
    if (incoming.preferences !== undefined) preferences = incoming.preferences;
    if (incoming.duplicateAllowlist !== undefined) {
      duplicateAllowlist = incoming.duplicateAllowlist;
      summary.duplicateAllowlistChanged = duplicateAllowlist.length;
    }
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
    if (incoming.preferences !== undefined && different(current.preferences, incoming.preferences)) {
      conflicts.push({ section: 'preferences', key: 'preferences', current: current.preferences, incoming: incoming.preferences });
      summary.preferencesChanged = false;
    }
    if (incoming.duplicateAllowlist !== undefined) {
      const origins = new Set(current.duplicateAllowlist);
      for (const origin of incoming.duplicateAllowlist) if (!origins.has(origin)) {
        origins.add(origin);
        summary.duplicateAllowlistChanged += 1;
      }
      duplicateAllowlist = [...origins];
    }
  }
  summary.totalItems = readingList.length + favorites.filter(Boolean).length + dedupRules.length + workspaces.length;
  const next = { settings: validateSettings(settings), readingList: validateStoredReading(readingList),
    library: validateLibrary({ schemaVersion: 1, revision: current.library.revision + 1, favorites, dedupRules, workspaces }),
    preferences: validatePreferences(preferences), duplicateAllowlist: validateDuplicateAllowlist(duplicateAllowlist) };
  return { summary, conflicts, next };
}

export function createLibraryStore(api, enqueue = createLocalWriteQueue(), now = () => Date.now()) {
  async function localState() {
    const stored = await api.storage.local.get(null);
    return { ...clone(LOCAL_DEFAULTS), ...(stored || {}) };
  }
  async function setLocal(changes, base = null) {
    const current = base || await localState();
    const prospective = { ...current, ...changes };
    const currentBytes = byteLength(current);
    const prospectiveBytes = byteLength(prospective);
    if (prospectiveBytes > LOCAL_DATA_BYTES_LIMIT && prospectiveBytes > currentBytes) {
      throw Error('本地工具数据超过 5 MB 总限额，请先删除部分工作区或历史版本。');
    }
    await api.storage.local.set(changes);
  }
  async function snapshot() {
    const stored = await localState();
    return { settings: validateSettings(stored.settings), readingList: validateExistingReading(stored.readingList),
      library: validateLibrary(stored.library), preferences: validatePreferences(stored.preferences),
      duplicateAllowlist: validateDuplicateAllowlist(stored.duplicateAllowlist) };
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
      await setLocal({ library });
      return enriched(library);
    });
  }
  async function saveSettings(settings) {
    return enqueue(async () => { const valid = validateSettings(settings); await setLocal({ settings: valid }); return valid; });
  }
  async function getPreferences() { return (await snapshot()).preferences; }
  async function savePreferences(preferences) {
    return enqueue(async () => { const valid = validatePreferences(preferences); await setLocal({ preferences: valid }); return valid; });
  }
  async function getDuplicateAllowlist() { return (await snapshot()).duplicateAllowlist; }
  async function saveDuplicateAllowlist(origins) {
    return enqueue(async () => {
      const duplicateAllowlist = validateDuplicateAllowlist(origins);
      await setLocal({ duplicateAllowlist });
      return duplicateAllowlist;
    });
  }
  async function exportConfig() {
    const current = await snapshot();
    return validateBackup({ schemaVersion: 2, exportedAt: now(), settings: current.settings, readingList: current.readingList,
      favorites: current.library.favorites, dedupRules: current.library.dedupRules, workspaces: current.library.workspaces,
      preferences: current.preferences, duplicateAllowlist: current.duplicateAllowlist });
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
      const stored = await localState();
      const changes = { ...next };
      if (preview.mode === 'replace') {
        const allowedIds = new Set(next.library.workspaces.map(item => item.id));
        const history = validateWorkspaceHistory(stored.workspaceHistory);
        const byWorkspace = Object.fromEntries(Object.entries(history.byWorkspace)
          .filter(([workspaceId]) => allowedIds.has(workspaceId)));
        const archives = pruneWorkspaceArchives({ schemaVersion: 1, byWorkspace }, stored.autoSnapshots);
        changes.workspaceHistory = archives.workspaceHistory;
        changes.autoSnapshots = archives.autoSnapshots;
      }
      await setLocal(changes, stored);
      await api.storage.session.remove(IMPORT_TOKEN_KEY).catch(() => {});
      return { imported: true, revision: next.library.revision };
    });
  }
  async function updateLibrary(mutator) {
    return enqueue(async () => {
      const current = await snapshot();
      const changed = await mutator(clone(current.library));
      const library = validateLibrary({ ...changed, revision: current.library.revision + 1 });
      await setLocal({ library });
      return library;
    });
  }
  async function updateWorkspace(id, baseRevision, rawWorkspace) {
    return enqueue(async () => {
      const stored = await localState();
      const library = validateLibrary(stored.library);
      if (!Number.isInteger(baseRevision) || baseRevision !== library.revision) {
        throw Error('工具库已在其他页面更新，请重新读取后再保存。');
      }
      const index = library.workspaces.findIndex(item => item.id === id);
      if (index < 0) throw Error('工作区不存在或已删除。');
      const workspace = validateWorkspace(rawWorkspace);
      if (workspace.id !== id) throw Error('工作区 ID 不可修改。');
      const history = validateWorkspaceHistory(stored.workspaceHistory);
      const entries = history.byWorkspace[id] || [];
      const entry = { versionId: crypto.randomUUID(), archivedAt: now(), workspace: clone(library.workspaces[index]) };
      const workspaceHistory = { ...history, byWorkspace: { ...history.byWorkspace, [id]: [entry, ...entries].slice(0, 5) } };
      const archives = pruneWorkspaceArchives(workspaceHistory, stored.autoSnapshots,
        { type: 'history', id: entry.versionId, entry });
      const workspaces = [...library.workspaces];
      workspaces[index] = workspace;
      const nextLibrary = validateLibrary({ ...library, revision: library.revision + 1, workspaces });
      await setLocal({ library: nextLibrary, [WORKSPACE_HISTORY_KEY]: archives.workspaceHistory,
        autoSnapshots: archives.autoSnapshots }, stored);
      return { library: enriched(nextLibrary), historyEntry: clone(entry) };
    });
  }
  async function getWorkspaceHistory(id) {
    const stored = await localState();
    const history = validateWorkspaceHistory(stored.workspaceHistory);
    return clone(history.byWorkspace[id] || []);
  }
  async function deleteWorkspace(id) {
    return enqueue(async () => {
      const stored = await localState();
      const library = validateLibrary(stored.library);
      const workspaces = library.workspaces.filter(item => item.id !== id);
      if (workspaces.length === library.workspaces.length) return { deleted: false, library: enriched(library) };
      const history = validateWorkspaceHistory(stored.workspaceHistory);
      const byWorkspace = { ...history.byWorkspace };
      delete byWorkspace[id];
      const nextLibrary = validateLibrary({ ...library, revision: library.revision + 1, workspaces });
      await setLocal({ library: nextLibrary, workspaceHistory: { schemaVersion: 1, byWorkspace } }, stored);
      return { deleted: true, library: enriched(nextLibrary) };
    });
  }
  async function configureAutoSnapshots(rawConfig) {
    return enqueue(async () => {
      const stored = await localState();
      const config = validateSnapshotConfig(rawConfig);
      const snapshots = validateAutoSnapshots(stored.autoSnapshots).slice(0, config.retention);
      const archives = pruneWorkspaceArchives(stored.workspaceHistory, snapshots);
      await setLocal({ autoSnapshotConfig: config, workspaceHistory: archives.workspaceHistory,
        autoSnapshots: archives.autoSnapshots }, stored);
      return config;
    });
  }
  async function saveAutoSnapshot(rawSnapshot, { manual = false } = {}) {
    return enqueue(async () => {
      const stored = await localState();
      const config = validateSnapshotConfig(stored.autoSnapshotConfig);
      if (!manual && !config.enabled) return { captured: false, reason: 'disabled' };
      const snapshot = validateAutoSnapshots([rawSnapshot])[0];
      const existing = validateAutoSnapshots(stored.autoSnapshots);
      if (existing[0]?.digest === snapshot.digest) return { captured: false, reason: 'unchanged' };
      const snapshots = [snapshot, ...existing].slice(0, config.retention);
      const archives = pruneWorkspaceArchives(stored.workspaceHistory, snapshots,
        { type: 'snapshot', id: snapshot.snapshotId, entry: snapshot });
      await setLocal({ workspaceHistory: archives.workspaceHistory, autoSnapshots: archives.autoSnapshots }, stored);
      return { captured: true, snapshot: clone(snapshot) };
    });
  }
  return { snapshot, getLibrary, saveLibrary, saveSettings, getPreferences, savePreferences, getDuplicateAllowlist,
    saveDuplicateAllowlist, exportConfig, previewConfig, importConfig, updateLibrary, updateWorkspace, getWorkspaceHistory,
    deleteWorkspace, configureAutoSnapshots, saveAutoSnapshot, setLocal, localState, enqueue };
}
