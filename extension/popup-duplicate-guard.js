import { DEFAULT_SETTINGS, validateSettings } from './rules.js';
import { createDuplicateGuard } from './duplicate-guard.js';

const STATE_KEY = 'duplicatePopupState';
const TOKEN = /^popup-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function http(value) {
  if (typeof value !== 'string') return null;
  try { return ['http:', 'https:'].includes(new URL(value).protocol) ? value : null; }
  catch { return null; }
}

const destination = tab => tab?.pendingUrl ? http(tab.pendingUrl) : http(tab?.url);

export function createPopupDuplicateGuard(api, { legacyOnly = false } = {}) {
  const legacy = createDuplicateGuard(api, { legacyOnly });
  const page = api.runtime.getURL('duplicate.html');
  const pageUrl = token => `${page}#${token}`;
  let tail = Promise.resolve();
  const choices = new Map();
  const enqueue = task => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
  const getTab = async id => {
    try { return await api.tabs.get(id); } catch { return null; }
  };
  const load = async () => (await api.storage.session.get({ [STATE_KEY]: { watch: {}, prompts: {} } }))[STATE_KEY];
  const save = state => api.storage.session.set({ [STATE_KEY]: state });

  async function eligible(tab) {
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0 || tab.incognito || tab.pinned
      || (Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0)) return false;
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
    const source = await getTab(record.source.id);
    return source && destination(source) === record.url && source.windowId === record.source.windowId
      && (source.groupId ?? -1) === record.source.groupId && await eligible(source) ? source : null;
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

  async function validPopup(record, token) {
    const tab = await getTab(record.popupTabId);
    if (tab?.url !== pageUrl(token) || tab.pendingUrl || tab.windowId !== record.popupWindowId
      || tab.incognito || tab.pinned || (tab.splitViewId >= 0)) return null;
    try {
      const window = await api.windows.get(tab.windowId);
      return window.type === 'popup' && !window.incognito ? tab : null;
    } catch { return null; }
  }

  async function closePopup(record, token) {
    if (!(await validPopup(record, token))) return false;
    try { await api.tabs.remove(record.popupTabId); }
    catch { return false; }
    return !(await getTab(record.popupTabId));
  }

  function forget(state, token) {
    const record = state.prompts[token];
    if (record && state.watch[record.source.id]?.token === token) delete state.watch[record.source.id];
    delete state.prompts[token];
  }

  async function dismiss(state, token) {
    const record = state.prompts[token];
    forget(state, token);
    await save(state);
    if (record) await closePopup(record, token);
  }

  async function stableTarget(id, url) {
    const tab = await getTab(id);
    return tab?.url === url && (!tab.pendingUrl || tab.pendingUrl === url) && await eligible(tab) ? tab : null;
  }

  async function check(id, state) {
    const entry = state.watch[id];
    if (!entry) return false;
    if (legacyOnly && entry.stage === 'watching') { delete state.watch[id]; await save(state); return false; }
    if (entry.stage === 'prompt') {
      const record = state.prompts[entry.token];
      if (record && await sourceAvailable(record)) return true;
      if (record) await dismiss(state, entry.token);
      else { delete state.watch[id]; await save(state); }
      return false;
    }
    const tab = await getTab(id);
    if (!tab) { delete state.watch[id]; await save(state); return false; }
    const url = destination(tab);
    if (!url) return false;
    delete state.watch[id];
    await save(state);
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    if (!validateSettings(settings).duplicatePromptEnabled || !(await eligible(tab))) return false;
    const targets = await matches(url, id, state);
    if (!targets.length) return false;
    const token = `popup-${crypto.randomUUID()}`;
    const record = { source: { id, windowId: tab.windowId, groupId: tab.groupId ?? -1 },
      url, title: targets[0].title || url, targetId: targets[0].id, phase: 'creating',
      popupTabId: null, popupWindowId: null };
    state.prompts[token] = record;
    state.watch[id] = { stage: 'prompt', token };
    await save(state);
    if (!(await sourceAvailable(record)) || !(await stableTarget(record.targetId, url))) {
      await dismiss(state, token);
      return false;
    }
    try {
      const popup = await api.windows.create({ url: pageUrl(token), type: 'popup',
        width: 480, height: 440, focused: true });
      if (!Number.isInteger(popup?.id)) throw new Error('浏览器没有返回提醒窗口。');
      record.popupWindowId = popup.id;
      const tabs = popup.tabs || await api.tabs.query({ windowId: popup.id });
      const prompt = tabs.find(item => item.url === pageUrl(token) || item.pendingUrl === pageUrl(token));
      if (!Number.isInteger(prompt?.id)) throw new Error('无法确定提醒窗口中的页面。');
      record.popupTabId = prompt.id;
      record.phase = 'prompt';
      await save(state);
      if (!(await sourceAvailable(record))) {
        await dismiss(state, token);
        return false;
      }
      return true;
    } catch (error) {
      await dismiss(state, token);
      throw error;
    }
  }

  const created = tab => enqueue(async () => {
    const current = await getTab(tab.id);
    if (current?.url?.startsWith(`${page}#`) || !(await eligible(current))) return false;
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    if (!validateSettings(settings).duplicatePromptEnabled) return false;
    const state = await load();
    state.watch[tab.id] = { stage: 'watching' };
    await save(state);
    return check(tab.id, state);
  });
  const updated = id => enqueue(async () => {
    const legacySuppressed = await legacy.updated(id);
    const state = await load();
    const releasedIds = [];
    for (const [token, record] of Object.entries(state.prompts)) {
      if (record.popupTabId === id && !(await validPopup(record, token))) {
        releasedIds.push(record.source.id);
        forget(state, token);
      }
    }
    if (releasedIds.length) {
      await save(state);
      return { suppressed: legacySuppressed, releasedIds };
    }
    return await check(id, state) || legacySuppressed;
  });

  function authenticate(message, sender) {
    if (!TOKEN.test(message.token) || !Number.isInteger(message.tabId) || sender.id !== api.runtime.id
      || sender.url !== pageUrl(message.token) || (sender.tab && sender.tab.id !== message.tabId)
      || (sender.frameId !== undefined && sender.frameId !== 0)) throw new Error('这个提醒的来源无效。');
  }

  async function context(message, sender) {
    authenticate(message, sender);
    const state = await load();
    const record = state.prompts[message.token];
    if (!record) throw new Error('提醒已失效，原网页保持不变。请关闭这个窗口。');
    // A worker can stop after Chrome created the popup but before its IDs were
    // persisted. The token and session source lease allow this one-time binding.
    if (record.phase === 'creating' && record.popupTabId === null) {
      const caller = await getTab(message.tabId);
      if (caller?.url === pageUrl(message.token) && !caller.pendingUrl && !caller.incognito
        && (record.popupWindowId === null || record.popupWindowId === caller.windowId)) {
        const window = await api.windows.get(caller.windowId);
        if (window.type === 'popup' && !window.incognito) {
          record.popupTabId = caller.id;
          record.popupWindowId = caller.windowId;
          record.phase = 'prompt';
          await save(state);
        }
      }
    }
    if (record.popupTabId !== message.tabId || !(await validPopup(record, message.token))) {
      throw new Error('提醒窗口已变化，请关闭这个窗口。');
    }
    return { state, record };
  }

  const info = (message, sender) => {
    if (!String(message.token).startsWith('popup-')) return legacy.info(message, sender).then(result => ({ ...result, presentation: 'page' }));
    return enqueue(async () => {
      const { state, record } = await context(message, sender);
      const busy = record.phase === 'closing';
      if (!busy) record.phase = 'prompt';
      await save(state);
      const tabs = await matches(record.url, record.source.id, state);
      return { presentation: 'popup', busy, sourceAvailable: Boolean(await sourceAvailable(record)),
        url: record.url, title: record.title,
        matches: tabs.map(tab => ({ id: tab.id, title: tab.title || record.url, windowId: tab.windowId })) };
    });
  };

  async function chooseOnce(message, sender) {
    const { token, choice } = message;
    if (!['open', 'switch'].includes(choice)) throw new Error('请选择跳转已有标签，或保留新标签。');
    const { state, record } = await context(message, sender);
    if (record.phase !== 'prompt') throw new Error('上一次操作尚未完成，请重新检测。');
    if (!(await sourceAvailable(record))) throw new Error('原标签已经变化，已保留当前网页。请关闭提醒。');
    record.phase = choice === 'open' ? 'opening' : 'switching';
    await save(state);
    try {
      if (choice === 'open') {
        const source = await sourceAvailable(record);
        if (!source || !(await validPopup(record, token))) throw new Error('原标签或提醒窗口已经变化，已保留网页。');
        await api.tabs.update(source.id, { active: true });
        const current = await sourceAvailable(record);
        if (!current) throw new Error('原标签已经变化，已保留当前网页。');
        await api.windows.update(current.windowId, { focused: true });
        forget(state, token);
        await save(state);
        const popupClosed = await closePopup(record, token);
        return { action: 'opened', popupClosed, releasedId: current.id };
      }
      const candidates = await matches(record.url, record.source.id, state);
      const target = candidates.find(item => item.id === record.targetId) || candidates[0];
      const existing = target && await stableTarget(target.id, record.url);
      if (!existing) throw new Error('已有标签已经关闭或跳转，你仍可保留新标签。');
      await api.tabs.update(existing.id, { active: true });
      const focused = await stableTarget(existing.id, record.url);
      if (!focused) throw new Error('已有标签在切换时发生变化，已保留新标签。');
      await api.windows.update(focused.windowId, { focused: true });
      if (!(await stableTarget(existing.id, record.url)) || !(await validPopup(record, token))
        || !(await sourceAvailable(record))) throw new Error('标签或提醒窗口已经变化，已保留新标签。');
      record.phase = 'closing';
      await save(state);
      if (!(await stableTarget(existing.id, record.url)) || !(await validPopup(record, token))
        || !(await sourceAvailable(record))) throw new Error('标签或提醒窗口已经变化，已保留新标签。');
      // The actual webpage may wait for Chrome's beforeunload UI. Do not hold
      // the observation queue while it waits; record closing before issuing once.
      const removal = api.tabs.remove(record.source.id).then(() => null, error => error);
      return { removal, token, sourceId: record.source.id };
    } catch (error) {
      record.phase = 'prompt';
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
        if (record) { record.phase = 'prompt'; await save(state); }
        if (error) throw error;
        return { action: 'switched', closed: false, popupClosed: false };
      }
      let popupClosed = !record;
      if (record) {
        forget(state, operation.token);
        await save(state);
        popupClosed = await closePopup(record, operation.token);
      }
      return { action: 'switched', closed: true, popupClosed };
    });
  }

  const choose = (message, sender) => {
    if (!String(message.token).startsWith('popup-')) return legacy.choose(message, sender);
    try { authenticate(message, sender); } catch (error) { return Promise.reject(error); }
    const key = `${message.token}:${message.tabId}`;
    if (choices.has(key)) return choices.get(key);
    const task = enqueue(() => chooseOnce(message, sender)).then(result =>
      result.removal ? finishRemoval(result) : result);
    choices.set(key, task);
    const clear = () => { if (choices.get(key) === task) choices.delete(key); };
    task.then(clear, clear);
    return task;
  };

  const removed = id => enqueue(async () => {
    await legacy.removed(id);
    const state = await load();
    const released = [];
    for (const [token, record] of Object.entries(state.prompts)) {
      if (record.popupTabId === id) { released.push(record.source.id); forget(state, token); }
      else if (record.source.id === id) { forget(state, token); await closePopup(record, token); }
    }
    delete state.watch[id];
    await save(state);
    return released;
  });

  const replaced = (added, old) => enqueue(async () => {
    const legacySuppressed = await legacy.replaced(added, old);
    const state = await load();
    if (state.watch[old]) {
      state.watch[added] = state.watch[old];
      delete state.watch[old];
      const record = state.prompts[state.watch[added].token];
      if (record) record.source.id = added;
    }
    for (const record of Object.values(state.prompts)) {
      if (record.popupTabId === old) record.popupTabId = added;
    }
    await save(state);
    return await check(added, state) || legacySuppressed;
  });
  return { created, updated, removed, replaced, info, choose };
}
