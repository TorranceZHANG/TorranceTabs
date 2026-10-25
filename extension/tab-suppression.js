import { safeHttpUrl } from './url-identity.js';

const KEY = 'managedRestoreTabs';
export function createTabSuppression(api, now = () => Date.now()) {
  let state = { planned: [], tabs: {} };
  let tail = Promise.resolve();
  const enqueue = task => { const result = tail.then(task); tail = result.catch(() => {}); return result; };
  const ready = (async () => {
    try {
      const stored = (await api.storage.session.get({ [KEY]: state }))[KEY];
      if (stored && Array.isArray(stored.planned) && stored.tabs && typeof stored.tabs === 'object') state = stored;
    } catch { /* In-memory suppression still applies in this worker. */ }
  })();
  const save = () => api.storage.session.set({ [KEY]: state });
  const purge = () => {
    const time = now();
    state.planned = state.planned.filter(item => item.expiresAt > time);
    for (const [id, item] of Object.entries(state.tabs)) if (item.expiresAt <= time) delete state.tabs[id];
  };
  async function verify(tabOrId, raw = 'about:blank') {
    const id = typeof tabOrId === 'object' ? tabOrId?.id : tabOrId;
    if (!Number.isInteger(id) || typeof raw !== 'string') return false;
    let current;
    try { current = await api.tabs.get(id); } catch { return false; }
    if (current.url !== raw || (current.pendingUrl && current.pendingUrl !== raw)
      || current.incognito || (Number.isInteger(current.splitViewId) && current.splitViewId >= 0)) return false;
    if (typeof tabOrId === 'object' && (current.windowId !== tabOrId.windowId
      || (current.groupId ?? -1) !== (tabOrId.groupId ?? -1)
      || Boolean(current.pinned) !== Boolean(tabOrId.pinned))) return false;
    try {
      const window = await api.windows.get(current.windowId);
      if (window.type !== 'normal' || window.incognito) return false;
      if (current.groupId >= 0) {
        const group = await api.tabGroups.get(current.groupId);
        if (group.windowId !== current.windowId || group.shared === true) return false;
      }
    } catch { return false; }
    return true;
  }
  async function plan(raw) {
    await ready;
    const url = safeHttpUrl(raw);
    if (!url) throw Error('无法为无效网址安排恢复。');
    const token = crypto.randomUUID();
    await enqueue(async () => { purge(); state.planned.push({ token, url, expiresAt: now() + 60000 }); await save(); });
    return token;
  }
  async function claim(tabOrId, raw = null, token = null) {
    await ready;
    return enqueue(async () => {
      purge();
      const id = typeof tabOrId === 'object' ? tabOrId?.id : tabOrId;
      if (!Number.isInteger(id)) return false;
      if (typeof token !== 'string') return false;
      const index = state.planned.findIndex(item => item.token === token);
      if (index < 0) return state.tabs[id]?.token === token && await verify(tabOrId, raw);
      if (!(await verify(tabOrId, raw))) return false;
      const [entry] = state.planned.splice(index, 1);
      state.tabs[id] = { token, url: entry.url, expiresAt: now() + 60000 };
      await save();
      return true;
    });
  }
  async function contains(tabOrId) {
    await ready;
    purge();
    const id = typeof tabOrId === 'object' ? tabOrId?.id : tabOrId;
    return Boolean(state.tabs[id]);
  }
  async function release(id) {
    await ready;
    return enqueue(async () => { delete state.tabs[id]; await save(); });
  }
  async function cancel(token) {
    await ready;
    return enqueue(async () => { state.planned = state.planned.filter(item => item.token !== token); await save(); });
  }
  return { plan, claim, verify, contains, release, cancel };
}

