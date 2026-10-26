import { canonicalUrl } from './url-identity.js';
import { normalizeDuplicateAllowlist } from './duplicate-policy.js';

const PREVIEW_KEY = 'deduplicationPreviewTokens';
const PREVIEW_TTL = 5 * 60 * 1000;

function urlKey(tab, rules = []) {
  if (!tab || typeof tab.url !== 'string' || tab.incognito || !Number.isInteger(tab.id) || tab.id < 0) return null;
  try {
    const url = new URL(tab.url);
    return ['http:', 'https:'].includes(url.protocol) ? canonicalUrl(tab.url, rules) : null;
  } catch { return null; }
}

function originOf(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}

function hasSplitView(tab) {
  return Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0;
}

function buckets(tabs, rules = []) {
  const byUrl = new Map();
  for (const tab of tabs) {
    const key = urlKey(tab, rules);
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(tab);
  }
  return byUrl;
}

function duplicateCount(tabs, rules = []) {
  return [...buckets(tabs, rules).values()].reduce((total, group) => total + Math.max(0, group.length - 1), 0);
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

function snapshotTab(tab) {
  return {
    id: tab.id,
    title: typeof tab.title === 'string' ? tab.title : '',
    url: tab.url,
    windowId: tab.windowId,
    groupId: tab.groupId ?? -1,
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    active: Boolean(tab.active),
    lastAccessed: accessedAt(tab),
    index: Number.isInteger(tab.index) ? tab.index : 0,
    incognito: Boolean(tab.incognito),
    splitViewId: Number.isInteger(tab.splitViewId) ? tab.splitViewId : -1,
    pendingUrl: tab.pendingUrl || null,
    status: tab.status || null,
  };
}

function publicTab(tab) {
  const { id, title, url, windowId, groupId, pinned, audible, active, lastAccessed } = tab;
  return { id, title, url, windowId, groupId, pinned, audible, active, lastAccessed };
}

function unchanged(tab, original, key, rules = []) {
  return tab.url === original.url && urlKey(tab, rules) === key && tab.windowId === original.windowId
    && (tab.groupId ?? -1) === original.groupId
    && Boolean(tab.pinned) === original.pinned
    && Boolean(tab.audible) === original.audible
    && Boolean(tab.active) === original.active
    && accessedAt(tab) === original.lastAccessed
    && Boolean(tab.incognito) === original.incognito
    && (Number.isInteger(tab.splitViewId) ? tab.splitViewId : -1) === original.splitViewId
    && (tab.pendingUrl || null) === original.pendingUrl
    && (tab.status || null) === original.status
    && !tab.pendingUrl && tab.status !== 'loading' && !hasSplitView(tab);
}

function normalizeScope(request = {}) {
  const scope = request.scope ?? 'all';
  if (!['all', 'window', 'group'].includes(scope)) throw Error('重复页预览范围无效。');
  if (scope === 'window' && (!Number.isInteger(request.windowId) || request.windowId < 0)) {
    throw Error('重复页预览窗口无效。');
  }
  if (scope === 'group' && (!Number.isInteger(request.groupId) || request.groupId < 0)) {
    throw Error('重复页预览标签组无效。');
  }
  return {
    scope,
    ...(scope === 'window' ? { windowId: request.windowId } : {}),
    ...(scope === 'group' ? { groupId: request.groupId } : {}),
  };
}

function inScope(tab, scope) {
  if (scope.scope === 'window') return tab.windowId === scope.windowId;
  if (scope.scope === 'group') return (tab.groupId ?? -1) === scope.groupId;
  return true;
}

const sameSummary = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function createDeduplicator(api, options = {}) {
  const journal = options.journal || null;
  const policy = options.policy || null;
  const getRules = options.getRules || (async () => []);
  const getAllowlist = options.getAllowlist || (async () => []);
  const now = options.now || Date.now;
  let inFlight = null;
  let tokenTail = Promise.resolve();
  const executions = new Map();

  const enqueueToken = task => {
    const next = tokenTail.then(task);
    tokenTail = next.catch(() => {});
    return next;
  };

  async function allowlistSnapshot() {
    const raw = policy?.getState ? (await policy.getState()).allowlist : await getAllowlist();
    return normalizeDuplicateAllowlist(raw || []);
  }

  const allowed = (tab, allowlist) => Boolean(originOf(tab?.url) && allowlist.includes(originOf(tab.url)));

  async function isPrivateLocalGroup(tab, groups = null) {
    if (!(tab.groupId >= 0)) return true;
    let group;
    try { group = groups ? groups.find(item => item.id === tab.groupId) : await api.tabGroups.get(tab.groupId); }
    catch { return false; }
    return group && group.windowId === tab.windowId && group.shared !== true;
  }

  async function readSafe(id, rules, allowlist) {
    try {
      const tab = await api.tabs.get(id);
      if (!urlKey(tab, rules) || allowed(tab, allowlist) || tab.pendingUrl || tab.status === 'loading' || hasSplitView(tab)) return null;
      const window = await api.windows.get(tab.windowId);
      if (window.type !== 'normal' || window.incognito || !(await isPrivateLocalGroup(tab))) return null;
      return tab;
    } catch { return null; }
  }

  async function focusedWindow() {
    try { return (await api.windows.getLastFocused({ windowTypes: ['normal'] })).id; }
    catch { return -1; }
  }

  async function buildPlan(scope, rules, allowlist) {
    const initial = await api.tabs.query({ windowType: 'normal' });
    const groups = await api.tabGroups.query({});
    const focusedWindowId = await focusedWindow();
    const eligible = [];
    for (const tab of initial) {
      if (inScope(tab, scope) && urlKey(tab, rules) && !allowed(tab, allowlist) && !hasSplitView(tab)
        && !tab.pendingUrl && tab.status !== 'loading' && await isPrivateLocalGroup(tab, groups)) eligible.push(tab);
    }
    const result = [];
    for (const [key, group] of buckets(eligible, rules)) {
      if (group.length < 2) continue;
      group.sort((a, b) => compareTabs(a, b, focusedWindowId));
      const snapshots = group.map(snapshotTab);
      result.push({ id: crypto.randomUUID(), url: key, keeperId: snapshots[0].id, tabs: snapshots,
        reason: snapshots.some(tab => tab.url !== key) ? 'ignored-parameters' : 'exact-url' });
    }
    const createdAt = now();
    return { scope, focusedWindowId, rules, allowlist, buckets: result,
      createdAt, expiresAt: createdAt + PREVIEW_TTL };
  }

  async function storePlan(plan) {
    const token = `dedup-${crypto.randomUUID()}`;
    await enqueueToken(async () => {
      const stored = await api.storage.session.get({ [PREVIEW_KEY]: {} });
      const previews = stored[PREVIEW_KEY] && typeof stored[PREVIEW_KEY] === 'object' ? stored[PREVIEW_KEY] : {};
      const timestamp = now();
      for (const [key, item] of Object.entries(previews)) {
        if (!item || !Number.isFinite(item.expiresAt) || item.expiresAt <= timestamp) delete previews[key];
      }
      previews[token] = plan;
      await api.storage.session.set({ [PREVIEW_KEY]: previews });
    });
    return token;
  }

  async function preview(request = {}) {
    const scope = normalizeScope(request);
    const [rules, allowlist] = await Promise.all([getRules(), allowlistSnapshot()]);
    const plan = await buildPlan(scope, rules, allowlist);
    const token = await storePlan(plan);
    const count = plan.buckets.reduce((total, bucket) => total + bucket.tabs.length - 1, 0);
    return { token,
      buckets: plan.buckets.map(bucket => ({ ...bucket, tabs: bucket.tabs.map(publicTab) })),
      summary: { buckets: plan.buckets.length, duplicates: count, ...scope },
      expiresAt: plan.expiresAt };
  }

  async function claimPlan(token) {
    if (typeof token !== 'string' || !token.startsWith('dedup-')) throw Error('重复页预览凭证无效。');
    return enqueueToken(async () => {
      const stored = await api.storage.session.get({ [PREVIEW_KEY]: {} });
      const previews = stored[PREVIEW_KEY] && typeof stored[PREVIEW_KEY] === 'object' ? stored[PREVIEW_KEY] : {};
      const plan = previews[token];
      delete previews[token];
      const timestamp = now();
      for (const [key, item] of Object.entries(previews)) {
        if (!item || !Number.isFinite(item.expiresAt) || item.expiresAt <= timestamp) delete previews[key];
      }
      await api.storage.session.set({ [PREVIEW_KEY]: previews });
      if (!plan || !Number.isFinite(plan.expiresAt) || plan.expiresAt <= timestamp) {
        throw Error('重复页预览已失效，请重新预览。');
      }
      return plan;
    });
  }

  function selectBuckets(plan, selections) {
    if (!Array.isArray(selections) || selections.length > plan.buckets.length) throw Error('重复页选择无效。');
    const byId = new Map(plan.buckets.map(bucket => [bucket.id, bucket]));
    const seen = new Set();
    return selections.map(selection => {
      if (!selection || typeof selection !== 'object' || seen.has(selection.bucketId)) throw Error('重复页选择无效。');
      const bucket = byId.get(selection.bucketId);
      if (!bucket || !Number.isInteger(selection.keeperId)
        || !bucket.tabs.some(tab => tab.id === selection.keeperId)) throw Error('所选保留标签不属于该重复组。');
      seen.add(selection.bucketId);
      return { bucket, keeperId: selection.keeperId };
    });
  }

  async function focusUnchanged(focusedWindowId) {
    if (focusedWindowId < 0) return true;
    try { return (await api.windows.getLastFocused({ windowTypes: ['normal'] })).id === focusedWindowId; }
    catch { return false; }
  }

  async function policyUnchanged(plan) {
    try {
      const [rules, allowlist] = await Promise.all([getRules(), allowlistSnapshot()]);
      return sameSummary(rules, plan.rules) && sameSummary(allowlist, plan.allowlist);
    } catch { return false; }
  }

  async function executePlan(plan, selected) {
    const initialDuplicates = selected.reduce((total, item) => total + item.bucket.tabs.length - 1, 0);
    if (!initialDuplicates) return { closed: 0, skipped: 0, failed: 0,
      remaining: plan.buckets.reduce((total, bucket) => total + bucket.tabs.length - 1, 0) };
    const groups = await api.tabGroups.query({});
    const requested = new Set();
    const failedRequests = new Set();
    const prepared = new Map();
    const batchId = journal?.begin();
    outer: for (const { bucket, keeperId } of selected) {
      const keeper = bucket.tabs.find(tab => tab.id === keeperId);
      const duplicates = bucket.tabs.filter(tab => tab.id !== keeperId);
      for (const original of duplicates) {
        const candidate = await readSafe(original.id, plan.rules, plan.allowlist);
        if (!candidate || !unchanged(candidate, original, bucket.url, plan.rules)) continue;
        const survivor = await readSafe(keeper.id, plan.rules, plan.allowlist);
        if (!survivor || !unchanged(survivor, keeper, bucket.url, plan.rules)) break;
        const latest = await readSafe(original.id, plan.rules, plan.allowlist);
        if (!latest || !unchanged(latest, original, bucket.url, plan.rules)) continue;
        if (!(await focusUnchanged(plan.focusedWindowId))) break;
        if (journal) {
          try {
            const groupInfo = original.groupId >= 0 ? groups.find(item => item.id === original.groupId) : null;
            prepared.set(original.id, await journal.prepare(batchId, original, groupInfo));
          } catch { failedRequests.add(original.id); continue; }
        }
        const keeperAfterJournal = await readSafe(keeper.id, plan.rules, plan.allowlist);
        if (!keeperAfterJournal || !unchanged(keeperAfterJournal, keeper, bucket.url, plan.rules)) continue;
        if (!(await focusUnchanged(plan.focusedWindowId))) continue;
        // A preview authorizes only the exact rule/allowlist snapshot it showed.
        // Re-read it after journal.prepare and before every remove; a changed or
        // unreadable policy stops the whole fixed plan without retrying.
        if (!(await policyUnchanged(plan))) break outer;
        const keeperAfterPolicy = await readSafe(keeper.id, plan.rules, plan.allowlist);
        if (!keeperAfterPolicy || !unchanged(keeperAfterPolicy, keeper, bucket.url, plan.rules)) continue;
        if (!(await focusUnchanged(plan.focusedWindowId))) continue;
        const afterJournal = await readSafe(original.id, plan.rules, plan.allowlist);
        if (!afterJournal || !unchanged(afterJournal, original, bucket.url, plan.rules)) continue;
        requested.add(original.id);
        try { await api.tabs.remove(original.id); }
        catch { failedRequests.add(original.id); }
      }
    }

    let finalTabs;
    try { finalTabs = await api.tabs.query({ windowType: 'normal' }); }
    catch { throw new Error('关闭操作已执行，但无法确认最终状态。请刷新列表查看；不会自动重试关闭。'); }
    let allTabs;
    try { allTabs = await api.tabs.query({}); }
    catch { throw new Error('关闭操作已执行，但无法确认哪些标签已关闭。请刷新列表查看。'); }
    const liveIds = new Set(allTabs.map(tab => tab.id));
    const closed = [...requested].filter(id => !liveIds.has(id)).length;
    const failed = [...failedRequests].filter(id => liveIds.has(id)).length;
    if (journal && prepared.size) {
      const outcomes = new Map();
      for (const [tabId, itemId] of prepared) {
        outcomes.set(itemId, !liveIds.has(tabId) ? 'closed' : '页面仍存在，未记录为可恢复。');
      }
      await journal.settle(batchId, outcomes);
    }
    const remainingEligible = [];
    for (const tab of finalTabs) {
      if (inScope(tab, plan.scope) && urlKey(tab, plan.rules) && !allowed(tab, plan.allowlist)
        && !hasSplitView(tab) && !tab.pendingUrl && tab.status !== 'loading' && await isPrivateLocalGroup(tab)) {
        remainingEligible.push(tab);
      }
    }
    return { closed, skipped: Math.max(0, initialDuplicates - closed - failed), failed,
      remaining: duplicateCount(remainingEligible, plan.rules) };
  }

  async function runLegacy() {
    const [rules, allowlist] = await Promise.all([getRules(), allowlistSnapshot()]);
    const plan = await buildPlan(normalizeScope({ scope: 'all' }), rules, allowlist);
    return executePlan(plan, plan.buckets.map(bucket => ({ bucket, keeperId: bucket.keeperId })));
  }

  async function runConfirmed(request) {
    if (!request || typeof request !== 'object') throw Error('重复页执行请求无效。');
    const plan = await claimPlan(request.token);
    const [rules, allowlist] = await Promise.all([getRules(), allowlistSnapshot()]);
    if (!sameSummary(rules, plan.rules) || !sameSummary(allowlist, plan.allowlist)) {
      throw Error('重复页规则或例外站点已经变化，请重新预览。');
    }
    return executePlan(plan, selectBuckets(plan, request.selections));
  }

  function deduplicate(request) {
    if (request !== undefined) {
      const key = request?.token;
      if (typeof key === 'string' && executions.has(key)) return executions.get(key);
      const task = runConfirmed(request);
      if (typeof key === 'string') {
        executions.set(key, task);
        const clear = () => { if (executions.get(key) === task) executions.delete(key); };
        task.then(clear, clear);
      }
      return task;
    }
    if (!inFlight) inFlight = runLegacy().finally(() => { inFlight = null; });
    return inFlight;
  }

  deduplicate.preview = preview;
  return deduplicate;
}
