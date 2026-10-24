import { createAutoGrouper, createReadingList } from './grouping.js';
import { createDeduplicator } from './deduplication.js';
import { createInlineDuplicateGuard } from './inline-duplicate-guard.js';
import { createCleanupController } from './cleanup-controller.js';

const grouper = createAutoGrouper(chrome, error => console.warn('自动分组暂未完成：', error));
const updateReadingList = createReadingList(chrome);
const deduplicateTabs = createDeduplicator(chrome);
const cleanup = createCleanupController(chrome, deduplicateTabs);
const duplicateGuard = createInlineDuplicateGuard(chrome, id => grouper.schedule(id));
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
  grouper.invalidate(id);
  tabTasks.delete(id);
  duplicateGuard.removed(id).then(released => {
    for (const sourceId of released) void grouper.schedule(sourceId);
  }).catch(error => console.warn('提醒状态清理失败：', error));
});
chrome.tabs.onReplaced.addListener((added, removed) => {
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
  if (command !== 'deduplicate-tabs') return;
  cleanup.run('shortcut').catch(error => console.warn('快捷键清理未完成：', error));
});
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(error => console.warn('无法打开规则设置：', error));
  }
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
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
  } else return false;
  Promise.resolve().then(task)
    .then(value => reply({ ok: true, ...value }))
    .catch(error => reply({ ok: false, error: error.message || '操作未完成，请重试。' }));
  return true;
});
