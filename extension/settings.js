import {
  COLORS,
  COLOR_LABELS,
  DEFAULT_SETTINGS,
  validateSettings,
  findRule,
  explainRule,
} from './rules.js';

const STORAGE_KEY = 'settings';
const RULE_REASONS = { matched: '符合规则', excluded: '命中排除路径', 'no-match': '没有匹配规则', 'invalid-url': '不是可整理的网页', disabled: '自动分组已关闭', ineligible: '固定、无痕或分屏页面', paused: '本标签已暂停整理', 'protected-group': '标签组受保护', 'shared-target': '目标组为共享组' };
const EXAMPLE_RULES = [
  { prefix: 'https://mail.google.com/', group: '邮件', color: 'blue', enabled: true },
  { prefix: 'https://github.com/', group: '开发', color: 'purple', enabled: true },
  { prefix: 'https://www.youtube.com/', group: '视频', color: 'red', enabled: true },
];

const form = document.querySelector('#settings-form');
const enabledInput = document.querySelector('#enabled');
const duplicatePromptInput = document.querySelector('#duplicate-prompt-enabled');
const rulesList = document.querySelector('#rules-list');
const emptyState = document.querySelector('#empty-state');
const ruleTemplate = document.querySelector('#rule-template');
const addRuleButton = document.querySelector('#add-rule');
const fillExamplesButton = document.querySelector('#fill-examples');
const saveButton = document.querySelector('#save');
const saveAndApplyButton = document.querySelector('#save-and-apply');
const previewUrlInput = document.querySelector('#preview-url');
const previewResult = document.querySelector('#preview-result');
const statusBox = document.querySelector('#status');
const externalNotice = document.querySelector('#external-notice');
const reloadExternalButton = document.querySelector('#reload-external');
const grantInlinePermissionButton = document.querySelector('#grant-inline-permission');
const revokeInlinePermissionButton = document.querySelector('#revoke-inline-permission');
const inlinePermissionStatus = document.querySelector('#inline-permission-status');

const INLINE_PERMISSION_REQUEST = {
  permissions: ['scripting'],
  origins: ['http://*/*', 'https://*/*'],
};

let dirty = false;
let saving = false;
let nextRuleId = 1;
let externalSettings = null;
let pendingSaveSignature = null;
let inlinePermissionGranted = false;
let inlinePermissionKnown = false;
let inlinePermissionBusy = false;

function cloneSettings(settings) {
  return {
    enabled: settings.enabled,
    duplicatePromptEnabled: settings.duplicatePromptEnabled ?? true,
    rules: settings.rules.map((rule) => ({ ...rule })),
  };
}

function signature(value) {
  return JSON.stringify(value);
}

function setStatus(message, kind = 'info') {
  statusBox.textContent = message;
  statusBox.dataset.kind = kind;
  statusBox.hidden = !message;
  statusBox.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

function setSaving(isSaving) {
  saving = isSaving;
  const controls = form.querySelectorAll('button, input, select, textarea');
  controls.forEach((control) => {
    control.disabled = isSaving;
  });
  reloadExternalButton.disabled = isSaving;
  if (isSaving) {
    saveButton.textContent = '保存中…';
    saveAndApplyButton.textContent = '保存中…';
  } else {
    saveButton.textContent = '保存';
    saveAndApplyButton.textContent = '保存并整理当前窗口';
  }
  updateInlinePermissionButtons();
}

function updateInlinePermissionButtons() {
  const unavailable = saving || inlinePermissionBusy || !inlinePermissionKnown || !chrome.permissions;
  grantInlinePermissionButton.disabled = unavailable || inlinePermissionGranted;
  revokeInlinePermissionButton.disabled = unavailable;
}

function renderInlinePermissionStatus(granted, message) {
  inlinePermissionGranted = granted;
  inlinePermissionKnown = true;
  inlinePermissionStatus.dataset.granted = String(granted);
  inlinePermissionStatus.textContent = message || (granted
    ? '已授权：重复链接会直接在网页右上角显示提醒。'
    : '尚未获得全部网页访问权；仅在已授权网站显示提醒。自动分组和一键去重仍可正常使用。');
  updateInlinePermissionButtons();
}

async function refreshInlinePermissionStatus() {
  if (!chrome.permissions) {
    renderInlinePermissionStatus(false, '当前扩展版本未提供网页内提醒授权。');
    return;
  }

  try {
    const granted = await chrome.permissions.contains(INLINE_PERMISSION_REQUEST);
    renderInlinePermissionStatus(granted);
  } catch (error) {
    inlinePermissionGranted = false;
    inlinePermissionKnown = true;
    inlinePermissionStatus.dataset.granted = 'false';
    inlinePermissionStatus.textContent = `无法读取授权状态：${error.message}`;
    updateInlinePermissionButtons();
  }
}

function markDirty() {
  if (saving) return;
  dirty = true;
  setStatus('有未保存的更改。', 'info');
}

function updateEmptyState() {
  const isEmpty = rulesList.children.length === 0;
  emptyState.hidden = !isEmpty;
}

function updateColorDot(select) {
  const dot = select.closest('.color-select-wrap').querySelector('.color-dot');
  dot.dataset.color = select.value;
}

function createRuleCard(rule = { prefix: '', group: '', color: COLORS[0], enabled: true }) {
  const fragment = ruleTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.rule-card');
  const ruleId = nextRuleId++;
  const prefixInput = card.querySelector('.rule-prefix');
  const groupInput = card.querySelector('.rule-group');
  const colorSelect = card.querySelector('.rule-color');
  const ruleEnabledInput = card.querySelector('.rule-enabled');
  const deleteButton = card.querySelector('.delete-rule');

  card.dataset.ruleId = String(ruleId);
  card.querySelector('.rule-number').textContent = String(rulesList.children.length + 1);

  prefixInput.id = `rule-prefix-${ruleId}`;
  groupInput.id = `rule-group-${ruleId}`;
  colorSelect.id = `rule-color-${ruleId}`;
  ruleEnabledInput.id = `rule-enabled-${ruleId}`;
  card.querySelector('.prefix-field').htmlFor = prefixInput.id;
  card.querySelector('.group-field').htmlFor = groupInput.id;
  card.querySelector('.color-field').htmlFor = colorSelect.id;
  card.querySelector('.compact-toggle').htmlFor = ruleEnabledInput.id;
  deleteButton.setAttribute('aria-label', `删除规则 ${rulesList.children.length + 1}`);

  COLORS.forEach((color) => {
    const option = document.createElement('option');
    option.value = color;
    option.textContent = COLOR_LABELS[color] ?? color;
    colorSelect.append(option);
  });

  prefixInput.value = rule.prefix ?? '';
  groupInput.value = rule.group ?? '';
  colorSelect.value = COLORS.includes(rule.color) ? rule.color : COLORS[0];
  ruleEnabledInput.checked = rule.enabled !== false;
  const exclusions = document.createElement('label'); exclusions.className = 'field exclusion-field';
  const caption = document.createElement('span'); caption.textContent = '排除路径（可选，每行一个，以 / 开头）';
  const paths = document.createElement('textarea'); paths.className = 'rule-exclusions'; paths.rows = 2;
  paths.placeholder = '/login\n/settings'; paths.value = (rule.excludePaths || []).join('\n');
  exclusions.append(caption, paths); card.append(exclusions);
  updateColorDot(colorSelect);

  colorSelect.addEventListener('change', () => updateColorDot(colorSelect));
  deleteButton.addEventListener('click', () => {
    card.remove();
    renumberRules();
    updateEmptyState();
    markDirty();
    updatePreview();
  });

  rulesList.append(fragment);
  updateEmptyState();
  return card;
}

function renumberRules() {
  [...rulesList.children].forEach((card, index) => {
    card.querySelector('.rule-number').textContent = String(index + 1);
    card.querySelector('.delete-rule').setAttribute('aria-label', `删除规则 ${index + 1}`);
  });
}

function renderSettings(settings) {
  enabledInput.checked = settings.enabled;
  duplicatePromptInput.checked = settings.duplicatePromptEnabled ?? true;
  rulesList.replaceChildren();
  settings.rules.forEach((rule) => createRuleCard(rule));
  updateEmptyState();
  updatePreview();
}

function readFormSettings() {
  const rules = [...rulesList.querySelectorAll('.rule-card')].map((card) => ({
    prefix: card.querySelector('.rule-prefix').value,
    group: card.querySelector('.rule-group').value,
    color: card.querySelector('.rule-color').value,
    enabled: card.querySelector('.rule-enabled').checked,
    excludePaths: card.querySelector('.rule-exclusions').value.split(/\n/).map(path => path.trim()).filter(Boolean),
  }));

  return {
    enabled: enabledInput.checked,
    duplicatePromptEnabled: duplicatePromptInput.checked,
    rules,
  };
}

function updatePreview() {
  const url = previewUrlInput.value.trim();
  previewResult.classList.remove('is-match', 'is-error');

  if (!url) {
    previewResult.textContent = '输入网址后查看匹配结果';
    return;
  }

  try {
    const settings = validateSettings(readFormSettings());
    if (!settings.enabled) {
      previewResult.textContent = '自动整理已关闭，当前不会匹配任何规则';
      return;
    }

    const explanation = explainRule(url, settings.rules);
    const rule = explanation.rule;
    if (!rule) {
      previewResult.textContent = `${RULE_REASONS[explanation.reason] || '没有匹配规则'}，标签页会保持原状`;
      return;
    }

    const colorLabel = COLOR_LABELS[rule.color] ?? rule.color;
    previewResult.textContent = `匹配“${rule.group}” · ${colorLabel} · 前缀 ${rule.prefix}`;
    previewResult.classList.add('is-match');
  } catch (error) {
    previewResult.textContent = `暂时无法预览：${error.message}`;
    previewResult.classList.add('is-error');
  }
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const settings = validateSettings(stored[STORAGE_KEY] ?? cloneSettings(DEFAULT_SETTINGS));
    renderSettings(settings);
    dirty = false;
  } catch (error) {
    renderSettings(cloneSettings(DEFAULT_SETTINGS));
    dirty = false;
    setStatus(`读取已保存设置失败：${error.message}`, 'error');
  }
}

async function persistSettings() {
  const settings = validateSettings(readFormSettings());
  pendingSaveSignature = signature(settings);

  try {
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!response?.ok) throw Error(response?.error || '后台未确认设置已保存，请重试。');
    dirty = false;
    externalSettings = null;
    externalNotice.hidden = true;
    return settings;
  } finally {
    pendingSaveSignature = null;
  }
}

async function save({ applyCurrentWindow = false } = {}) {
  if (saving) return;

  if (!form.checkValidity()) {
    form.reportValidity();
    setStatus('请补全每条规则的网址前缀和标签组名称。', 'error');
    return;
  }

  setSaving(true);
  setStatus('正在保存设置…', 'info');

  try {
    await persistSettings();

    if (!applyCurrentWindow) {
      setStatus('设置已保存。后续新建或跳转页面时会自动应用。', 'success');
      return;
    }

    try {
      const currentTab = await chrome.tabs.getCurrent();
      if (!currentTab || typeof currentTab.windowId !== 'number') {
        throw new Error('无法确定设置页所在的窗口');
      }

      const response = await chrome.runtime.sendMessage({
        type: 'APPLY_CURRENT_WINDOW',
        windowId: currentTab.windowId,
      });

      if (!response?.ok) {
        throw new Error(response?.error || '后台未返回成功结果');
      }

      const grouped = Number(response.grouped) || 0;
      const skipped = Number(response.skipped) || 0;
      const failed = Number(response.failed) || 0;
      const kind = failed > 0 ? 'warning' : 'success';
      setStatus(`设置已保存；当前窗口已整理 ${grouped} 个，跳过 ${skipped} 个，失败 ${failed} 个。`, kind);
    } catch (error) {
      setStatus(`设置已保存，但未能整理当前窗口：${error.message}`, 'warning');
    }
  } catch (error) {
    setStatus(`保存失败：${error.message}`, 'error');
  } finally {
    setSaving(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});

form.addEventListener('input', (event) => {
  if (event.target === previewUrlInput) {
    updatePreview();
    return;
  }
  markDirty();
  updatePreview();
});

form.addEventListener('change', (event) => {
  if (event.target !== previewUrlInput) {
    markDirty();
    updatePreview();
  }
});

addRuleButton.addEventListener('click', () => {
  const card = createRuleCard();
  markDirty();
  card.querySelector('.rule-prefix').focus();
  updatePreview();
});

fillExamplesButton.addEventListener('click', () => {
  rulesList.replaceChildren();
  EXAMPLE_RULES.forEach((rule) => createRuleCard(rule));
  markDirty();
  setStatus('示例已填入表单，尚未保存。', 'info');
  updatePreview();
});

saveAndApplyButton.addEventListener('click', () => save({ applyCurrentWindow: true }));
previewUrlInput.addEventListener('input', updatePreview);

grantInlinePermissionButton.addEventListener('click', () => {
  if (inlinePermissionBusy || !chrome.permissions) return;
  inlinePermissionBusy = true;
  inlinePermissionStatus.textContent = '等待 Chrome 确认网页内提醒授权…';
  updateInlinePermissionButtons();

  let request;
  try {
    request = chrome.permissions.request(INLINE_PERMISSION_REQUEST);
  } catch (error) {
    inlinePermissionBusy = false;
    renderInlinePermissionStatus(false, `授权失败：${error.message}`);
    return;
  }

  Promise.resolve(request)
    .then((granted) => {
      if (!granted) renderInlinePermissionStatus(false, '未授予网页访问权；其他功能不受影响。');
      return refreshInlinePermissionStatus();
    })
    .catch((error) => {
      renderInlinePermissionStatus(false, `授权失败：${error.message}`);
    })
    .finally(() => {
      inlinePermissionBusy = false;
      updateInlinePermissionButtons();
    });
});

revokeInlinePermissionButton.addEventListener('click', () => {
  if (inlinePermissionBusy || !chrome.permissions) return;
  inlinePermissionBusy = true;
  inlinePermissionStatus.textContent = '正在撤销网页内提醒授权…';
  updateInlinePermissionButtons();

  let removal;
  try {
    removal = chrome.permissions.remove(INLINE_PERMISSION_REQUEST);
  } catch (error) {
    inlinePermissionBusy = false;
    inlinePermissionStatus.textContent = `撤销失败：${error.message}`;
    updateInlinePermissionButtons();
    return;
  }

  Promise.resolve(removal)
    .then(() => refreshInlinePermissionStatus())
    .catch((error) => {
      inlinePermissionStatus.textContent = `撤销失败：${error.message}`;
    })
    .finally(() => {
      inlinePermissionBusy = false;
      updateInlinePermissionButtons();
    });
});

reloadExternalButton.addEventListener('click', () => {
  if (!externalSettings || saving) return;
  renderSettings(externalSettings);
  externalSettings = null;
  externalNotice.hidden = true;
  dirty = false;
  setStatus('已载入其他页面保存的设置。', 'success');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEY]) return;

  try {
    const changed = validateSettings(changes[STORAGE_KEY].newValue ?? cloneSettings(DEFAULT_SETTINGS));
    if (pendingSaveSignature && signature(changed) === pendingSaveSignature) return;

    if (dirty || saving) {
      externalSettings = changed;
      externalNotice.hidden = false;
      setStatus('检测到其他页面保存了新设置；当前未保存编辑已保留。', 'warning');
      return;
    }

    renderSettings(changed);
    setStatus('已同步其他页面保存的设置。', 'success');
  } catch (error) {
    setStatus(`其他页面写入的设置无效：${error.message}`, 'error');
  }
});

chrome.permissions?.onAdded?.addListener(refreshInlinePermissionStatus);
chrome.permissions?.onRemoved?.addListener(refreshInlinePermissionStatus);

loadSettings();
refreshInlinePermissionStatus();

let sourceTabs = [];
async function loadRuleSources() {
  try {
    sourceTabs = (await chrome.tabs.query({ windowType: 'normal' })).filter(tab => !tab.incognito && /^https?:\/\//.test(tab.url || ''))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const select = document.querySelector('#rule-source'); select.replaceChildren();
    const requested = Number(new URL(location.href).searchParams.get('tab'));
    for (const tab of sourceTabs) { const option = document.createElement('option'); option.value = String(tab.id); option.textContent = `窗口 ${tab.windowId} · ${tab.title || tab.url}`; select.append(option); }
    if (sourceTabs.some(tab => tab.id === requested)) select.value = String(requested);
    const selected = sourceTabs.find(tab => tab.id === Number(select.value));
    if (selected) document.querySelector('#assistant-url').value = selected.url;
  } catch (error) { setStatus(error.message, 'error'); }
}
document.querySelector('#rule-source').addEventListener('change', event => {
  const tab = sourceTabs.find(tab => tab.id === Number(event.target.value));
  if (tab) document.querySelector('#assistant-url').value = tab.url;
});
document.querySelector('#create-rule-from-page').addEventListener('click', () => {
  try {
    const url = new URL(document.querySelector('#assistant-url').value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('请输入有效的 HTTP(S) 网页网址。');
    const path = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
    const prefix = document.querySelector('#assistant-mode').value === 'site' ? `${url.origin}/` : `${url.origin}${path || '/'}`;
    const name = document.querySelector('#assistant-group').value.trim(); if (!name) throw Error('请填写标签组名称。');
    const existing = readFormSettings().rules.find(rule => rule.group.trim() === name);
    const card = createRuleCard({ prefix, group: name, color: existing?.color || 'blue', enabled: true, excludePaths: [] });
    markDirty(); updatePreview(); card.querySelector('.rule-prefix').focus(); setStatus('规则已加入草稿，保存后生效。');
  } catch (error) { setStatus(error.message, 'error'); }
});
document.querySelector('#preview-rules-impact').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const selected = sourceTabs.find(tab => tab.id === Number(document.querySelector('#rule-source').value));
    const windowId = selected?.windowId ?? (await chrome.windows.getCurrent()).id;
    const current = validateSettings(readFormSettings());
    const result = await chrome.runtime.sendMessage({ type: 'RULES_PREVIEW', windowId, rules: current.rules });
    if (!result?.ok) throw Error(result?.error || '试跑失败');
    const box = document.querySelector('#rules-impact'); box.replaceChildren();
    const summary = document.createElement('p'); summary.textContent = `${current.enabled ? '' : '自动分组已关闭，以下为启用后的预计结果。'}窗口 ${windowId}：命中 ${result.matched}，排除 ${result.excluded}，跳过 ${result.skipped}。试跑不会移动标签。`; box.append(summary);
    const list = document.createElement('ul');
    for (const item of (result.results || []).slice(0, 200)) { const li = document.createElement('li'); li.textContent = `${item.title || item.url} → ${item.targetGroup || item.group || '保持原状'}：${RULE_REASONS[item.reason] || '保持原状'}`; list.append(li); } box.append(list);
  } catch (error) { setStatus(error.message, 'error'); }
  finally { button.disabled = false; }
});
for (const [id, paused] of [['pause-selected-tab', true], ['resume-selected-tab', false]]) document.querySelector(`#${id}`).addEventListener('click', async () => {
  try {
    const tabId = Number(document.querySelector('#rule-source').value); if (!sourceTabs.some(tab => tab.id === tabId)) throw Error('请先选择网页。');
    const response = await chrome.runtime.sendMessage({ type: 'GROUPING_PAUSE_TAB', tabId, paused });
    if (!response?.ok) throw Error(response?.error || '设置失败');
    setStatus(paused ? '已暂停此标签的自动分组，直到关闭标签或结束浏览器会话。' : '已恢复此标签的自动分组。', 'success');
  } catch (error) { setStatus(error.message, 'error'); }
});
void loadRuleSources();
window.addEventListener('beforeunload', event => {
  if (!dirty) return;
  event.preventDefault(); event.returnValue = '';
});
