import { DEFAULT_SETTINGS, validateSettings } from './rules.js';

const WATCH_KEY = 'duplicateWatch';
const PROMPTS_KEY = 'duplicatePrompts';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const TOKEN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function http(value) {
  if (typeof value !== 'string') return null;
  try { return ['http:', 'https:'].includes(new URL(value).protocol) ? value : null; }
  catch { return null; }
}

function destination(tab) {
  return http(tab?.pendingUrl) || http(tab?.url);
}

function sameSource(tab, original, url) {
  return tab && destination(tab) === url && tab.windowId === original.windowId
    && (tab.groupId ?? -1) === (original.groupId ?? -1)
    && Boolean(tab.pinned) === Boolean(original.pinned);
}

export function createDuplicateGuard(api, { legacyOnly = false } = {}) {
  let tail = Promise.resolve();
  const choices = new Map();
  const page = api.runtime.getURL('duplicate.html');
  const pageUrl = token => `${page}#${token}`;
  const enqueue = task => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
  const getTab = async id => {
    try { return await api.tabs.get(id); } catch { return null; }
  };
  const loadWatch = async () => (await api.storage.session.get({ [WATCH_KEY]: {} }))[WATCH_KEY];
  const saveWatch = watch => api.storage.session.set({ [WATCH_KEY]: watch });
  const savePrompts = prompts => api.storage.local.set({ [PROMPTS_KEY]: prompts });

  async function loadPrompts() {
    const { duplicatePrompts = {} } = await api.storage.local.get({ duplicatePrompts: {} });
    const entries = Object.entries(duplicatePrompts);
    const prompts = Object.fromEntries(entries.filter(([token, record]) =>
      TOKEN.test(token) && http(record?.url) && Number.isFinite(record.createdAt)
      && Date.now() - record.createdAt < MAX_AGE));
    if (Object.keys(prompts).length !== entries.length) await savePrompts(prompts);
    return prompts;
  }

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

  async function matches(url, sourceId, watch) {
    const tabs = await api.tabs.query({ windowType: 'normal' });
    const result = [];
    for (const tab of tabs) {
      if (tab.id === sourceId || tab.url !== url || (tab.pendingUrl && tab.pendingUrl !== url)
        || watch[tab.id]?.stage === 'prompt') continue;
      if (await eligible(tab)) result.push(tab);
    }
    return result.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || a.id - b.id);
  }

  async function check(id, watch) {
    const entry = watch[id];
    if (!entry) return false;
    if (legacyOnly && entry.stage === 'watching') { delete watch[id]; await saveWatch(watch); return false; }
    const tab = await getTab(id);
    if (!tab) { delete watch[id]; await saveWatch(watch); return false; }
    if (entry.stage === 'prompt') {
      const expected = pageUrl(entry.token);
      if (tab.pendingUrl === expected || (tab.url === expected && !tab.pendingUrl)) return true;
      delete watch[id];
      await saveWatch(watch);
      return false;
    }
    if (entry.stage === 'opening') {
      if (http(tab.url)) {
        delete watch[id];
        const prompts = await loadPrompts();
        delete prompts[entry.token];
        await savePrompts(prompts);
        await saveWatch(watch);
      }
      return false;
    }
    const url = destination(tab);
    if (!url) return false;
    // Exactly one observed HTTP(S) destination is considered, including redirects.
    delete watch[id];
    await saveWatch(watch);
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    if (!validateSettings(settings).duplicatePromptEnabled || !(await eligible(tab))) return false;
    const targets = await matches(url, id, watch);
    if (targets.length === 0) return false;
    const token = crypto.randomUUID();
    const prompts = await loadPrompts();
    prompts[token] = { tabId: id, url, title: targets[0].title || url,
      targetId: targets[0].id, phase: 'prompt', createdAt: Date.now() };
    // Durable destination first: a restored choice page must still know its URL.
    await savePrompts(prompts);
    watch[id] = { stage: 'prompt', token };
    await saveWatch(watch);
    const current = await getTab(id);
    const target = await getTab(targets[0].id);
    if (!sameSource(current, tab, url) || !(await eligible(current)) || target?.url !== url
      || (target.pendingUrl && target.pendingUrl !== url) || !(await eligible(target))) {
      delete watch[id];
      delete prompts[token];
      await saveWatch(watch);
      await savePrompts(prompts);
      return false;
    }
    try { await api.tabs.update(id, { url: pageUrl(token) }); }
    catch (error) {
      const actual = await getTab(id);
      if (actual?.url === pageUrl(token) || actual?.pendingUrl === pageUrl(token)) return true;
      delete watch[id];
      await saveWatch(watch);
      throw error;
    }
    return true;
  }

  const created = tab => enqueue(async () => {
    const current = await getTab(tab.id);
    if (current?.url?.startsWith(`${page}#`)) return true;
    if (!(await eligible(current))) return false;
    const { settings = DEFAULT_SETTINGS } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    if (!validateSettings(settings).duplicatePromptEnabled) return false;
    const watch = await loadWatch();
    watch[tab.id] = { stage: 'watching' };
    await saveWatch(watch);
    return check(tab.id, watch);
  });

  const updated = id => enqueue(async () => {
    const watch = await loadWatch();
    return check(id, watch);
  });

  async function context(message, sender) {
    const { token, tabId } = message;
    if (!TOKEN.test(token) || !Number.isInteger(tabId) || sender.id !== api.runtime.id
      || sender.url !== pageUrl(token) || (sender.tab && sender.tab.id !== tabId)
      || (sender.frameId !== undefined && sender.frameId !== 0)) throw new Error('这个提醒的来源无效。');
    const tab = await getTab(tabId);
    if (tab?.url !== pageUrl(token) || (tab.pendingUrl && tab.pendingUrl !== pageUrl(token))
      || tab.incognito) throw new Error('当前标签已变化，请刷新检测后重试。');
    const prompts = await loadPrompts();
    const record = prompts[token];
    if (!record) throw new Error('这个提醒已失效，请返回看板或重新打开原链接。');
    if (record.tabId !== tabId) {
      const owner = await getTab(record.tabId);
      if (owner?.url === pageUrl(token) || owner?.pendingUrl === pageUrl(token)) {
        throw new Error('此提醒已在另一个标签页中打开，请使用原提醒页。');
      }
      record.tabId = tabId;
    }
    return { tab, record, prompts, watch: await loadWatch() };
  }

  const info = (message, sender) => enqueue(async () => {
    const { record, prompts, watch } = await context(message, sender);
    record.phase = 'prompt';
    watch[message.tabId] = { stage: 'prompt', token: message.token };
    await savePrompts(prompts);
    await saveWatch(watch);
    const tabs = await matches(record.url, message.tabId, watch);
    return { url: record.url, title: record.title,
      matches: tabs.map(tab => ({ id: tab.id, title: tab.title || record.url, windowId: tab.windowId })) };
  });

  async function chooseOnce(message, sender) {
    const { token, tabId, choice } = message;
    if (!['open', 'switch'].includes(choice)) throw new Error('请选择跳转已有标签，或继续打开新标签。');
    const { tab, record, prompts, watch } = await context(message, sender);
    if (record.phase !== 'prompt') throw new Error('上一次操作尚未完成，请刷新检测后重试。');
    if (choice === 'open') {
      record.phase = 'opening';
      watch[tabId] = { stage: 'opening', token };
      await savePrompts(prompts);
      await saveWatch(watch);
      try {
        const source = await getTab(tabId);
        if (source?.url !== pageUrl(token) || source.pendingUrl || source.windowId !== tab.windowId
          || !(await eligible(source))) {
          throw new Error('当前标签已变化，已保留你的页面，请返回提醒页后重试。');
        }
        await api.tabs.update(tabId, { url: record.url });
      }
      catch (error) {
        record.phase = 'prompt';
        watch[tabId] = { stage: 'prompt', token };
        await savePrompts(prompts);
        await saveWatch(watch);
        throw error;
      }
      return { action: 'opened' };
    }
    const candidates = await matches(record.url, tabId, watch);
    const target = candidates.find(item => item.id === record.targetId) || candidates[0];
    const currentTarget = target && await getTab(target.id);
    if (!currentTarget || currentTarget.url !== record.url || !(await eligible(currentTarget))
      || (currentTarget.pendingUrl && currentTarget.pendingUrl !== record.url)) {
      throw new Error('已有标签已经关闭或跳转，你仍可选择打开新标签。');
    }
    record.phase = 'switching';
    await savePrompts(prompts);
    try {
      await api.tabs.update(currentTarget.id, { active: true });
      const focusedTarget = await getTab(currentTarget.id);
      if (!focusedTarget || focusedTarget.url !== record.url || !(await eligible(focusedTarget))
        || (focusedTarget.pendingUrl && focusedTarget.pendingUrl !== record.url)) {
        throw new Error('已有标签在切换时发生变化，已保留提醒页。');
      }
      await api.windows.update(focusedTarget.windowId, { focused: true });
      const survivor = await getTab(currentTarget.id);
      const source = await getTab(tabId);
      if (!survivor || survivor.url !== record.url || !(await eligible(survivor))
        || (survivor.pendingUrl && survivor.pendingUrl !== record.url)) {
        throw new Error('已有标签在切换时发生变化，已保留提醒页。');
      }
      if (source?.url !== pageUrl(token) || source.pendingUrl || source.windowId !== tab.windowId
        || !(await eligible(source))) {
        record.phase = 'prompt';
        await savePrompts(prompts);
        return { action: 'switched', closed: false };
      }
      await api.tabs.remove(tabId);
      const closed = !(await getTab(tabId));
      if (closed) {
        delete prompts[token];
        delete watch[tabId];
        await savePrompts(prompts);
        await saveWatch(watch);
      } else {
        record.phase = 'prompt';
        await savePrompts(prompts);
      }
      return { action: 'switched', closed };
    } catch (error) {
      record.phase = 'prompt';
      await savePrompts(prompts);
      throw error;
    }
  }

  const choose = (message, sender) => {
    const key = message.token;
    if (choices.has(key)) return choices.get(key);
    const task = enqueue(() => chooseOnce(message, sender));
    choices.set(key, task);
    const clear = () => { if (choices.get(key) === task) choices.delete(key); };
    task.then(clear, clear);
    return task;
  };

  const removed = id => enqueue(async () => {
    const watch = await loadWatch();
    delete watch[id];
    await saveWatch(watch);
    // Keep unfinished local tokens for restored tabs; expired records are pruned lazily.
  });
  const replaced = (added, old) => enqueue(async () => {
    const watch = await loadWatch();
    if (watch[old]) { watch[added] = watch[old]; delete watch[old]; await saveWatch(watch); }
    return check(added, watch);
  });
  return { created, updated, removed, replaced, info, choose };
}
