import { safeHttpUrl } from './url-identity.js';

const split = tab => Number.isInteger(tab?.splitViewId) && tab.splitViewId >= 0;
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

  async function saveWorkspace(message) {
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
    const workspace = { id: crypto.randomUUID(), name, savedAt: Date.now(),
      windows: [...windows.values()].map(items => ({ tabs: items.sort((a, b) => a.index - b.index) })) };
    if (!workspace.windows.length) throw Error('没有可安全保存的 HTTP(S) 标签。');
    await store.updateLibrary(library => ({ ...library, workspaces: [workspace, ...library.workspaces] }));
    const saved = workspace.windows.reduce((sum, window) => sum + window.tabs.length, 0);
    return { workspace: { ...workspace, windowCount: workspace.windows.length, tabCount: saved }, saved, skipped, failed: 0 };
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

  async function restoreWorkspace(id) {
    return operationLock.run('restore', async () => {
      const library = await store.getLibrary();
      const workspace = library.workspaces.find(item => item.id === id);
      if (!workspace) throw Error('工作区不存在或已删除。');
      const groups = new Map((await api.tabGroups.query({})).map(group => [group.id, group]));
      const existing = new Set();
      for (const tab of await api.tabs.query({ windowType: 'normal' })) {
        if (await eligibleExisting(tab, groups)) existing.add(tab.url);
        else {
          const pending = await controlledPendingUrl(tab, groups);
          if (pending) existing.add(pending);
        }
      }
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

  async function deleteWorkspace(id) {
    let deleted = false;
    await store.updateLibrary(library => {
      const workspaces = library.workspaces.filter(item => item.id !== id);
      deleted = workspaces.length !== library.workspaces.length;
      return { ...library, workspaces };
    });
    return { deleted };
  }
  return { get, openFavorite, saveWorkspace, restoreWorkspace, deleteWorkspace };
}
