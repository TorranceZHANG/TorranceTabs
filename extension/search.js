import { safeHttpUrl } from './url-identity.js';

export function searchEntries(entries, query = '', type = 'all', limit = 80) {
  const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  return entries.filter(entry => (type === 'all' || entry.type === type)
    && terms.every(term => `${entry.title} ${entry.url} ${entry.context}`.toLocaleLowerCase().includes(term)))
    .map(entry => ({ ...entry, score: terms.reduce((score, term) => score
      + (entry.title.toLocaleLowerCase().startsWith(term) ? 6 : entry.title.toLocaleLowerCase().includes(term) ? 3 : 1), 0) }))
    .sort((a, b) => b.score - a.score || Number(b.type === 'tab') - Number(a.type === 'tab')
      || (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.title.localeCompare(b.title, 'zh-CN'))
    .slice(0, Math.min(200, Math.max(1, limit)));
}

export function buildSearchEntries(tabs, groups, stored, recent = {}) {
  const groupMap = new Map(groups.map(group => [group.id, group]));
  const entries = [];
  for (const tab of tabs) {
    const url = safeHttpUrl(tab.url);
    if (!url || tab.incognito || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) continue;
    const group = groupMap.get(tab.groupId);
    entries.push({ key: `tab:${tab.id}`, type: 'tab', title: String(tab.title || new URL(url).hostname), url,
      hostname: new URL(url).hostname, tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId ?? -1,
      groupTitle: group?.title || '', groupColor: group?.color || 'grey', shared: Boolean(group?.shared),
      context: `窗口 ${tab.windowId}${group?.title ? ` / ${group.title}` : ''}`,
      pinned: Boolean(tab.pinned), audible: Boolean(tab.audible), discarded: Boolean(tab.discarded),
      active: Boolean(tab.active), lastAccessed: Math.max(tab.lastAccessed || 0, recent[tab.id] || 0) });
  }
  for (const item of stored.readingList || []) {
    const url = safeHttpUrl(item.url);
    if (url && typeof item.id === 'string') entries.push({ key: `reading:${item.id}`, type: 'reading',
      title: String(item.title || new URL(url).hostname), url, context: '稍后读', lastAccessed: item.savedAt || 0 });
  }
  for (const workspace of stored.library?.workspaces || []) {
    for (const [wi, window] of workspace.windows.entries()) for (const [ti, tab] of window.tabs.entries()) {
      const url = safeHttpUrl(tab.url);
      if (url) entries.push({ key: `workspace:${workspace.id}:${wi}:${ti}`, type: 'workspace',
        title: String(tab.title || new URL(url).hostname), url, context: `工作区 / ${workspace.name}`,
        workspaceId: workspace.id, lastAccessed: workspace.savedAt || 0 });
    }
  }
  return entries;
}

export function createSearchService(api, suppression, now = () => Date.now()) {
  let tail = Promise.resolve();
  const openings = new Map();
  async function entries() {
    const [tabs, groups, stored, session] = await Promise.all([
      api.tabs.query({ windowType: 'normal' }), api.tabGroups.query({}),
      api.storage.local.get({ readingList: [], library: { workspaces: [] } }),
      api.storage.session.get({ recentTabs: {} }),
    ]);
    return buildSearchEntries(tabs, groups, stored, session.recentTabs);
  }
  async function query({ query = '', type = 'all', limit = 80 } = {}) {
    if (typeof query !== 'string' || query.length > 300 || !['all', 'tab', 'reading', 'workspace'].includes(type)) throw Error('搜索条件无效。');
    return { entries: searchEntries(await entries(), query, type, limit) };
  }
  async function openOnce({ key, url }) {
    const found = (await entries()).find(entry => entry.key === key && entry.url === url);
    if (!found) throw Error('页面或保存记录已变化，请刷新后重试。');
    const candidates = (await entries()).filter(entry => entry.type === 'tab' && entry.url === found.url);
    const target = found.type === 'tab' ? found : searchEntries(candidates, '', 'tab', 1)[0];
    if (target) {
      const live = await api.tabs.get(target.tabId);
      const window = await api.windows.get(live.windowId);
      if (live.incognito || window.incognito || window.type !== 'normal' || live.url !== found.url
        || (live.pendingUrl && live.pendingUrl !== live.url)) throw Error('页面已变化，请刷新后重试。');
      await api.tabs.update(live.id, { active: true }); await api.windows.update(live.windowId, { focused: true });
      return { action: 'focused' };
    }
    const token = await suppression.plan(found.url);
    try {
      const tab = await api.tabs.create({ url: 'about:blank', active: true });
      if (!(await suppression.claim(tab, 'about:blank', token)) || !(await suppression.verify(tab, 'about:blank'))) throw Error('新标签已变化，已停止打开链接。');
      await api.tabs.update(tab.id, { url: found.url, active: true }); return { action: 'opened' };
    }
    catch (error) { await suppression.cancel(token); throw error; }
  }
  function activate(request) {
    const url = safeHttpUrl(request?.url);
    if (!url || typeof request.key !== 'string') return Promise.reject(Error('搜索结果无效，请重新搜索。'));
    const task = (openings.get(url) || Promise.resolve()).catch(() => {}).then(() => openOnce(request));
    openings.set(url, task);
    const clear = () => { if (openings.get(url) === task) openings.delete(url); };
    task.then(clear, clear); return task;
  }
  function activated(id) {
    const task = tail.then(async () => {
      const tab = await api.tabs.get(id); if (tab.incognito || !safeHttpUrl(tab.url)) return;
      const recent = (await api.storage.session.get({ recentTabs: {} })).recentTabs;
      recent[id] = now();
      const bounded = Object.fromEntries(Object.entries(recent).sort((a, b) => b[1] - a[1]).slice(0, 1000));
      await api.storage.session.set({ recentTabs: bounded });
    });
    tail = task.catch(() => {}); return task;
  }
  return { entries, query, activate, activated };
}
