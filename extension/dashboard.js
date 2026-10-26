import { DEFAULT_SETTINGS, validateSettings } from './rules.js';
import { canonicalUrl, normalizeDedupRules } from './url-identity.js';
import { buildSearchEntries, searchEntries } from './search.js';

const SETTINGS_KEY = 'settings';
const READING_LIST_KEY = 'readingList';

const refreshButton = document.querySelector('#refresh-tabs');
const deduplicateButton = document.querySelector('#deduplicate-tabs');
const applyButton = document.querySelector('#apply-current-window');
const searchInput = document.querySelector('#tab-search');
const siteGrid = document.querySelector('#site-grid');
const siteTemplate = document.querySelector('#site-template');
const loadingState = document.querySelector('#tabs-loading');
const emptyState = document.querySelector('#tabs-empty');
const emptyTitle = document.querySelector('#tabs-empty-title');
const emptyCopy = document.querySelector('#tabs-empty-copy');
const tabCount = document.querySelector('#tab-count');
const siteCount = document.querySelector('#site-count');
const duplicateCount = document.querySelector('#duplicate-count');
const ruleCount = document.querySelector('#rule-count');
const automationState = document.querySelector('#automation-state');
const organizeHint = document.querySelector('#organize-hint');
const lastUpdated = document.querySelector('#last-updated');
const readingListElement = document.querySelector('#reading-list');
const readingEmpty = document.querySelector('#reading-empty');
const readingCount = document.querySelector('#reading-count');
const statusBox = document.querySelector('#status');

let dedupRules = [];
let allTabs = [];
let allGroups = [];
let workspaces = [];
let recentTabs = {};
let allowlist = [];
let readingList = [];
let settings = cloneDefaultSettings();
let refreshing = false;
let organizing = false;
let deduplicating = false;
let tabsLoaded = false;
const pendingReadingUrls = new Set();
const pendingReadingIds = new Set();

function cloneDefaultSettings() {
  return { enabled: DEFAULT_SETTINGS.enabled, rules: [] };
}

function parseHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function safeTitle(value, fallback = '无标题页面') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function displayUrl(value) {
  const url = parseHttpUrl(value);
  if (!url) return '';
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.hostname}${path}`;
}

function setStatus(message, kind = 'info') {
  statusBox.textContent = message;
  statusBox.dataset.kind = kind;
  statusBox.hidden = !message;
  statusBox.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

function sanitizeReadingList(value) {
  if (!Array.isArray(value)) return [];
  const seenUrls = new Set();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const url = parseHttpUrl(item.url);
    if (!url || typeof item.id !== 'string' || !item.id || seenUrls.has(url.href)) return [];
    seenUrls.add(url.href);
    return [{
      id: item.id,
      url: url.href,
      title: safeTitle(item.title, url.hostname),
      savedAt: item.savedAt,
    }];
  });
}

function normalizeTab(tab) {
  const url = parseHttpUrl(tab.url);
  if (!url || tab.incognito || typeof tab.id !== 'number' || typeof tab.windowId !== 'number') return null;
  return {
    ...tab,
    id: tab.id,
    windowId: tab.windowId,
    url: url.href,
    title: safeTitle(tab.title, url.hostname),
    hostname: url.hostname,
  };
}

function groupVisibleTabs(query) {
  const needle = query.trim().toLocaleLowerCase();
  const urls = new Map();

  for (const tab of allTabs) {
    const mode = document.querySelector('#view-mode').value;
    const group = allGroups.find(group => group.id === tab.groupId);
    const bucket = mode === 'window' ? `窗口 ${tab.windowId}` : mode === 'group'
      ? `窗口 ${tab.windowId} / ${group?.title || '未分组'}` : tab.hostname;
    const key = `${bucket}\n${canonicalUrl(tab.url, dedupRules)}`;
    let entry = urls.get(key);
    if (!entry) {
      entry = { url: tab.url, hostname: bucket, tabs: [] };
      urls.set(key, entry);
    }
    entry.tabs.push(tab);
  }

  const sites = new Map();
  for (const entry of urls.values()) {
    const matches = !needle
      || entry.url.toLocaleLowerCase().includes(needle)
      || entry.tabs.some((tab) => tab.title.toLocaleLowerCase().includes(needle) || tab.url.toLocaleLowerCase().includes(needle));
    if (!matches) continue;

    let site = sites.get(entry.hostname);
    if (!site) {
      site = { hostname: entry.hostname, entries: [], tabTotal: 0 };
      sites.set(entry.hostname, site);
    }
    site.entries.push(entry);
    site.tabTotal += entry.tabs.length;
  }

  return [...sites.values()]
    .map((site) => ({
      ...site,
      entries: site.entries.sort((a, b) => {
        const titleA = a.tabs[0]?.title ?? '';
        const titleB = b.tabs[0]?.title ?? '';
        return titleA.localeCompare(titleB, 'zh-CN');
      }),
    }))
    .sort((a, b) => b.tabTotal - a.tabTotal || a.hostname.localeCompare(b.hostname));
}

function createButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function renderTabs() {
  const query = searchInput.value;
  if (query.trim() || document.querySelector('#search-source').value !== 'all') return renderUnifiedSearch();
  const sites = groupVisibleTabs(query);
  siteGrid.replaceChildren();
  loadingState.hidden = true;

  if (sites.length === 0) {
    emptyState.hidden = false;
    if (query.trim()) {
      emptyTitle.textContent = '没有匹配的标签页';
      emptyCopy.textContent = '试试搜索其他标题、域名或网址内容。';
    } else {
      emptyTitle.textContent = '没有可显示的网页标签';
      emptyCopy.textContent = '打开一个 HTTP(S) 页面后，再刷新列表。';
    }
    return;
  }

  emptyState.hidden = true;
  const savedUrls = new Set(readingList.map((item) => item.url));

  for (const site of sites) {
    const fragment = siteTemplate.content.cloneNode(true);
    const siteMark = fragment.querySelector('.site-mark');
    const siteName = fragment.querySelector('.site-name');
    const siteSummary = fragment.querySelector('.site-summary');
    const tabList = fragment.querySelector('.tab-list');

    siteMark.textContent = site.hostname.slice(0, 1) || '?';
    siteName.textContent = site.hostname;
    siteSummary.textContent = `${site.tabTotal} 个标签 · ${site.entries.length} 个不同网址`;

    for (const entry of site.entries) {
      const representative = entry.tabs[0];
      const row = document.createElement('li');
      row.className = 'tab-row';

      const copy = document.createElement('div');
      copy.className = 'tab-copy';
      const titleButton = createButton(
        representative.title,
        'tab-title',
        () => focusTab(representative),
      );
      titleButton.setAttribute('aria-label', `切换到标签页：${representative.title}`);
      titleButton.dataset.searchKey = `tab:${representative.id}`;
      const urlLine = document.createElement('p');
      urlLine.className = 'tab-url';
      urlLine.textContent = displayUrl(entry.url);
      const flags = [representative.pinned ? '固定' : '', representative.audible ? '发声' : '', representative.discarded ? '休眠' : ''].filter(Boolean);
      const group = allGroups.find(group => group.id === representative.groupId);
      urlLine.textContent += ` · 窗口 ${representative.windowId}${group?.title ? ` / ${group.title}` : ''}${flags.length ? ` · ${flags.join('、')}` : ''}`;
      copy.append(titleButton, urlLine);

      const actions = document.createElement('div');
      actions.className = 'tab-actions';
      if (entry.tabs.length > 1) {
        const badge = document.createElement('span');
        badge.className = 'duplicate-badge';
        badge.textContent = `${allowlist.includes(new URL(entry.url).origin) ? '允许重复 ' : ''}×${entry.tabs.length}`;
        badge.setAttribute('aria-label', `${entry.tabs.length} 个符合当前去重规则的网址`);
        actions.append(badge);
      }

      const isSaved = savedUrls.has(entry.url);
      const saveButton = createButton(
        isSaved ? '已保存' : '稍后读',
        'save-reading-button',
        () => saveReadingItem(entry.url, representative.title),
      );
      saveButton.dataset.saved = String(isSaved);
      saveButton.disabled = isSaved || pendingReadingUrls.has(entry.url);
      actions.append(saveButton);
      row.append(copy, actions);
      tabList.append(row);
    }

    siteGrid.append(fragment);
  }
}

function renderReadingList() {
  readingListElement.replaceChildren();
  readingCount.textContent = String(readingList.length);
  readingEmpty.hidden = readingList.length > 0;

  for (const item of readingList) {
    const row = document.createElement('li');
    row.className = 'reading-item';

    const copy = document.createElement('div');
    copy.className = 'reading-copy';
    const title = document.createElement('p');
    title.className = 'reading-title';
    title.textContent = item.title;
    const url = document.createElement('p');
    url.className = 'reading-url';
    url.textContent = displayUrl(item.url);
    copy.append(title, url);

    const actions = document.createElement('div');
    actions.className = 'reading-actions';
    const openButton = createButton('打开', 'reading-open-button', () => openReadingItem(item));
    const removeButton = createButton('移除', 'reading-remove-button', () => removeReadingItem(item.id));
    removeButton.disabled = pendingReadingIds.has(item.id);
    actions.append(openButton, removeButton);

    row.append(copy, actions);
    readingListElement.append(row);
  }

  renderTabs();
}

function countExtraDuplicates() {
  const urlCounts = new Map();
  allTabs.forEach((tab) => { const key = allowlist.includes(new URL(tab.url).origin) ? null : canonicalUrl(tab.url, dedupRules); if (key) urlCounts.set(key, (urlCounts.get(key) ?? 0) + 1); });
  return [...urlCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function updateActionStates() {
  const busy = refreshing || organizing || deduplicating;
  const duplicates = countExtraDuplicates();
  refreshButton.disabled = busy;
  deduplicateButton.disabled = busy || !tabsLoaded || duplicates === 0;
  applyButton.disabled = busy || !tabsLoaded || !settings.enabled;
  deduplicateButton.title = duplicates === 0 && tabsLoaded
    ? '当前没有符合当前去重规则的重复标签页'
    : '跨普通窗口关闭符合当前去重规则的重复标签页';
  applyButton.title = settings.enabled ? '' : '请先在分组设置中启用自动分组';
}

function updateStats() {
  const hosts = new Set(allTabs.map((tab) => tab.hostname));
  const extraDuplicates = countExtraDuplicates();
  const enabledRules = settings.rules.filter((rule) => rule.enabled).length;

  tabCount.textContent = String(allTabs.length);
  siteCount.textContent = String(hosts.size);
  duplicateCount.textContent = String(extraDuplicates);
  ruleCount.textContent = String(enabledRules);
  automationState.textContent = settings.enabled ? '自动分组已启用' : '自动分组已暂停';
  automationState.dataset.enabled = String(settings.enabled);
  organizeHint.hidden = settings.enabled;
  updateActionStates();
}

async function refreshTabs({ announce = true, internal = false } = {}) {
  if (refreshing || (!internal && (organizing || deduplicating))) return false;
  refreshing = true;
  const focusedKey = siteGrid.contains(document.activeElement) ? document.activeElement.dataset.searchKey : null;
  updateActionStates();
  refreshButton.textContent = '刷新中…';
  if (!tabsLoaded) { loadingState.hidden = false; emptyState.hidden = true; siteGrid.replaceChildren(); }

  try {
    const [tabs, groups, stored, session] = await Promise.all([
      chrome.tabs.query({ windowType: 'normal' }), chrome.tabGroups.query({}),
      chrome.storage.local.get({ library: { workspaces: [] }, duplicateAllowlist: [] }),
      chrome.storage.session.get({ recentTabs: {} }),
    ]);
    allGroups = groups;
    workspaces = stored.library?.workspaces || [];
    allowlist = stored.duplicateAllowlist || [];
    recentTabs = session.recentTabs || {};
    allTabs = tabs.map(normalizeTab).filter(Boolean);
    tabsLoaded = true;
    updateStats();
    renderTabs();
    if (focusedKey && document.activeElement === document.body) [...siteGrid.querySelectorAll('[data-search-key]')].find(button => button.dataset.searchKey === focusedKey)?.focus();
    lastUpdated.textContent = `最近刷新：${new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date())}`;
    if (announce) setStatus(`已读取 ${allTabs.length} 个网页标签。`, 'success');
    return true;
  } catch (error) {
    tabsLoaded = true;
    loadingState.hidden = true;
    emptyState.hidden = false;
    emptyTitle.textContent = '无法读取标签页';
    emptyCopy.textContent = '请检查扩展权限后再试。';
    setStatus(`刷新失败：${error.message}`, 'error');
    return false;
  } finally {
    refreshing = false;
    refreshButton.textContent = '刷新列表';
    updateActionStates();
  }
}

function renderUnifiedSearch() {
  loadingState.hidden = true;
  const results = searchEntries(buildSearchEntries(allTabs, allGroups, { readingList, library: { workspaces } }, recentTabs),
    searchInput.value, document.querySelector('#search-source').value, 200);
  siteGrid.replaceChildren(); emptyState.hidden = Boolean(results.length);
  emptyTitle.textContent = '没有匹配结果'; emptyCopy.textContent = '试试页面标题、网址或工作区名称。';
  const list = document.createElement('ul'); list.className = 'unified-results';
  for (const entry of results) {
    const row = document.createElement('li');
    const button = createButton('', 'search-result', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({ type: 'SEARCH_ACTIVATE', key: entry.key, url: entry.url });
        if (!result?.ok) throw Error(result?.error || '页面未打开');
      } catch (error) { setStatus(error.message, 'error'); }
      finally { button.disabled = false; }
    });
    button.dataset.searchKey = entry.key;
    const title = document.createElement('strong'); title.textContent = entry.title;
    const context = document.createElement('span'); context.textContent = `${entry.type === 'tab' ? '已打开' : '已保存'} · ${entry.context}`;
    const url = document.createElement('span'); url.textContent = displayUrl(entry.url);
    button.append(title, context, url); row.append(button); list.append(row);
  }
  siteGrid.append(list);
  if (results.length === 200) { const hint = document.createElement('p'); hint.className = 'small muted'; hint.textContent = '显示前 200 项，请继续输入以缩小范围。'; siteGrid.append(hint); }
}

async function focusTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    setStatus(`无法定位标签页：${error.message}。列表可能已过期，请刷新后重试。`, 'error');
  }
}

async function saveReadingItem(url, title) {
  if (!parseHttpUrl(url) || pendingReadingUrls.has(url)) return;
  pendingReadingUrls.add(url);
  renderTabs();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_READING_ITEM',
      item: { url, title },
    });
    if (!response?.ok) throw new Error(response?.error || '后台未返回成功结果');
    readingList = sanitizeReadingList(response.readingList);
    renderReadingList();
    setStatus('链接已加入稍后读，原标签页保持打开。', 'success');
  } catch (error) {
    setStatus(`保存稍后读失败：${error.message}`, 'error');
  } finally {
    pendingReadingUrls.delete(url);
    renderTabs();
  }
}

async function removeReadingItem(id) {
  if (pendingReadingIds.has(id)) return;
  pendingReadingIds.add(id);
  renderReadingList();

  try {
    const response = await chrome.runtime.sendMessage({ type: 'REMOVE_READING_ITEM', id });
    if (!response?.ok) throw new Error(response?.error || '后台未返回成功结果');
    readingList = sanitizeReadingList(response.readingList);
    renderReadingList();
    setStatus('已从稍后读移除。', 'success');
  } catch (error) {
    setStatus(`移除失败：${error.message}`, 'error');
  } finally {
    pendingReadingIds.delete(id);
    renderReadingList();
  }
}

async function openReadingItem(item) {
  const url = parseHttpUrl(item.url);
  if (!url) {
    setStatus('这个稍后读链接不是有效的 HTTP(S) 地址。', 'error');
    return;
  }

  try {
    await chrome.tabs.create({ url: url.href });
  } catch (error) {
    setStatus(`打开链接失败：${error.message}`, 'error');
  }
}

async function applyCurrentWindow() {
  if (organizing || refreshing || deduplicating) return;
  if (!settings.enabled) {
    setStatus('自动分组已关闭，请先在分组设置中启用。', 'warning');
    return;
  }

  organizing = true;
  updateActionStates();
  applyButton.textContent = '整理中…';
  setStatus('正在按规则整理当前窗口…', 'info');

  try {
    const currentTab = await chrome.tabs.getCurrent();
    if (!currentTab || typeof currentTab.windowId !== 'number') {
      throw new Error('无法确定看板所在的窗口');
    }
    const response = await chrome.runtime.sendMessage({
      type: 'APPLY_CURRENT_WINDOW',
      windowId: currentTab.windowId,
    });
    if (!response?.ok) throw new Error(response?.error || '后台未返回成功结果');

    const grouped = Number(response.grouped) || 0;
    const skipped = Number(response.skipped) || 0;
    const failed = Number(response.failed) || 0;
    setStatus(
      `当前窗口已整理 ${grouped} 个，跳过 ${skipped} 个，失败 ${failed} 个。`,
      failed > 0 ? 'warning' : 'success',
    );
    await refreshTabs({ announce: false, internal: true });
  } catch (error) {
    setStatus(`整理当前窗口失败：${error.message}`, 'error');
  } finally {
    organizing = false;
    applyButton.textContent = '按规则整理当前窗口';
    updateStats();
  }
}

function deduplicationResult(response, refreshed) {
  const closed = Math.max(0, Number(response.closed) || 0);
  const skipped = Math.max(0, Number(response.skipped) || 0);
  const failed = Math.max(0, Number(response.failed) || 0);
  const remaining = Math.max(0, Number(response.remaining) || 0);
  const refreshSuffix = (refreshed ? '' : ' 看板刷新失败，请手动刷新列表。')
    + (typeof response.warning === 'string' && response.warning ? ` 提醒：${response.warning}` : '');

  if (failed === 0 && remaining === 0) {
    const skippedText = skipped > 0 ? `，跳过 ${skipped} 个` : '';
    const message = closed > 0
      ? `一键去重完成：已关闭 ${closed} 个重复标签${skippedText}。${refreshSuffix}`
      : `当前没有需要关闭的重复标签。${refreshSuffix}`;
    return { message, kind: refreshed && !response.warning ? 'success' : 'warning' };
  }

  const remainingText = remaining > 0
    ? `仍有 ${remaining} 个额外重复标签因保护或状态变化保留`
    : '当前没有额外重复标签';
  return {
    message: `一键去重完成：已关闭 ${closed} 个，跳过 ${skipped} 个，失败 ${failed} 个；${remainingText}。${refreshSuffix}`,
    kind: 'warning',
  };
}

async function deduplicateTabs() {
  if (deduplicating || refreshing || organizing) return;
  if (!tabsLoaded || countExtraDuplicates() === 0) {
    setStatus('当前没有符合已保存去重规则的重复标签页。', 'success');
    return;
  }

  deduplicating = true;
  updateActionStates();
  deduplicateButton.textContent = '去重中…';
  setStatus('正在按已保存的规则跨普通窗口清理重复标签…', 'info');
  const waitingNotice = setTimeout(() => {
    setStatus('正在等待 Chrome 完成关闭；若有页面的“离开网站”提示，请先在 Chrome 中处理。不会重复发送关闭请求。', 'info');
  }, 5000);

  try {
    const response = await chrome.runtime.sendMessage({ type: 'DEDUPLICATE_TABS' });
    if (!response?.ok) throw new Error(response?.error || '后台未返回成功结果');
    const refreshed = await refreshTabs({ announce: false, internal: true });
    const result = deduplicationResult(response, refreshed);
    setStatus(result.message, result.kind);
  } catch (error) {
    const refreshed = await refreshTabs({ announce: false, internal: true });
    const listStatus = refreshed ? '列表已刷新，请以列表为准' : '列表刷新失败，请手动刷新查看';
    setStatus(`一键去重未完成：${error.message}。${listStatus}，不会自动重试。`, 'error');
  } finally {
    clearTimeout(waitingNotice);
    deduplicating = false;
    deduplicateButton.textContent = '一键清理重复页';
    updateStats();
  }
}

async function initialize() {
  try {
    const stored = await chrome.storage.local.get([SETTINGS_KEY, READING_LIST_KEY, 'library']);
    try {
      settings = validateSettings(stored[SETTINGS_KEY] ?? cloneDefaultSettings());
    } catch (error) {
      settings = cloneDefaultSettings();
      setStatus(`已保存的分组设置无效：${error.message}`, 'warning');
    }
    dedupRules = normalizeDedupRules(stored.library?.dedupRules || []);
    readingList = sanitizeReadingList(stored[READING_LIST_KEY]);
    renderReadingList();
    updateStats();
  } catch (error) {
    setStatus(`读取本地设置失败：${error.message}`, 'error');
  }

  await refreshTabs({ announce: false });
}

refreshButton.addEventListener('click', () => refreshTabs());
deduplicateButton.addEventListener('click', deduplicateTabs);
applyButton.addEventListener('click', applyCurrentWindow);
searchInput.addEventListener('input', renderTabs);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.duplicateAllowlist) { allowlist = changes.duplicateAllowlist.newValue || []; updateStats(); renderTabs(); }
  if (changes.library) {
    try { workspaces = changes.library.newValue?.workspaces || []; dedupRules = normalizeDedupRules(changes.library.newValue?.dedupRules || []); updateStats(); renderTabs(); }
    catch (error) { setStatus(`去重规则无效：${error.message}`, 'error'); }
  }

  if (changes[SETTINGS_KEY]) {
    try {
      settings = validateSettings(changes[SETTINGS_KEY].newValue ?? cloneDefaultSettings());
      updateStats();
    } catch (error) {
      setStatus(`同步到的分组设置无效：${error.message}`, 'error');
    }
  }

  if (changes[READING_LIST_KEY]) {
    readingList = sanitizeReadingList(changes[READING_LIST_KEY].newValue);
    renderReadingList();
  }
});

initialize();
const initialQuery = new URL(location.href).searchParams;
if (initialQuery.has('q')) searchInput.value = initialQuery.get('q').slice(0, 300);
if (initialQuery.has('q') || initialQuery.has('search')) searchInput.focus();

document.querySelector('#view-mode').addEventListener('change', renderTabs);
document.querySelector('#search-source').addEventListener('change', renderTabs);
searchInput.addEventListener('keydown', event => {
  if (!['ArrowDown', 'Enter'].includes(event.key)) return;
  const first = siteGrid.querySelector('.search-result, .tab-title');
  if (first) { event.preventDefault(); if (event.key === 'Enter') first.click(); else first.focus(); }
});
siteGrid.addEventListener('keydown', event => {
  const items = [...siteGrid.querySelectorAll('.search-result, .tab-title')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); searchInput.focus(); }
  else if (index >= 0 && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }
});
let refreshTimer;
let refreshQueued = false;
function scheduleRefresh() {
  refreshQueued = true; clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (refreshing || organizing || deduplicating) { scheduleRefresh(); return; }
    refreshQueued = false; await refreshTabs({ announce: false });
    if (refreshQueued) scheduleRefresh();
  }, 180);
}
for (const event of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onReplaced', 'onActivated']) chrome.tabs[event]?.addListener(scheduleRefresh);
for (const event of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved']) chrome.tabGroups[event]?.addListener(scheduleRefresh);
chrome.windows.onFocusChanged?.addListener(scheduleRefresh);
