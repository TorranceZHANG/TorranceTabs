import { createAutoGrouper, createReadingList } from './grouping.js';
import { createDeduplicator } from './deduplication.js';
import { createInlineDuplicateGuard } from './inline-duplicate-guard.js';
import { createCleanupController } from './cleanup-controller.js';
import { createLocalWriteQueue, createLibraryStore } from './library-store.js';
import { createTabSuppression } from './tab-suppression.js';
import { createOperationLock } from './operation-lock.js';
import { createUndoJournal } from './undo-journal.js';
import { createLibraryService } from './library-service.js';
import { createUpdateChecker } from './update-checker.js';
import { createDuplicatePolicy } from './duplicate-policy.js';
import { createSnapshotService } from './workspace-history.js';
import { createSyncService } from './selective-sync.js';
import { createSearchService } from './search.js';

const localWrites = createLocalWriteQueue();
const store = createLibraryStore(chrome, localWrites);
const policy = createDuplicatePolicy(chrome, localWrites);
const suppression = createTabSuppression(chrome);
const operationLock = createOperationLock();
const undoJournal = createUndoJournal(chrome, localWrites, suppression, operationLock);
const grouper = createAutoGrouper(chrome, error => console.warn('自动分组暂未完成：', error), async tab => await suppression.contains(tab) || await policy.isGroupingPaused(tab));
const updateReadingList = createReadingList(chrome, localWrites);
const deduplicateTabs = createDeduplicator(chrome, { journal: undoJournal,
  getRules: async () => (await store.getLibrary()).dedupRules, policy });
const cleanup = createCleanupController(chrome, deduplicateTabs, { operationLock });
const duplicateGuard = createInlineDuplicateGuard(chrome, id => grouper.schedule(id),
  { shouldSuppress: tab => suppression.contains(tab), policy, operationLock });
const library = createLibraryService(chrome, store, undoJournal, suppression, operationLock);
const snapshots = createSnapshotService(chrome, store, library, operationLock);
const sync = createSyncService(chrome, store, localWrites);
const search = createSearchService(chrome, suppression);
const checkUpdate = createUpdateChecker(chrome);
const tabTasks = new Map();

function routeTab(task, id, shouldGroup = true) {
  const generation = Symbol();
  tabTasks.set(id, generation);
  grouper.invalidate(id);
  task.then(result => {
    const suppressed = typeof result === 'object' ? result.suppressed : result;
    for (const sourceId of result?.releasedIds || []) void grouper.schedule(sourceId);
    if (tabTasks.get(id) !== generation) return;
    if (!suppressed && shouldGroup) void grouper.schedule(id);
  }).catch(error => {
    console.warn('重复提醒未完成，保留网页：', error);
    if (tabTasks.get(id) === generation && shouldGroup) void grouper.schedule(id);
  });
}

// Register synchronously so events also reach a newly awakened MV3 worker.
chrome.tabs.onCreated.addListener(tab => { routeTab(duplicateGuard.created(tab), tab.id); });
chrome.tabs.onUpdated.addListener((id, change) => {
  const shouldGroup = typeof change.url === 'string' || change.status === 'complete' || change.pinned === false;
  if (shouldGroup || change.status === 'loading') {
    routeTab(duplicateGuard.updated(id), id, shouldGroup);
  }
});
chrome.tabs.onDetached.addListener(id => {
  tabTasks.set(id, Symbol());
  grouper.invalidate(id);
});
chrome.tabs.onAttached.addListener(id => { routeTab(duplicateGuard.updated(id), id); });
chrome.tabs.onRemoved.addListener(id => {
  void policy.removed(id).catch(() => {});
  void suppression.release(id);
  grouper.invalidate(id);
  tabTasks.delete(id);
  duplicateGuard.removed(id).then(released => {
    for (const sourceId of released) void grouper.schedule(sourceId);
  }).catch(error => console.warn('提醒状态清理失败：', error));
});
chrome.tabs.onReplaced.addListener((added, removed) => {
  void policy.replaced(added, removed).catch(() => {});
  grouper.invalidate(removed);
  tabTasks.delete(removed);
  routeTab(duplicateGuard.replaced(added, removed), added);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    grouper.settingsChanged();
    duplicateGuard.permissionsChanged().then(released => {
      for (const id of released) void grouper.schedule(id);
    }).catch(error => console.warn('页内提醒设置状态更新失败：', error));
  }
});
chrome.permissions.onRemoved.addListener(() => {
  duplicateGuard.permissionsChanged().then(released => {
    for (const id of released) void grouper.schedule(id);
  }).catch(error => console.warn('页内提醒权限状态更新失败：', error));
});
chrome.commands.onCommand.addListener(command => {
  if (command === 'deduplicate-tabs') cleanup.run('shortcut').catch(error => console.warn('快捷键清理未完成：', error));
  else if (/^favorite-[1-3]$/.test(command)) {
    library.openFavorite(Number(command.slice(-1))).catch(error => console.warn('常用入口未打开：', error));
  }
  else if (command === 'open-search') void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html?search=1') });
  else if (command === 'open-side-panel') {
    if (chrome.sidePanel?.open) chrome.windows.getLastFocused({ windowTypes: ['normal'] }).then(window => chrome.sidePanel.open({ windowId: window.id })).catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));
    else void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
});
chrome.tabs.onActivated?.addListener(({ tabId }) => { void search.activated(tabId).catch(() => {}); });
chrome.alarms?.onAlarm?.addListener(alarm => { void snapshots.handleAlarm(alarm).catch(error => console.warn('快照保存未完成：', error)); });
async function ensureSnapshotAlarm() {
  if (!chrome.alarms?.get) return;
  const { config } = await snapshots.getState();
  const name = 'torrance-tabs-auto-snapshot';
  const alarm = await chrome.alarms.get(name);
  if (!config.enabled) { if (alarm) await chrome.alarms.clear(name); return; }
  if (!alarm || alarm.periodInMinutes !== config.intervalMinutes) await chrome.alarms.create(name, { periodInMinutes: config.intervalMinutes });
}
void ensureSnapshotAlarm().catch(error => console.warn('快照计划未恢复：', error));
chrome.runtime.onStartup?.addListener(() => { void ensureSnapshotAlarm().catch(() => {}); });
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(error => console.warn('无法打开规则设置：', error));
  }
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
  const privileged = new Set(['LIBRARY_GET', 'LIBRARY_SAVE', 'CONFIG_EXPORT', 'CONFIG_PREVIEW', 'CONFIG_IMPORT',
    'FAVORITE_OPEN', 'UNDO_RESTORE', 'UNDO_DISCARD', 'WORKSPACE_SAVE', 'WORKSPACE_RESTORE', 'WORKSPACE_DELETE', 'CHECK_UPDATE', 'SAVE_SETTINGS',
    'PREFERENCES_GET', 'PREFERENCES_SAVE', 'WORKSPACE_UPDATE', 'WORKSPACE_HISTORY', 'WORKSPACE_PREVIEW_RESTORE', 'WORKSPACE_RESTORE_PREVIEW',
    'SNAPSHOT_GET', 'SNAPSHOT_CONFIGURE', 'SNAPSHOT_CAPTURE', 'SYNC_GET', 'SYNC_CONFIGURE', 'SYNC_UPLOAD', 'SYNC_PREVIEW', 'SYNC_APPLY',
    'DUPLICATE_POLICY_GET', 'DUPLICATE_ALLOWLIST_SAVE', 'DUPLICATE_PAUSE_SITE', 'GROUPING_PAUSE_TAB', 'RULES_PREVIEW',
    'DEDUPLICATE_PREVIEW', 'DEDUPLICATE_EXECUTE', 'SEARCH_QUERY', 'SEARCH_ACTIVATE']);
  if (privileged.has(message.type)) {
    const base = chrome.runtime.getURL('');
    if (typeof sender.url !== 'string' || !sender.url.startsWith(base)) {
      reply({ ok: false, error: '此操作仅允许扩展页面发起。' });
      return true;
    }
  }
  let task;
  if (message.type === 'APPLY_CURRENT_WINDOW') task = () => grouper.applyWindow(message.windowId);
  else if (message.type === 'DEDUPLICATE_TABS') task = () => cleanup.run('panel');
  else if (message.type === 'GET_CLEANUP_STATUS') task = async () => ({ status: await cleanup.getStatus() });
  else if (message.type === 'DUPLICATE_PROMPT_INFO') task = () => duplicateGuard.info(message, sender);
  else if (message.type === 'INLINE_DUPLICATE_CHOOSE') task = async () => {
    const result = await duplicateGuard.chooseInline(message, sender);
    if (Number.isInteger(result.releasedId)) void grouper.schedule(result.releasedId);
    return result;
  };
  else if (message.type === 'DUPLICATE_PROMPT_CHOOSE') task = async () => {
    const result = await duplicateGuard.choose(message, sender);
    if (Number.isInteger(result.releasedId)) void grouper.schedule(result.releasedId);
    return result;
  };
  else if (['SAVE_READING_ITEM', 'REMOVE_READING_ITEM'].includes(message.type)) {
    task = async () => ({ readingList: await updateReadingList(message) });
  } else if (message.type === 'SAVE_SETTINGS') task = async () => ({ settings: await store.saveSettings(message.settings) });
  else if (message.type === 'LIBRARY_GET') task = () => library.get();
  else if (message.type === 'LIBRARY_SAVE') task = async () => ({ library: await store.saveLibrary(message) });
  else if (message.type === 'CONFIG_EXPORT') task = async () => ({ backup: await store.exportConfig() });
  else if (message.type === 'CONFIG_PREVIEW') task = () => store.previewConfig(message.backup, message.mode);
  else if (message.type === 'CONFIG_IMPORT') task = () => store.importConfig(message.token, message.backup);
  else if (message.type === 'FAVORITE_OPEN') task = () => library.openFavorite(message.slot);
  else if (message.type === 'UNDO_RESTORE') task = () => undoJournal.restore(message.ids);
  else if (message.type === 'UNDO_DISCARD') task = () => undoJournal.discard(message.ids);
  else if (message.type === 'WORKSPACE_SAVE') task = () => library.saveWorkspace(message);
  else if (message.type === 'WORKSPACE_RESTORE') task = () => library.restoreWorkspace(message.id);
  else if (message.type === 'WORKSPACE_DELETE') task = () => library.deleteWorkspace(message.id);
  else if (message.type === 'CHECK_UPDATE') task = () => checkUpdate();
  else if (message.type === 'PREFERENCES_GET') task = async () => ({ preferences: await store.getPreferences() });
  else if (message.type === 'PREFERENCES_SAVE') task = async () => ({ preferences: await store.savePreferences(message.preferences) });
  else if (message.type === 'WORKSPACE_UPDATE') task = () => library.updateWorkspace(message);
  else if (message.type === 'WORKSPACE_HISTORY') task = async () => ({ history: await library.getWorkspaceHistory(message.id) });
  else if (message.type === 'WORKSPACE_PREVIEW_RESTORE') task = () => library.previewRestore(message);
  else if (message.type === 'WORKSPACE_RESTORE_PREVIEW') task = () => library.restorePreview(message.token);
  else if (message.type === 'SNAPSHOT_GET') task = () => snapshots.getState();
  else if (message.type === 'SNAPSHOT_CONFIGURE') task = async () => ({ config: await snapshots.configure(message.config) });
  else if (message.type === 'SNAPSHOT_CAPTURE') task = () => snapshots.capture({ manual: true });
  else if (message.type === 'SYNC_GET') task = () => sync.getState();
  else if (message.type === 'SYNC_CONFIGURE') task = () => sync.configure({ enabled: message.enabled });
  else if (message.type === 'SYNC_UPLOAD') task = () => sync.upload(message);
  else if (message.type === 'SYNC_PREVIEW') task = () => sync.preview(message);
  else if (message.type === 'SYNC_APPLY') task = () => sync.apply({ token: message.token });
  else if (message.type === 'DUPLICATE_POLICY_GET') task = () => policy.getState();
  else if (message.type === 'DUPLICATE_ALLOWLIST_SAVE') task = async () => ({ allowlist: await policy.setAllowlist(message.origins) });
  else if (message.type === 'DUPLICATE_PAUSE_SITE') task = async () => ({ origin: message.origin, expiresAt: await policy.pauseSite(message.origin) });
  else if (message.type === 'GROUPING_PAUSE_TAB') task = async () => ({ tabId: message.tabId, paused: await policy.pauseTab(message.tabId, message.paused) });
  else if (message.type === 'RULES_PREVIEW') task = () => grouper.previewWindow(message);
  else if (message.type === 'DEDUPLICATE_PREVIEW') task = () => deduplicateTabs.preview(message);
  else if (message.type === 'DEDUPLICATE_EXECUTE') task = () => cleanup.run('preview', { token: message.token, selections: message.selections });
  else if (message.type === 'SEARCH_QUERY') task = () => search.query({ query: message.query, type: message.source || 'all', limit: message.limit });
  else if (message.type === 'SEARCH_ACTIVATE') task = () => search.activate(message);
  else return false;
  Promise.resolve().then(task)
    .then(value => reply({ ok: true, ...value }))
    .catch(error => reply({ ok: false, error: error.message || '操作未完成，请重试。' }));
  return true;
});

const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
let omniboxGeneration = 0;
let omniboxEntries = new Map();
chrome.omnibox?.onInputChanged.addListener((query, suggest) => {
  const generation = ++omniboxGeneration;
  search.query({ query, limit: 6 }).then(({ entries }) => {
    if (generation !== omniboxGeneration) return;
    omniboxEntries = new Map(entries.map(entry => [`tt:${entry.key}`, entry]));
    suggest(entries.map(entry => ({ content: `tt:${entry.key}`, description: `${xml(entry.title)} <dim>${xml(entry.context)}</dim> <url>${xml(entry.url)}</url>` })));
  }).catch(() => suggest([]));
});
chrome.omnibox?.onInputEntered.addListener(content => {
  const entry = omniboxEntries.get(content);
  if (entry) void search.activate(entry).catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html?search=1') }));
  else void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?q=${encodeURIComponent(content.slice(0, 300))}`) });
});
