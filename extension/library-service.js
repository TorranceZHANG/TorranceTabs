import { safeHttpUrl } from './url-identity.js';
import { validateAutoSnapshots } from './library-schema.js';

const split = tab => Number.isInteger(tab?.splitViewId) && tab.splitViewId >= 0;
const RESTORE_PREVIEW_KEY = 'workspaceRestorePreview';
const RESTORE_PREVIEW_TTL = 5 * 60 * 1000;
const safeName = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw Error('工作区名称无效。');
  return value.trim();
};

export function createLibraryService(api, store, undo, suppression, operationLock) {
  let favoriteTail = Promise.resolve();
  async function get() {
    return { library: await store.getLibrary(), undo: await undo.getUndo(), version: api.runtime.getManifest().version };
  }

  async function eligibleExisting(tab, groupsById) {
    if (!safeHttpUrl(tab?.url) || tab.incognito || split(tab) || tab.pendingUrl || tab.status === 'loading') return false;
    try {
      const window = await api.windows.get(tab.windowId);
      if (window.type !== 'normal' || window.incognito) return false;
    } catch { return false; }
    if (tab.groupId >= 0) {
      const group = groupsById.get(tab.groupId);
      if (!group || group.shared === true || group.windowId !== tab.windowId) return false;
    }
    return true;
  }

  async function controlledPendingUrl(tab, groupsById) {
    const pending = safeHttpUrl(tab?.pendingUrl);
    if (!pending || tab.incognito || split(tab) || !Number.isInteger(tab.id)
      || (tab.url !== 'about:blank' && tab.url !== pending) || !(await suppression.contains(tab))) return null;
    try {
      const window = await api.windows.get(tab.windowId);
      if (window.type !== 'normal' || window.incognito) return null;
    } catch { return null; }
    if (tab.groupId >= 0) {
      const group = groupsById.get(tab.groupId);
      if (!group || group.shared === true || group.windowId !== tab.windowId) return null;
    }
    return pending;
  }

  async function openFavoriteOnce(slot) {
    if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw Error('常用入口编号无效。');
    const library = await store.getLibrary();
    const favorite = library.favorites[slot - 1];
    if (!favorite) throw Error('这个常用入口尚未配置。');
    const groups = new Map((await api.tabGroups.query({})).map(group => [group.id, group]));
    const matches = [];
    for (const tab of await api.tabs.query({ windowType: 'normal' })) {
      if (tab.url === favorite.url && await eligibleExisting(tab, groups)) matches.push(tab);
    }
    const existing = matches.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || a.id - b.id)[0];
    if (existing) {
      await api.tabs.update(existing.id, { active: true });
      await api.windows.update(existing.windowId, { focused: true });
      return { action: 'focused', tabId: existing.id, windowId: existing.windowId };
    }
    let target = null;
    try {
      const focused = await api.windows.getLastFocused({ windowTypes: ['normal'] });
      if (focused?.type === 'normal' && !focused.incognito) target = focused;
    } catch { /* Fall back to another explicit normal window. */ }
    if (!target) {
      try {
        const windows = await api.windows.getAll({ windowTypes: ['normal'] });
        target = windows.find(window => window.type === 'normal' && !window.incognito) || null;
      } catch { /* A new normal window is safer than an implicit destination. */ }
    }
    if (target) {
      try {
        const current = await api.windows.get(target.id);
        if (current.type !== 'normal' || current.incognito) target = null;
      } catch { target = null; }
    }
    if (target) {
      const tab = await api.tabs.create({ windowId: target.id, url: favorite.url, active: true });
      return { action: 'created', tabId: tab.id, windowId: tab.windowId };
    }
    const window = await api.windows.create({ type: 'normal', incognito: false, url: favorite.url, focused: true });
    const tab = window.tabs?.[0];
    if (!tab?.id) throw Error('Chrome 未返回新窗口标签。');
    return { action: 'created', tabId: tab.id, windowId: tab.windowId };
  }
  function openFavorite(slot) {
    const result = favoriteTail.then(() => openFavoriteOnce(slot));
    favoriteTail = result.catch(() => {});
    return result;
  }

  async function captureWorkspace(message, id = crypto.randomUUID()) {
    const name = safeName(message.name);
    if (!['current', 'all'].includes(message.scope)) throw Error('工作区保存范围无效。');
    if (message.scope === 'current' && !Number.isInteger(message.windowId)) throw Error('无法确定当前窗口。');
    const tabs = await api.tabs.query(message.scope === 'current' ? { windowId: message.windowId } : { windowType: 'normal' });
    const groups = new Map((await api.tabGroups.query({})).map(group => [group.id, group]));
    const windows = new Map();
    let skipped = 0;
    for (const tab of tabs) {
      if (!(await eligibleExisting(tab, groups))) { skipped += 1; continue; }
      const url = safeHttpUrl(tab.url);
      const group = tab.groupId >= 0 ? groups.get(tab.groupId) : null;
      const entry = { url, title: typeof tab.title === 'string' ? tab.title.slice(0, 300) : url,
        pinned: Boolean(tab.pinned), index: Number.isInteger(tab.index) ? tab.index : 0,
        group: group ? { key: `group-${tab.windowId}-${group.id}`, title: String(group.title || '').slice(0, 80),
          color: group.color || 'grey', collapsed: Boolean(group.collapsed) } : null };
      if (!windows.has(tab.windowId)) windows.set(tab.windowId, []);
      windows.get(tab.windowId).push(entry);
    }
    const workspace = { id, name, savedAt: Date.now(),
      windows: [...windows.values()].map(items => ({ tabs: items.sort((a, b) => a.index - b.index) })) };
    if (!workspace.windows.length) throw Error('没有可安全保存的 HTTP(S) 标签。');
    const saved = workspace.windows.reduce((sum, window) => sum + window.tabs.length, 0);
    return { workspace, saved, skipped };
  }

  async function saveWorkspace(message) {
    const { workspace, saved, skipped } = await captureWorkspace(message);
    await store.updateLibrary(library => ({ ...library, workspaces: [workspace, ...library.workspaces] }));
    return { workspace: { ...workspace, windowCount: workspace.windows.length, tabCount: saved }, saved, skipped, failed: 0 };
  }

  async function updateWorkspace(message) {
    if (typeof message?.id !== 'string') throw Error('工作区 ID 无效。');
    const { workspace, saved, skipped } = await captureWorkspace(message, message.id);
    const result = await store.updateWorkspace(message.id, message.baseRevision, workspace);
    return { workspace: { ...workspace, windowCount: workspace.windows.length, tabCount: saved }, saved, skipped, failed: 0,
      revision: result.library.revision, historyEntry: result.historyEntry };
  }

  async function captureCurrentWorkspace() {
    const result = await captureWorkspace({ name: '当前浏览器', scope: 'all' }, 'current-browser');
    return { ...result, workspace: { ...result.workspace, savedAt: 0 } };
  }

  async function createManaged(url, create) {
    const token = await suppression.plan(url);
    let tab;
    try {
      tab = await create();
      if (!tab?.id) throw Error('Chrome 未返回新标签。');
      if (!(await suppression.claim(tab, 'about:blank', token))) {
        await suppression.cancel(token);
        throw Error('无法安全登记恢复标签，已停止导航。');
      }
      if (!(await suppression.verify(tab, 'about:blank'))) throw Error('恢复标签已离开空白页，已停止导航。');
      return await api.tabs.update(tab.id, { url, active: false });
    } catch (error) {
      if (!tab) await suppression.cancel(token);
      throw error;
    }
  }

  async function unchangedCreated(tab, item, windowId) {
    try {
      const current = await api.tabs.get(tab.id);
      const window = await api.windows.get(current.windowId);
      const expectedNavigation = (current.url === item.url && (!current.pendingUrl || current.pendingUrl === item.url))
        || (current.url === 'about:blank' && current.pendingUrl === item.url);
      return expectedNavigation
        && current.windowId === windowId && window.type === 'normal' && !window.incognito
        && !current.incognito && !split(current) && (current.groupId ?? -1) === -1
        && Boolean(current.pinned) === Boolean(item.pinned);
    } catch { return false; }
  }

  async function collectExistingUrls() {
    const groups = new Map((await api.tabGroups.query({})).map(group => [group.id, group]));
    const existing = new Set();
    for (const tab of await api.tabs.query({ windowType: 'normal' })) {
      if (await eligibleExisting(tab, groups)) existing.add(tab.url);
      else {
        const pending = await controlledPendingUrl(tab, groups);
        if (pending) existing.add(pending);
      }
    }
    return { groups, existing };
  }

  async function restoreWorkspaceData(workspace) {
    return operationLock.run('restore', async () => {
      const { existing } = await collectExistingUrls();
      let restored = 0;
      let reused = 0;
      let failed = 0;
      let skipped = 0;
      let windowsCreated = 0;
      const seen = new Set(existing);
      for (const savedWindow of workspace.windows) {
        const pending = [];
        const scheduled = new Set();
        for (const item of savedWindow.tabs) {
          if (seen.has(item.url)) { reused += 1; continue; }
          if (scheduled.has(item.url)) { skipped += 1; continue; }
          scheduled.add(item.url);
          pending.push(item);
        }
        if (!pending.length) continue;
        let windowId = null;
        const created = [];
        for (const item of pending) {
          try {
            let tab;
            if (windowId === null) {
              const token = await suppression.plan(item.url);
              let window;
              try { window = await api.windows.create({ url: 'about:blank', focused: false }); }
              catch (error) { await suppression.cancel(token); throw error; }
              const blank = window.tabs?.[0];
              if (!blank?.id) throw Error('Chrome 未返回新窗口标签。');
              if (!(await suppression.claim(blank, 'about:blank', token))) {
                await suppression.cancel(token);
                throw Error('无法安全登记恢复标签，已停止导航。');
              }
              if (!(await suppression.verify(blank, 'about:blank'))) throw Error('恢复标签已离开空白页，已停止导航。');
              tab = await api.tabs.update(blank.id, { url: item.url, pinned: item.pinned, active: false });
              windowId = tab.windowId;
              windowsCreated += 1;
            } else {
              tab = await createManaged(item.url, () => api.tabs.create({ windowId, url: 'about:blank', active: false, pinned: item.pinned }));
            }
            created.push({ tab, item });
            seen.add(item.url);
            restored += 1;
          } catch { failed += 1; }
        }
        const byGroup = new Map();
        for (const value of created) if (value.item.group) {
          const list = byGroup.get(value.item.group.key) || [];
          list.push(value);
          byGroup.set(value.item.group.key, list);
        }
        for (const list of byGroup.values()) {
          let groupId = null;
          for (const value of list) {
            try {
              if (groupId !== null) {
                const target = await api.tabGroups.get(groupId);
                if (!target || target.windowId !== windowId || target.shared === true) throw Error('恢复目标组已变化');
              }
              // This must be the final awaited read before grouping this tab.
              if (!(await unchangedCreated(value.tab, value.item, windowId))) throw Error('恢复标签状态已变化');
              if (groupId === null) {
                groupId = await api.tabs.group({ tabIds: [value.tab.id], createProperties: { windowId } });
                const meta = value.item.group;
                await api.tabGroups.update(groupId, { title: meta.title, color: meta.color, collapsed: meta.collapsed });
              } else await api.tabs.group({ groupId, tabIds: [value.tab.id] });
            } catch { failed += 1; }
          }
        }
      }
      return { restored, reused, skipped, failed, interrupted: 0, windowsCreated };
    });
  }

  async function restoreWorkspace(id) {
    const library = await store.getLibrary();
    const workspace = library.workspaces.find(item => item.id === id);
    if (!workspace) throw Error('工作区不存在或已删除。');
    return restoreWorkspaceData(workspace);
  }

  async function workspaceDigest(workspace) {
    const bytes = new TextEncoder().encode(JSON.stringify(workspace));
    if (globalThis.crypto?.subtle) {
      const result = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 16777619); }
    return `fallback-${(hash >>> 0).toString(16)}`;
  }

  async function resolveWorkspaceVersion({ id, versionId, source }) {
    if (typeof id !== 'string' || !['workspace', 'history', 'auto'].includes(source)) throw Error('工作区恢复来源无效。');
    if (source === 'workspace') {
      const workspace = (await store.getLibrary()).workspaces.find(item => item.id === id);
      if (!workspace) throw Error('工作区不存在或已删除。');
      return workspace;
    }
    if (typeof versionId !== 'string') throw Error('工作区版本无效。');
    if (source === 'history') {
      const entry = (await store.getWorkspaceHistory(id)).find(item => item.versionId === versionId);
      if (!entry) throw Error('工作区历史版本不存在。');
      return entry.workspace;
    }
    const stored = await api.storage.local.get({ autoSnapshots: [] });
    const snapshot = validateAutoSnapshots(stored.autoSnapshots).find(item => item.snapshotId === versionId);
    const workspace = snapshot?.workspaces.find(item => item.id === id);
    if (!workspace) throw Error('自动快照中的工作区不存在。');
    return workspace;
  }

  const tabItems = workspace => workspace.windows.flatMap(window => window.tabs);
  async function previewRestore(selection) {
    const workspace = await resolveWorkspaceVersion(selection);
    const current = (await store.getLibrary()).workspaces.find(item => item.id === selection.id) || null;
    const currentUrls = new Set(current ? tabItems(current).map(item => item.url) : []);
    const selectedItems = tabItems(workspace);
    const selectedUrls = new Set(selectedItems.map(item => item.url));
    const { existing } = await collectExistingUrls();
    const unique = new Set();
    const missingUrls = [];
    const existingUrls = [];
    let duplicateSaved = 0;
    let reused = 0;
    let missing = 0;
    for (const item of selectedItems) {
      if (existing.has(item.url)) { reused += 1; if (!existingUrls.includes(item.url)) existingUrls.push(item.url); }
      else if (unique.has(item.url)) duplicateSaved += 1;
      else { unique.add(item.url); missing += 1; missingUrls.push(item.url); }
    }
    const token = crypto.randomUUID();
    const digest = await workspaceDigest(workspace);
    await api.storage.session.set({ [RESTORE_PREVIEW_KEY]: { token, expiresAt: Date.now() + RESTORE_PREVIEW_TTL,
      selection: { id: selection.id, versionId: selection.versionId, source: selection.source }, digest } });
    return { token, workspace: { id: workspace.id, name: workspace.name, savedAt: workspace.savedAt,
      windowCount: workspace.windows.length, tabCount: selectedItems.length },
    diff: { added: selectedItems.filter(item => !currentUrls.has(item.url)).map(item => ({ url: item.url, title: item.title })),
      removed: current ? tabItems(current).filter(item => !selectedUrls.has(item.url)).map(item => ({ url: item.url, title: item.title })) : [],
      unchanged: selectedItems.filter(item => currentUrls.has(item.url)).map(item => ({ url: item.url, title: item.title })) },
    restore: { missing, reused, duplicateSaved, missingUrls, existingUrls } };
  }

  async function restorePreview(token) {
    if (typeof token !== 'string') throw Error('恢复确认已失效，请重新预览。');
    const record = (await api.storage.session.get({ [RESTORE_PREVIEW_KEY]: null }))[RESTORE_PREVIEW_KEY];
    if (!record || record.token !== token || record.expiresAt < Date.now()) throw Error('恢复确认已过期，请重新预览。');
    const workspace = await resolveWorkspaceVersion(record.selection);
    if (await workspaceDigest(workspace) !== record.digest) throw Error('工作区版本已变化，请重新预览。');
    const result = await restoreWorkspaceData(workspace);
    await api.storage.session.remove(RESTORE_PREVIEW_KEY).catch(() => {});
    return result;
  }

  async function getWorkspaceHistory(id) { return store.getWorkspaceHistory(id); }

  async function deleteWorkspace(id) {
    return store.deleteWorkspace(id);
  }
  return { get, openFavorite, saveWorkspace, updateWorkspace, captureCurrentWorkspace, restoreWorkspace, previewRestore, restorePreview,
    getWorkspaceHistory, deleteWorkspace };
}
