import { DEFAULT_SETTINGS, validateSettings } from './rules.js';
import { createPopupDuplicateGuard } from './popup-duplicate-guard.js';
import { DEFAULT_LIBRARY } from './library-schema.js';
import { canonicalUrl } from './url-identity.js';
import { DEFAULT_PREFERENCES, validatePreferences } from './preferences.js';

const STATE_KEY = 'inlineDuplicateState';
const TOKEN = /^inline-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const http = value => {
  try { return typeof value === 'string' && ['http:', 'https:'].includes(new URL(value).protocol) ? value : null; }
  catch { return null; }
};
const destination = tab => tab?.pendingUrl ? http(tab.pendingUrl) : http(tab?.url);

export function createInlineDuplicateGuard(api, onReleased = () => {}, options = {}) {
  const shouldSuppress = options.shouldSuppress || (() => false);
  const policy = options.policy || null;
  const operationLock = options.operationLock || null;
  const legacy = createPopupDuplicateGuard(api, { legacyOnly: true });
  const choices = new Map();
  const installations = new Map();
  let tail = Promise.resolve();
  const enqueue = task => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
  const getTab = async id => { try { return await api.tabs.get(id); } catch { return null; } };
  const load = async () => (await api.storage.session.get({ [STATE_KEY]: { watch: {}, prompts: {} } }))[STATE_KEY];
  const save = state => api.storage.session.set({ [STATE_KEY]: state });
  const release = id => { Promise.resolve().then(() => onReleased(id)).catch(() => {}); };
  const duplicateAllowed = url => policy?.isDuplicateAllowed ? policy.isDuplicateAllowed(url) : false;
  const promptPaused = url => policy?.isPromptPaused ? policy.isPromptPaused(url) : duplicateAllowed(url);

  async function preferences() {
    try {
      const stored = await api.storage.local.get({ preferences: DEFAULT_PREFERENCES });
      return validatePreferences(stored.preferences);
    } catch { return { ...DEFAULT_PREFERENCES }; }
  }

  async function allowed(url) {
    try { return await api.permissions.contains({ permissions: ['scripting'], origins: [`${new URL(url).origin}/*`] }); }
    catch { return false; }
  }

  async function enabled() {
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    return validateSettings(settings).duplicatePromptEnabled;
  }

  async function eligible(tab) {
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0 || tab.incognito || tab.pinned || tab.splitViewId >= 0) return false;
    try {
      const window = await api.windows.get(tab.windowId);
      if (window.type !== 'normal' || window.incognito) return false;
      if (tab.groupId >= 0) {
        const group = await api.tabGroups.get(tab.groupId);
        if (group.windowId !== tab.windowId || group.shared === true) return false;
      }
      return true;
    } catch { return false; }
  }

  async function sourceAvailable(record, allowPending = false) {
    const tab = await getTab(record.source.id);
    const stable = current => allowPending
      ? destination(current) === record.url
      : current?.url === record.url && !current.pendingUrl && current.status !== 'loading';
    if (!tab || !stable(tab)
      || tab.windowId !== record.source.windowId || (tab.groupId ?? -1) !== record.source.groupId
      || !(await eligible(tab))) return null;
    // Eligibility checks yield on window/group reads. Finish with a fresh raw
    // tab snapshot so a same-URL reload cannot hide behind the earlier check.
    const current = await getTab(record.source.id);
    return current && stable(current)
      && current.windowId === record.source.windowId && (current.groupId ?? -1) === record.source.groupId
      && !current.incognito && !current.pinned && !(Number.isInteger(current.splitViewId) && current.splitViewId >= 0)
      ? current : null;
  }

  async function targetAvailable(id, url) {
    const tab = await getTab(id);
    if (tab?.url !== url || tab.pendingUrl || tab.status === 'loading' || !(await eligible(tab))) return null;
    const current = await getTab(id);
    return current?.url === url && !current.pendingUrl && current.status !== 'loading'
      && current.windowId === tab.windowId && (current.groupId ?? -1) === (tab.groupId ?? -1)
      && !current.incognito && !current.pinned && !(Number.isInteger(current.splitViewId) && current.splitViewId >= 0)
      ? current : null;
  }

  async function dedupRules() {
    try { return (await api.storage.local.get({ library: DEFAULT_LIBRARY })).library?.dedupRules || []; }
    catch { return []; }
  }

  async function matches(url, sourceId, state, rules = []) {
    const key = canonicalUrl(url, rules);
    const result = [];
    for (const tab of await api.tabs.query({ windowType: 'normal' })) {
      if (tab.id === sourceId || canonicalUrl(tab.url, rules) !== key || tab.pendingUrl || tab.status === 'loading'
        || state.watch[tab.id]?.stage === 'prompt') continue;
      if (await eligible(tab)) result.push(tab);
    }
    return result.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || a.id - b.id);
  }

  function forget(state, token) {
    const record = state.prompts[token];
    if (record && state.watch[record.source.id]?.token === token) delete state.watch[record.source.id];
    delete state.prompts[token];
  }

  function hide(record, token) {
    if (!record?.documentId) return;
    api.tabs.sendMessage(record.source.id, { type: 'INLINE_DUPLICATE_HIDE', token },
      { documentId: record.documentId }).catch(() => {});
  }

  async function dismiss(state, token) {
    const record = state.prompts[token];
    forget(state, token);
    await save(state);
    hide(record, token);
  }

  async function ping(record, token) {
    if (!record.documentId) return false;
    try {
      const result = await api.tabs.sendMessage(record.source.id, { type: 'INLINE_DUPLICATE_PING' },
        { documentId: record.documentId });
      return result?.token === token && result.url === record.url;
    } catch { return false; }
  }

  async function finishInstallation(token, installationId, results, error) {
    const state = await load();
    const record = state.prompts[token];
    if (!record || record.phase !== 'installing' || record.installationId !== installationId) return;
    const result = results?.find(item => item.frameId === 0);
    if (error || !result?.documentId || result.result?.url !== record.url
      || !(await sourceAvailable(record)) || !(await enabled()) || !(await allowed(record.url)) || await promptPaused(record.url)) {
      await dismiss(state, token);
      release(record.source.id);
      return;
    }
    if (!result.result.ready) {
      if (record.attempts < 2) { record.phase = 'waiting'; await save(state); }
      else { await dismiss(state, token); release(record.source.id); }
      return;
    }
    record.documentId = result.documentId;
    record.phase = 'shown';
    await save(state);
    try {
      if (!(await sourceAvailable(record))) throw Error('Source changed');
      const response = await api.tabs.sendMessage(record.source.id, { type: 'INLINE_DUPLICATE_SHOW', token,
        url: record.url, title: record.title, count: record.count, preferences: await preferences() },
      { documentId: record.documentId });
      if (response?.shown !== true) throw Error('Overlay unavailable');
    } catch {
      await dismiss(state, token);
      release(record.source.id);
    }
  }

  function launchInstallation(record, token) {
    // Installation can wait on a renderer. Its completion must not hold the
    // observation queue, and a late completion may never revive a removed token.
    const installationId = record.installationId;
    installations.set(token, installationId);
    const clear = () => { if (installations.get(token) === installationId) installations.delete(token); };
    Promise.resolve().then(() => api.scripting.executeScript({ target: { tabId: record.source.id, frameIds: [0] },
      files: ['inline-prompt.js'], world: 'ISOLATED', injectImmediately: true }))
      .then(results => enqueue(() => finishInstallation(token, installationId, results)),
        error => enqueue(() => finishInstallation(token, installationId, null, error)))
      .then(clear, clear);
  }

  async function check(id, state) {
    const entry = state.watch[id];
    if (!entry) return false;
    if (entry.stage === 'watching') {
      const tab = await getTab(id);
      if (!tab) { delete state.watch[id]; await save(state); return false; }
      const url = destination(tab);
      if (!url) return false;
      delete state.watch[id];
      await save(state);
      const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
      if (!validateSettings(settings).duplicatePromptEnabled || !(await eligible(tab)) || !(await allowed(url))
        || await promptPaused(url)) return false;
      const targets = await matches(url, id, state, await dedupRules());
      if (!targets.length) return false;
      const token = `inline-${crypto.randomUUID()}`;
      state.prompts[token] = { source: { id, windowId: tab.windowId, groupId: tab.groupId ?? -1 },
        url, title: targets[0].title || url, count: targets.length, targetId: targets[0].id, targetUrl: targets[0].url,
        documentId: null, phase: 'waiting', attempts: 0 };
      state.watch[id] = { stage: 'prompt', token };
      await save(state);
    }
    const token = state.watch[id]?.token;
    const record = state.prompts[token];
    if (!record) return false;
    const source = await sourceAvailable(record, record.phase === 'waiting' && !record.documentId);
    if (!source || !(await enabled()) || !(await allowed(record.url)) || await promptPaused(record.url)) {
      await dismiss(state, token);
      return false;
    }
    if (record.phase === 'installing' && !installations.has(token)) {
      if (record.attempts >= 2) { await dismiss(state, token); return false; }
      record.phase = 'waiting';
    }
    if (record.phase === 'shown' && !(await ping(record, token))) { await dismiss(state, token); return false; }
    // A committed URL can still be loading. Retain the first-navigation watch
    // until complete instead of installing an overlay that strict document
    // checks would immediately discard. Keep those checks strict for reloads.
    if (record.phase === 'waiting' && source.url === record.url && !source.pendingUrl && source.status !== 'loading') {
      record.phase = 'installing';
      record.attempts++;
      record.installationId = crypto.randomUUID();
      await save(state);
      launchInstallation(record, token);
    }
    return true;
  }

  const created = tab => enqueue(async () => {
    const current = await getTab(tab.id);
    if (await shouldSuppress(current) || current?.url?.startsWith(api.runtime.getURL('duplicate.html')) || !(await eligible(current))) return false;
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    if (!validateSettings(settings).duplicatePromptEnabled) return false;
    const state = await load();
    state.watch[tab.id] = { stage: 'watching' };
    await save(state);
    return check(tab.id, state);
  });
  const updated = id => enqueue(async () => {
    const current = await getTab(id);
    if (await shouldSuppress(current)) {
      const state = await load();
      const token = state.watch[id]?.token;
      if (token) await dismiss(state, token);
      else if (state.watch[id]) { delete state.watch[id]; await save(state); }
      return false;
    }
    const previous = await legacy.updated(id);
    const suppressed = await check(id, await load());
    if (typeof previous === 'object') return { ...previous, suppressed: previous.suppressed || suppressed };
    return previous || suppressed;
  });

  function authenticate(message, sender) {
    if (!TOKEN.test(message.token) || sender.id !== api.runtime.id || !Number.isInteger(sender.tab?.id)
      || sender.frameId !== 0 || typeof sender.documentId !== 'string' || !http(sender.url)
      || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) throw Error('这个页内提醒已失效。');
  }

  async function context(message, sender, requirePrompt = true) {
    authenticate(message, sender);
    const state = await load();
    const record = state.prompts[message.token];
    if (!record || record.source.id !== sender.tab.id || record.documentId !== sender.documentId
      || record.url !== sender.url || !(await sourceAvailable(record))) throw Error('网页已经变化，未操作其他标签。');
    if (requirePrompt) {
      const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
      if (!validateSettings(settings).duplicatePromptEnabled || !(await allowed(record.url))
        || await promptPaused(record.url)) {
        throw Error('页内提醒已关闭、已暂停或权限已撤销，请保留新标签。');
      }
    }
    return { state, record };
  }

  async function promptStillEnabled(record, expectedTargetUrl) {
    try {
      const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
      if (!validateSettings(settings).duplicatePromptEnabled || !(await allowed(record.url))
        || await promptPaused(record.url)) return false;
      const rules = await dedupRules();
      const sourceKey = canonicalUrl(record.url, rules);
      return sourceKey !== null && sourceKey === canonicalUrl(expectedTargetUrl, rules);
    } catch { return false; }
  }

  async function chooseOnce(message, sender) {
    const { token } = message;
    const { state, record } = await context(message, sender);
    if (record.phase !== 'shown') throw Error('正在处理上一次选择，请处理 Chrome 的关闭提示。');
    const candidates = await matches(record.url, record.source.id, state, await dedupRules());
    const target = candidates.find(tab => tab.id === record.targetId) || candidates[0];
    const expectedTargetUrl = target?.id === record.targetId ? (record.targetUrl || record.url) : target?.url;
    const existing = target && await targetAvailable(target.id, expectedTargetUrl);
    if (!existing || !(await ping(record, token))) throw Error('已有标签或当前网页已变化，可以保留新标签。');
    record.phase = 'switching';
    await save(state);
    try {
      if (!(await sourceAvailable(record)) || !(await targetAvailable(existing.id, expectedTargetUrl))
        || !(await ping(record, token))) throw Error('网页已经变化，已保留新标签。');
      await api.tabs.update(existing.id, { active: true });
      const focused = await targetAvailable(existing.id, expectedTargetUrl);
      if (!focused) throw Error('已有标签已变化，已保留新标签。');
      await api.windows.update(focused.windowId, { focused: true });
      record.phase = 'closing';
      await save(state);
      if (!(await promptStillEnabled(record, expectedTargetUrl))
        || !(await targetAvailable(existing.id, expectedTargetUrl))
        || !(await ping(record, token))) throw Error('网页、提醒策略或权限已经变化，已保留新标签。');
      // This is deliberately the final awaited check before remove. It includes
      // a fresh raw snapshot after window/group checks and rejects reloads even
      // when pendingUrl equals the committed URL.
      if (!(await sourceAvailable(record))) throw Error('网页已经变化，已保留新标签。');
      const removal = api.tabs.remove(record.source.id).then(() => null, error => error);
      return { removal, token, sourceId: record.source.id };
    } catch (error) {
      record.phase = 'shown';
      await save(state);
      throw error;
    }
  }

  async function finishRemoval(operation) {
    const error = await operation.removal;
    return enqueue(async () => {
      const state = await load();
      const record = state.prompts[operation.token];
      const closed = !(await getTab(operation.sourceId));
      if (!closed) {
        if (record) { record.phase = 'shown'; await save(state); }
        if (error) throw error;
        return { action: 'switched', closed: false };
      }
      if (record) await dismiss(state, operation.token);
      return { action: 'switched', closed: true };
    });
  }

  const chooseInline = (message, sender) => {
    try {
      authenticate(message, sender);
      if (!['switch', 'keep', 'pause-site'].includes(message.choice)) throw Error('选择无效。');
    } catch (error) { return Promise.reject(error); }
    if (message.choice === 'keep') return enqueue(async () => {
      const { state, record } = await context(message, sender, false);
      await dismiss(state, message.token);
      return { action: 'kept', releasedId: record.source.id };
    });
    if (message.choice === 'pause-site') return enqueue(async () => {
      if (!policy?.pauseSite) throw Error('暂停策略暂不可用。');
      const { state, record } = await context(message, sender, false);
      const origin = new URL(record.url).origin;
      await policy.pauseSite(origin);
      await dismiss(state, message.token);
      return { action: 'paused', origin, releasedId: record.source.id };
    });
    const key = `${message.token}:${sender.documentId}`;
    if (choices.has(key)) return choices.get(key);
    const execute = () => enqueue(() => chooseOnce(message, sender))
      .then(result => result.removal ? finishRemoval(result) : result);
    const task = operationLock ? operationLock.run('inline-duplicate', execute) : execute();
    choices.set(key, task);
    const clear = () => { if (choices.get(key) === task) choices.delete(key); };
    task.then(clear, clear);
    return task;
  };

  const removed = id => enqueue(async () => {
    const released = await legacy.removed(id);
    const state = await load();
    for (const [token, record] of Object.entries(state.prompts)) {
      if (record.source.id === id) await dismiss(state, token);
    }
    delete state.watch[id];
    await save(state);
    return released;
  });
  const replaced = (added, old) => enqueue(async () => {
    const previous = await legacy.replaced(added, old);
    const state = await load();
    if (state.watch[old]?.stage === 'watching') state.watch[added] = state.watch[old];
    for (const [token, record] of Object.entries(state.prompts)) {
      if (record.source.id === old) await dismiss(state, token);
    }
    delete state.watch[old];
    await save(state);
    return await check(added, state) || previous;
  });
  const permissionsChanged = (forceDisabled = false) => enqueue(async () => {
    const state = await load();
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    // Remember an observed off transition even if settings are re-enabled
    // while an older observation is still ahead of this cleanup in the queue.
    const enabled = forceDisabled !== true && validateSettings(settings).duplicatePromptEnabled;
    const released = [];
    if (!enabled) {
      for (const [id, entry] of Object.entries(state.watch)) {
        if (entry.stage === 'watching') { delete state.watch[id]; released.push(Number(id)); }
      }
      await save(state);
    }
    for (const [token, record] of Object.entries(state.prompts)) {
      if (!enabled || !(await allowed(record.url))) { released.push(record.source.id); await dismiss(state, token); }
    }
    return released;
  });
  // Restore only our persisted pending reminders, never enroll existing tabs.
  // A new worker has no live renderer requests from the previous worker.
  enqueue(async () => {
    const state = await load();
    for (const record of Object.values(state.prompts)) {
      if (!(await check(record.source.id, state))) release(record.source.id);
    }
  }).catch(() => {});
  return { created, updated, removed, replaced, permissionsChanged, chooseInline,
    info: (message, sender) => legacy.info(message, sender), choose: (message, sender) => legacy.choose(message, sender) };
}
