const ALLOWLIST_KEY = 'duplicateAllowlist';
const PAUSED_SITES_KEY = 'duplicatePausedSites';
const PAUSED_TABS_KEY = 'groupingPausedTabs';
const SITE_PAUSE_MS = 30 * 60 * 1000;

function exactOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.origin !== value || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function originForUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function normalizeDuplicateAllowlist(origins) {
  if (!Array.isArray(origins) || origins.length > 100) throw Error('重复页例外站点格式无效。');
  const seen = new Set();
  return origins.map(value => {
    const origin = exactOrigin(value);
    if (!origin) throw Error('重复页例外站点必须是精确的 HTTP(S) origin。');
    if (seen.has(origin)) throw Error('重复页例外站点不能重复。');
    seen.add(origin);
    return origin;
  });
}

export function createDuplicatePolicy(api, sharedEnqueue, now = Date.now) {
  let tail = Promise.resolve();
  const enqueue = typeof sharedEnqueue === 'function' ? sharedEnqueue : task => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };

  function normalizeSites(value, timestamp) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    for (const [origin, expiresAt] of Object.entries(value)) {
      if (exactOrigin(origin) && Number.isFinite(expiresAt) && expiresAt > timestamp) result[origin] = expiresAt;
    }
    return result;
  }

  function normalizeTabs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    for (const [id, paused] of Object.entries(value)) {
      const number = Number(id);
      if (paused === true && Number.isInteger(number) && number >= 0 && String(number) === id) result[id] = true;
    }
    return result;
  }

  function readState() {
    return enqueue(async () => {
      const timestamp = now();
      const [local, session] = await Promise.all([
        api.storage.local.get({ [ALLOWLIST_KEY]: [] }),
        api.storage.session.get({ [PAUSED_SITES_KEY]: {}, [PAUSED_TABS_KEY]: {} }),
      ]);
      let allowlist;
      try { allowlist = normalizeDuplicateAllowlist(local[ALLOWLIST_KEY]); }
      catch { allowlist = []; }
      const pausedSites = normalizeSites(session[PAUSED_SITES_KEY], timestamp);
      const pausedTabs = normalizeTabs(session[PAUSED_TABS_KEY]);
      const sitesChanged = JSON.stringify(pausedSites) !== JSON.stringify(session[PAUSED_SITES_KEY] || {});
      const tabsChanged = JSON.stringify(pausedTabs) !== JSON.stringify(session[PAUSED_TABS_KEY] || {});
      if (sitesChanged || tabsChanged) {
        await api.storage.session.set({
          ...(sitesChanged ? { [PAUSED_SITES_KEY]: pausedSites } : {}),
          ...(tabsChanged ? { [PAUSED_TABS_KEY]: pausedTabs } : {}),
        });
      }
      return { allowlist, pausedSites, pausedTabs };
    });
  }

  return {
    getState: readState,
    setAllowlist(origins) {
      const allowlist = normalizeDuplicateAllowlist(origins);
      return enqueue(async () => {
        await api.storage.local.set({ [ALLOWLIST_KEY]: allowlist });
        return [...allowlist];
      });
    },
    pauseSite(origin) {
      const normalized = exactOrigin(origin);
      if (!normalized) return Promise.reject(Error('只能暂停精确的 HTTP(S) origin。'));
      return enqueue(async () => {
        const stored = await api.storage.session.get({ [PAUSED_SITES_KEY]: {} });
        const timestamp = now();
        const pausedSites = normalizeSites(stored[PAUSED_SITES_KEY], timestamp);
        pausedSites[normalized] = timestamp + SITE_PAUSE_MS;
        await api.storage.session.set({ [PAUSED_SITES_KEY]: pausedSites });
        return pausedSites[normalized];
      });
    },
    pauseTab(tabId, paused = true) {
      if (!Number.isInteger(tabId) || tabId < 0 || typeof paused !== 'boolean') {
        return Promise.reject(Error('标签暂停状态无效。'));
      }
      return enqueue(async () => {
        const stored = await api.storage.session.get({ [PAUSED_TABS_KEY]: {} });
        const pausedTabs = normalizeTabs(stored[PAUSED_TABS_KEY]);
        if (paused) pausedTabs[tabId] = true;
        else delete pausedTabs[tabId];
        await api.storage.session.set({ [PAUSED_TABS_KEY]: pausedTabs });
        return paused;
      });
    },
    async isDuplicateAllowed(url) {
      const origin = originForUrl(url);
      if (!origin) return false;
      return (await readState()).allowlist.includes(origin);
    },
    async isPromptPaused(url) {
      const origin = originForUrl(url);
      if (!origin) return false;
      const state = await readState();
      return state.allowlist.includes(origin) || Object.hasOwn(state.pausedSites, origin);
    },
    async isGroupingPaused(tab) {
      return Boolean(Number.isInteger(tab?.id) && (await readState()).pausedTabs[tab.id]);
    },
    removed(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve(false);
      return enqueue(async () => {
        const stored = await api.storage.session.get({ [PAUSED_TABS_KEY]: {} });
        const pausedTabs = normalizeTabs(stored[PAUSED_TABS_KEY]);
        if (!pausedTabs[tabId]) return false;
        delete pausedTabs[tabId];
        await api.storage.session.set({ [PAUSED_TABS_KEY]: pausedTabs });
        return true;
      });
    },
    replaced(added, removed) {
      if (!Number.isInteger(added) || added < 0 || !Number.isInteger(removed) || removed < 0) {
        return Promise.resolve(false);
      }
      return enqueue(async () => {
        const stored = await api.storage.session.get({ [PAUSED_TABS_KEY]: {} });
        const pausedTabs = normalizeTabs(stored[PAUSED_TABS_KEY]);
        const migrated = Boolean(pausedTabs[removed]);
        delete pausedTabs[removed];
        if (migrated) pausedTabs[added] = true;
        await api.storage.session.set({ [PAUSED_TABS_KEY]: pausedTabs });
        return migrated;
      });
    },
  };
}
