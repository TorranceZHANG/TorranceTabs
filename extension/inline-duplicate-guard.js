import { DEFAULT_SETTINGS, validateSettings } from './rules.js';
import { createPopupDuplicateGuard } from './popup-duplicate-guard.js';

const STATE_KEY = 'inlineDuplicateState';
const TOKEN = /^inline-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const http = value => {
  try { return typeof value === 'string' && ['http:', 'https:'].includes(new URL(value).protocol) ? value : null; }
  catch { return null; }
};
const destination = tab => tab?.pendingUrl ? http(tab.pendingUrl) : http(tab?.url);

export function createInlineDuplicateGuard(api, onReleased = () => {}) {
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

  async function allowed(url) {
    try { return await api.permissions.contains({ permissions: ['scripting'], origins: [`${new URL(url).origin}/*`] }); }
    catch { return false; }
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

  async function sourceAvailable(record) {
    const tab = await getTab(record.source.id);
    return tab && destination(tab) === record.url && tab.windowId === record.source.windowId
      && (tab.groupId ?? -1) === record.source.groupId && await eligible(tab) ? tab : null;
  }

  async function targetAvailable(id, url) {
    const tab = await getTab(id);
    return tab?.url === url && (!tab.pendingUrl || tab.pendingUrl === url) && await eligible(tab) ? tab : null;
  }

  async function matches(url, sourceId, state) {
    const result = [];
    for (const tab of await api.tabs.query({ windowType: 'normal' })) {
      if (tab.id === sourceId || tab.url !== url || (tab.pendingUrl && tab.pendingUrl !== url)
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
      || !(await sourceAvailable(record)) || !(await allowed(record.url))) {
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
        url: record.url, title: record.title, count: record.count }, { documentId: record.documentId });
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
      if (!validateSettings(settings).duplicatePromptEnabled || !(await eligible(tab)) || !(await allowed(url))) return false;
      const targets = await matches(url, id, state);
      if (!targets.length) return false;
      const token = `inline-${crypto.randomUUID()}`;
      state.prompts[token] = { source: { id, windowId: tab.windowId, groupId: tab.groupId ?? -1 },
        url, title: targets[0].title || url, count: targets.length, targetId: targets[0].id,
        documentId: null, phase: 'waiting', attempts: 0 };
      state.watch[id] = { stage: 'prompt', token };
      await save(state);
    }
    const token = state.watch[id]?.token;
    const record = state.prompts[token];
    if (!record) return false;
    const source = await sourceAvailable(record);
    if (!source || !(await allowed(record.url))) { await dismiss(state, token); return false; }
    if (record.phase === 'installing' && !installations.has(token)) {
      if (record.attempts >= 2) { await dismiss(state, token); return false; }
      record.phase = 'waiting';
    }
    if (record.phase === 'shown' && !(await ping(record, token))) { await dismiss(state, token); return false; }
    if (record.phase === 'waiting' && source.url === record.url && !source.pendingUrl) {
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
    if (current?.url?.startsWith(api.runtime.getURL('duplicate.html')) || !(await eligible(current))) return false;
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    if (!validateSettings(settings).duplicatePromptEnabled) return false;
    const state = await load();
    state.watch[tab.id] = { stage: 'watching' };
    await save(state);
    return check(tab.id, state);
  });
  const updated = id => enqueue(async () => {
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

  async function context(message, sender) {
    authenticate(message, sender);
    const state = await load();
    const record = state.prompts[message.token];
    if (!record || record.source.id !== sender.tab.id || record.documentId !== sender.documentId
      || record.url !== sender.url || !(await sourceAvailable(record))) throw Error('网页已经变化，未操作其他标签。');
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    if (!validateSettings(settings).duplicatePromptEnabled || !(await allowed(record.url))) {
      throw Error('页内提醒已关闭或权限已撤销，请保留新标签。');
    }
    return { state, record };
  }

  async function chooseOnce(message, sender) {
    const { token } = message;
    const { state, record } = await context(message, sender);
    if (record.phase !== 'shown') throw Error('正在处理上一次选择，请处理 Chrome 的关闭提示。');
    const candidates = await matches(record.url, record.source.id, state);
    const target = candidates.find(tab => tab.id === record.targetId) || candidates[0];
    const existing = target && await targetAvailable(target.id, record.url);
    if (!existing || !(await ping(record, token))) throw Error('已有标签或当前网页已变化，可以保留新标签。');
    record.phase = 'switching';
    await save(state);
    try {
      if (!(await sourceAvailable(record)) || !(await targetAvailable(existing.id, record.url))
        || !(await ping(record, token))) throw Error('网页已经变化，已保留新标签。');
      await api.tabs.update(existing.id, { active: true });
      const focused = await targetAvailable(existing.id, record.url);
      if (!focused) throw Error('已有标签已变化，已保留新标签。');
      await api.windows.update(focused.windowId, { focused: true });
      record.phase = 'closing';
      await save(state);
      if (!(await targetAvailable(existing.id, record.url)) || !(await sourceAvailable(record))
        || !(await ping(record, token))) throw Error('网页已经变化，已保留新标签。');
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
      if (!['switch', 'keep'].includes(message.choice)) throw Error('选择无效。');
    } catch (error) { return Promise.reject(error); }
    if (message.choice === 'keep') return enqueue(async () => {
      const { state, record } = await context(message, sender);
      await dismiss(state, message.token);
      return { action: 'kept', releasedId: record.source.id };
    });
    const key = `${message.token}:${sender.documentId}`;
    if (choices.has(key)) return choices.get(key);
    const task = enqueue(() => chooseOnce(message, sender)).then(result => result.removal ? finishRemoval(result) : result);
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
  const permissionsChanged = () => enqueue(async () => {
    const state = await load();
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    const enabled = validateSettings(settings).duplicatePromptEnabled;
    const released = [];
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
