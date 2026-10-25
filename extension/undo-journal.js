import { safeHttpUrl } from './url-identity.js';

const KEY = 'cleanupUndo';
const SESSION_KEY = 'undoBrowserSessionId';
const EMPTY = { schemaVersion: 1, batches: [] };
const clone = value => structuredClone(value);
const validJournal = raw => raw?.schemaVersion === 1 && Array.isArray(raw.batches) ? raw : clone(EMPTY);

export function createUndoJournal(api, enqueue, suppression, operationLock, now = () => Date.now()) {
  const read = async () => validJournal((await api.storage.local.get({ [KEY]: EMPTY }))[KEY]);
  const write = value => api.storage.local.set({ [KEY]: value });
  const begin = () => crypto.randomUUID();
  const browserSession = (async () => {
    try {
      const stored = (await api.storage.session.get({ [SESSION_KEY]: null }))[SESSION_KEY];
      if (typeof stored === 'string' && stored) return stored;
      const id = crypto.randomUUID();
      await api.storage.session.set({ [SESSION_KEY]: id });
      return id;
    } catch { return null; }
  })();
  const ready = enqueue(async () => {
    const journal = await read();
    let changed = false;
    for (const batch of journal.batches) for (const item of batch.items) {
      if (item.status === 'closing' || item.status === 'restoring') { item.status = 'interrupted'; changed = true; }
    }
    if (changed) await write(journal);
  });

  async function prepare(batchId, tab, group = null) {
    const url = safeHttpUrl(tab.url);
    if (!url) throw Error('无法记录待关闭页面，已停止关闭。');
    const browserSessionId = await browserSession;
    return enqueue(async () => {
      const journal = await read();
      for (const current of journal.batches) {
        current.items = current.items.filter(entry => ['available', 'closing', 'restoring', 'interrupted'].includes(entry.status));
      }
      let batch = journal.batches.find(item => item.id === batchId);
      if (!batch) {
        journal.batches = journal.batches.filter(item => item.items.some(entry => ['available', 'closing', 'restoring', 'interrupted'].includes(entry.status)));
        if (journal.batches.length >= 10) throw Error('清理恢复记录已满，请先恢复或处理旧记录。');
        batch = { id: batchId, createdAt: now(), items: [] };
        journal.batches.unshift(batch);
      }
      const total = journal.batches.reduce((sum, current) => sum + current.items.length, 0);
      if (total >= 500) throw Error('清理恢复记录已达 500 条上限，请先处理旧记录。');
      const item = { id: crypto.randomUUID(), url, title: typeof tab.title === 'string' ? tab.title.slice(0, 300) : url,
        windowId: tab.windowId, index: Number.isInteger(tab.index) ? tab.index : 0, pinned: Boolean(tab.pinned),
        group: group ? { title: String(group.title || '').slice(0, 80), color: group.color || 'grey',
          collapsed: Boolean(group.collapsed) } : null, browserSessionId, status: 'closing', preparedAt: now() };
      batch.items.push(item);
      await write(journal);
      return item.id;
    });
  }

  async function settle(batchId, outcomes) {
    return enqueue(async () => {
      const journal = await read();
      const batch = journal.batches.find(item => item.id === batchId);
      if (!batch) return;
      for (const item of batch.items) {
        const state = outcomes.get(item.id);
        if (state === 'closed') { item.status = 'available'; item.closedAt = now(); }
        else if (state) { item.status = 'failed'; item.error = state; }
      }
      await write(journal);
    });
  }

  async function getUndo() {
    await ready;
    return enqueue(async () => {
      const journal = await read();
      const items = journal.batches.flatMap(batch => batch.items)
        .filter(item => ['available', 'interrupted'].includes(item.status))
        .map(item => ({ id: item.id, url: item.url, title: item.title, closedAt: item.closedAt || item.preparedAt,
          windowId: item.windowId, group: item.group, status: item.status }));
      return { items };
    });
  }

  async function usableWindow(windowId, itemSessionId) {
    const currentSessionId = await browserSession;
    if (!currentSessionId || itemSessionId !== currentSessionId) return null;
    try {
      const window = await api.windows.get(windowId);
      return window.type === 'normal' && !window.incognito ? windowId : null;
    } catch { return null; }
  }

  async function createManaged(item, groupCache, fallbackWindows) {
    const token = await suppression.plan(item.url);
    let tab;
    try {
      const windowId = await usableWindow(item.windowId, item.browserSessionId);
      if (windowId !== null) tab = await api.tabs.create({ windowId, url: 'about:blank', active: false });
      else {
        const fallbackKey = `${item.browserSessionId || 'legacy'}:${item.windowId}`;
        const fallbackWindowId = fallbackWindows.get(fallbackKey);
        if (Number.isInteger(fallbackWindowId)) {
          tab = await api.tabs.create({ windowId: fallbackWindowId, url: 'about:blank', active: false });
        } else {
          const window = await api.windows.create({ url: 'about:blank', focused: false });
          tab = window.tabs?.[0];
          if (!tab) throw Error('Chrome 未返回新窗口标签。');
          fallbackWindows.set(fallbackKey, tab.windowId);
        }
      }
      if (!(await suppression.claim(tab, 'about:blank', token))) {
        await suppression.cancel(token);
        throw Error('无法安全登记恢复标签，已停止导航。');
      }
      if (!(await suppression.verify(tab, 'about:blank'))) throw Error('恢复标签已离开空白页，已停止导航。');
      tab = await api.tabs.update(tab.id, { url: item.url, pinned: item.pinned });
    } catch (error) {
      if (!tab) await suppression.cancel(token);
      throw error;
    }
    let warning = null;
    if (item.group) {
      try {
        const current = await api.tabs.get(tab.id);
        const window = await api.windows.get(current.windowId);
        const expectedNavigation = (current.url === item.url && (!current.pendingUrl || current.pendingUrl === item.url))
          || (current.url === 'about:blank' && current.pendingUrl === item.url);
        if (!expectedNavigation
          || current.windowId !== tab.windowId || window.type !== 'normal' || window.incognito
          || current.incognito || (Number.isInteger(current.splitViewId) && current.splitViewId >= 0)
          || (current.groupId ?? -1) !== -1 || Boolean(current.pinned) !== Boolean(item.pinned)) {
          throw Error('恢复页状态已变化');
        }
        const key = `${tab.windowId}:${item.group.title}:${item.group.color}:${item.group.collapsed}`;
        let groupId = groupCache.get(key);
        if (groupId === undefined) {
          groupId = await api.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
          await api.tabGroups.update(groupId, { title: item.group.title, color: item.group.color, collapsed: item.group.collapsed });
          groupCache.set(key, groupId);
        } else {
          const target = await api.tabGroups.get(groupId);
          if (!target || target.windowId !== tab.windowId || target.shared === true) throw Error('恢复目标组已变化');
          await api.tabs.group({ groupId, tabIds: [tab.id] });
        }
      } catch { warning = '网页已恢复，但标签组未完全恢复。'; }
    }
    return { tab, warning };
  }

  async function restore(ids) {
    await ready;
    return operationLock.run('restore', async () => {
      const selected = await enqueue(async () => {
        const journal = await read();
        const wanted = ids === undefined ? null : new Set(Array.isArray(ids) ? ids : []);
        const items = journal.batches.flatMap(batch => batch.items)
          .filter(item => !wanted || wanted.has(item.id));
        const available = items.filter(item => item.status === 'available');
        for (const item of available) item.status = 'restoring';
        await write(journal);
        return { available: clone(available), interrupted: items.filter(item => item.status === 'interrupted').length };
      });
      const results = [];
      const groupCache = new Map();
      const fallbackWindows = new Map();
      for (const item of selected.available) {
        try {
          const { tab, warning } = await createManaged(item, groupCache, fallbackWindows);
          results.push({ id: item.id, status: 'restored', tabId: tab.id, ...(warning ? { error: warning, partial: true } : {}) });
        } catch (error) { results.push({ id: item.id, status: 'failed', error: error.message || '恢复失败。' }); }
      }
      await enqueue(async () => {
        const journal = await read();
        const byId = new Map(results.map(item => [item.id, item]));
        for (const item of journal.batches.flatMap(batch => batch.items)) {
          const result = byId.get(item.id);
          if (!result) continue;
          item.status = result.status === 'failed' ? 'available' : result.status;
          if (result.tabId) item.restoredTabId = result.tabId;
          if (result.error) item.error = result.error;
        }
        await write(journal);
      });
      return { restored: results.filter(item => item.status === 'restored').length,
        skipped: Math.max(0, (ids?.length || selected.available.length) - selected.available.length - selected.interrupted),
        failed: results.filter(item => item.status === 'failed' || item.partial).length, interrupted: selected.interrupted, items: results };
    });
  }
  async function discard(ids) {
    await ready;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) {
      throw Error('要清理的恢复记录无效。');
    }
    return operationLock.run('restore', () => enqueue(async () => {
      const journal = await read();
      const wanted = ids === undefined ? null : new Set(ids);
      let discarded = 0;
      for (const batch of journal.batches) {
        batch.items = batch.items.filter(item => {
          const active = item.status === 'closing' || item.status === 'restoring';
          const selected = !wanted || wanted.has(item.id);
          if (!active && selected) { discarded += 1; return false; }
          return true;
        });
      }
      journal.batches = journal.batches.filter(batch => batch.items.length > 0);
      if (discarded) await write(journal);
      return { discarded };
    }));
  }
  return { begin, prepare, settle, getUndo, restore, discard };
}
