import { DEFAULT_SETTINGS, validateSettings, findRule, explainRule } from './rules.js';

export function createAutoGrouper(api, onError = console.warn, shouldSuppress = () => false) {
  let tail = Promise.resolve();
  let settingsVersion = 0;
  const pending = new Map();

  function enqueue(task) {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  }

  async function getTab(id) {
    try { return await api.tabs.get(id); } catch { return null; }
  }

  function eligible(tab) {
    return tab && Number.isInteger(tab.id) && Number.isInteger(tab.windowId)
      && !tab.pinned && !tab.incognito && !(Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0);
  }

  async function groupOne(tabId, token) {
    const revision = settingsVersion;
    const { settings: stored } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    const settings = validateSettings(stored);
    if (!settings.enabled || pending.get(tabId) !== token) return 'skipped';
    const tab = await getTab(tabId);
    if (!eligible(tab) || await shouldSuppress(tab)) return 'skipped';
    const rule = findRule(tab.url, settings.rules);
    if (!rule) return 'skipped';
    const window = await api.windows.get(tab.windowId);
    if (window.type !== 'normal') return 'skipped';
    const allGroups = await api.tabGroups.query({ windowId: tab.windowId });
    if (tab.groupId >= 0) {
      const currentGroup = allGroups.find(group => group.id === tab.groupId);
      if (!currentGroup || currentGroup.shared === true) return 'skipped';
    }
    const namedGroups = allGroups.filter(group => group.title === rule.group);
    const groups = namedGroups
      .filter(group => group.shared !== true)
      .sort((a, b) => (a.id === tab.groupId ? -1 : b.id === tab.groupId ? 1 : a.id - b.id));
    const target = groups[0];
    // A matching shared group is an explicit exception, never a reason to share a URL.
    if (!target && namedGroups.some(group => group.shared === true)) return 'skipped';

    // Chrome can move a tab across windows when grouping: refresh both sides first.
    const current = await getTab(tabId);
    if (!eligible(current) || await shouldSuppress(current) || pending.get(tabId) !== token || revision !== settingsVersion
      || current.windowId !== tab.windowId || current.url !== tab.url
      || current.groupId !== tab.groupId) return 'skipped';
    if (current.groupId >= 0) {
      let sourceGroup;
      try { sourceGroup = await api.tabGroups.get(current.groupId); } catch { return 'skipped'; }
      if (sourceGroup.shared === true || sourceGroup.windowId !== current.windowId) return 'skipped';
    }
    if (target) {
      let currentGroup;
      try { currentGroup = await api.tabGroups.get(target.id); } catch { return 'skipped'; }
      if (currentGroup.windowId !== tab.windowId || currentGroup.title !== rule.group || currentGroup.shared === true) {
        return 'skipped';
      }
    }
    if (pending.get(tabId) !== token || revision !== settingsVersion) return 'skipped';
    if (target && current.groupId === target.id) return 'unchanged';
    if (target) {
      await api.tabs.group({ groupId: target.id, tabIds: [tabId] });
    } else {
      const id = await api.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      // Finish naming even if a newer event arrived while the group was created.
      await api.tabGroups.update(id, { title: rule.group, color: rule.color });
    }
    return 'grouped';
  }

  function schedule(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve('skipped');
    const token = Symbol();
    pending.set(tabId, token);
    return enqueue(async () => {
      try { return await groupOne(tabId, token); }
      catch (error) {
        try { onError(error); } catch { /* Diagnostics cannot break the queue. */ }
        return 'failed';
      } finally {
        if (pending.get(tabId) === token) pending.delete(tabId);
      }
    });
  }

  function settingsChanged() {
    settingsVersion += 1;
    // Only retry work already in progress; saving rules never scans existing tabs.
    for (const id of [...pending.keys()]) void schedule(id);
  }

  async function applyWindow(windowId) {
    if (!Number.isInteger(windowId) || windowId < 0) throw new Error('无法确定当前窗口，请重试。');
    const { settings } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
    if (!validateSettings(settings).enabled) throw new Error('请先在规则设置中启用自动分组并保存。');
    const tabs = await api.tabs.query({ windowId });
    const results = await Promise.all(tabs.map(tab => schedule(tab.id)));
    return {
      grouped: results.filter(result => result === 'grouped').length,
      skipped: results.filter(result => ['skipped', 'unchanged'].includes(result)).length,
      failed: results.filter(result => result === 'failed').length,
    };
  }

  async function previewWindow({ windowId, rules: suppliedRules } = {}) {
    if (!Number.isInteger(windowId) || windowId < 0) throw new Error('无法确定当前窗口，请重试。');
    const window = await api.windows.get(windowId);
    if (window.type !== 'normal' || window.incognito) throw new Error('只能预览普通窗口。');
    let rules;
    let enabled = true;
    if (suppliedRules === undefined) {
      const { settings: stored } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
      const settings = validateSettings(stored);
      rules = settings.rules;
      enabled = settings.enabled;
    } else {
      rules = validateSettings({ enabled: true, duplicatePromptEnabled: true, rules: suppliedRules }).rules;
    }
    const tabs = await api.tabs.query({ windowId });
    const groups = await api.tabGroups.query({ windowId });
    const byId = new Map(groups.map(group => [group.id, group]));
    const results = [];
    let matched = 0;
    let excluded = 0;
    for (const tab of tabs) {
      let reason = null;
      let targetGroup = null;
      if (!enabled) reason = 'disabled';
      else if (!eligible(tab)) reason = 'ineligible';
      else if (await shouldSuppress(tab)) reason = 'paused';
      else if (tab.groupId >= 0 && (!byId.has(tab.groupId) || byId.get(tab.groupId).shared === true)) reason = 'protected-group';
      else {
        const explanation = explainRule(tab.url, rules);
        if (explanation.rule) {
          const named = groups.filter(group => group.title === explanation.rule.group);
          if (!named.some(group => group.shared !== true) && named.some(group => group.shared === true)) {
            reason = 'shared-target';
          } else {
            targetGroup = explanation.rule.group;
            reason = 'matched';
            matched += 1;
          }
        } else {
          reason = explanation.reason;
          if (reason === 'excluded') excluded += 1;
        }
      }
      results.push({ tabId: tab.id, title: tab.title || '', url: tab.url || '', targetGroup, reason });
    }
    return { results, matched, excluded, skipped: results.length - matched - excluded };
  }

  return { schedule, settingsChanged, applyWindow, previewWindow, invalidate: id => pending.delete(id) };
}

export function createReadingList(api, externalEnqueue = null) {
  let tail = Promise.resolve();
  const enqueue = externalEnqueue || (task => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  });
  return function update(message) {
    return enqueue(async () => {
      const { readingList = [] } = await api.storage.local.get({ readingList: [] });
      if (!Array.isArray(readingList)) throw new Error('稍后阅读清单格式无效。');
      let next;
      if (message.type === 'SAVE_READING_ITEM') {
        const input = message.item;
        let url;
        try { url = new URL(input?.url); } catch { throw new Error('无法保存这个链接。'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          throw new Error('仅支持保存不包含账号密码的 HTTP/HTTPS 网页。');
        }
        if (readingList.some(item => item.url === url.href)) return readingList;
        if (readingList.length >= 2000) {
          throw new Error('稍后阅读已达到 2000 条上限，请先移除一些条目。');
        }
        const title = typeof input.title === 'string' ? input.title : url.hostname;
        if (title.length > 300) throw new Error('稍后阅读标题超过 300 个字符。');
        next = [{ id: crypto.randomUUID(), url: url.href,
          title,
          savedAt: Date.now() }, ...readingList];
      } else if (message.type === 'REMOVE_READING_ITEM' && typeof message.id === 'string') {
        next = readingList.filter(item => item.id !== message.id);
      } else throw new Error('无法识别稍后阅读操作。');
      await api.storage.local.set({ readingList: next });
      return next;
    });
  };
}
