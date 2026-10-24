function urlKey(tab) {
  if (!tab || typeof tab.url !== 'string' || tab.incognito || !Number.isInteger(tab.id) || tab.id < 0) return null;
  try {
    const url = new URL(tab.url);
    return ['http:', 'https:'].includes(url.protocol) ? tab.url : null;
  } catch { return null; }
}

function hasSplitView(tab) {
  return Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0;
}

function buckets(tabs) {
  const byUrl = new Map();
  for (const tab of tabs) {
    const key = urlKey(tab);
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(tab);
  }
  return byUrl;
}

function duplicateCount(tabs) {
  return [...buckets(tabs).values()].reduce((total, group) => total + Math.max(0, group.length - 1), 0);
}

function accessedAt(tab) {
  return Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0;
}

function compareTabs(a, b, focusedWindowId) {
  const priorities = tab => [
    tab.windowId === focusedWindowId && tab.active ? 1 : 0,
    tab.pinned ? 1 : 0,
    tab.audible ? 1 : 0,
    tab.active ? 1 : 0,
    accessedAt(tab),
  ];
  const left = priorities(a);
  const right = priorities(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return a.id - b.id;
}

function unchanged(tab, original, key) {
  return urlKey(tab) === key && tab.windowId === original.windowId
    && (tab.groupId ?? -1) === (original.groupId ?? -1)
    && Boolean(tab.pinned) === Boolean(original.pinned)
    && Boolean(tab.audible) === Boolean(original.audible)
    && Boolean(tab.active) === Boolean(original.active)
    && accessedAt(tab) === accessedAt(original)
    && !tab.pendingUrl && tab.status !== 'loading' && !hasSplitView(tab);
}

export function createDeduplicator(api) {
  let inFlight = null;

  async function isPrivateLocalGroup(tab, groups = null) {
    if (!(tab.groupId >= 0)) return true;
    let group;
    try {
      group = groups ? groups.find(item => item.id === tab.groupId) : await api.tabGroups.get(tab.groupId);
    } catch { return false; }
    return group && group.windowId === tab.windowId && group.shared !== true;
  }

  async function readSafe(id) {
    try {
      const tab = await api.tabs.get(id);
      if (!urlKey(tab) || tab.pendingUrl || tab.status === 'loading' || hasSplitView(tab)) return null;
      const window = await api.windows.get(tab.windowId);
      if (window.type !== 'normal' || window.incognito || !(await isPrivateLocalGroup(tab))) return null;
      return tab;
    } catch { return null; }
  }

  async function run() {
    const initial = await api.tabs.query({ windowType: 'normal' });
    const initialDuplicates = duplicateCount(initial);
    if (initialDuplicates === 0) return { closed: 0, skipped: 0, failed: 0, remaining: 0 };
    const groups = await api.tabGroups.query({});
    let focusedWindowId = -1;
    try { focusedWindowId = (await api.windows.getLastFocused({ windowTypes: ['normal'] })).id; }
    catch { /* Stable fallback still preserves pinned, audible and active tabs. */ }

    const eligible = [];
    for (const tab of initial) {
      if (urlKey(tab) && !hasSplitView(tab) && !tab.pendingUrl && tab.status !== 'loading'
        && await isPrivateLocalGroup(tab, groups)) eligible.push(tab);
    }
    const requested = new Set();
    const failedRequests = new Set();
    for (const [key, group] of buckets(eligible)) {
      if (group.length < 2) continue;
      group.sort((a, b) => compareTabs(a, b, focusedWindowId));
      const [keeper, ...duplicates] = group;
      // The keeper is fixed for this run and is never scheduled for removal.
      for (const original of duplicates) {
        const candidate = await readSafe(original.id);
        if (!candidate || !unchanged(candidate, original, key)) continue;
        const survivor = await readSafe(keeper.id);
        if (!survivor || !unchanged(survivor, keeper, key)) break;
        // Refresh after the keeper's asynchronous checks; do not close a changed page.
        const latest = await readSafe(original.id);
        if (!latest || !unchanged(latest, original, key)) continue;
        if (focusedWindowId >= 0) {
          let focused;
          try { focused = await api.windows.getLastFocused({ windowTypes: ['normal'] }); }
          catch { break; }
          // Switching windows does not change each window's active-tab flags.
          if (focused.id !== focusedWindowId) break;
        }
        requested.add(original.id);
        try {
          // Await Chrome's native closing flow. Never auto-retry a pending close.
          await api.tabs.remove(original.id);
        } catch { failedRequests.add(original.id); }
      }
    }

    let finalTabs;
    try { finalTabs = await api.tabs.query({ windowType: 'normal' }); }
    catch { throw new Error('关闭操作已执行，但无法确认最终状态。请刷新列表查看；不会自动重试关闭。'); }
    // Count disappearance globally: moving a tab outside normal windows is not closure.
    let allTabs;
    try { allTabs = await api.tabs.query({}); }
    catch { throw new Error('关闭操作已执行，但无法确认哪些标签已关闭。请刷新列表查看。'); }
    const liveIds = new Set(allTabs.map(tab => tab.id));
    const closed = [...requested].filter(id => !liveIds.has(id)).length;
    const failed = [...failedRequests].filter(id => liveIds.has(id)).length;
    return {
      closed,
      skipped: Math.max(0, initialDuplicates - closed - failed),
      failed,
      remaining: duplicateCount(finalTabs),
    };
  }

  return function deduplicate() {
    if (!inFlight) {
      inFlight = run().finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
