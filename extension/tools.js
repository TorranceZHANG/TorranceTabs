import { canonicalUrl, normalizeDedupRules } from './url-identity.js';

const $ = selector => document.querySelector(selector);
const status = $('#status');
let library = null;
let formRevision = null;
let formBase = null;
const preferencesSignature = value => JSON.stringify({ favorites: value.favorites, dedupRules: value.dedupRules });
let dirty = false;
let importBackup = null;
let previewToken = null;
let fileGeneration = 0;
let noticeTimer;
let configurationPending = false;
async function withConfigurationLock(task) {
  if (configurationPending) throw Error('正在保存或导入配置，请稍后再试。');
  configurationPending = true;
  const controls = [...document.querySelectorAll('#favorites input, #favorites button, #matching input, #matching button, #backup input, #backup select, #backup button')];
  const previous = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  try { return await task(); }
  finally {
    controls.forEach((control, index) => { if (control.isConnected) control.disabled = previous[index]; });
    configurationPending = false;
  }
}

export async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw Error(response?.error || '操作未完成，请重新读取后再试。');
  return response;
}
function notify(message, kind = 'info') {
  clearTimeout(noticeTimer);
  status.textContent = message;
  status.dataset.kind = kind;
  status.hidden = false;
  if (kind !== 'error') noticeTimer = setTimeout(() => { status.hidden = true; }, 9000);
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function field(label, value, type = 'text', placeholder = '') {
  const wrapper = element('label', label);
  const input = element('input');
  input.type = type;
  input.value = value || '';
  input.placeholder = placeholder;
  wrapper.append(input);
  return wrapper;
}
function action(button, task) {
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await task(); }
    catch (error) { if (button.id === 'check-update') $('#update-result').textContent = '检查未完成，请稍后重试或查看发布记录。'; notify(error.message, 'error'); }
    finally {
      if (['undo-all', 'undo-selected'].includes(button.id)) button.disabled = !$('#undo-list input:not(:disabled)');
      else if (button.id === 'confirm-import') button.disabled = !previewToken;
      else if (button.id === 'preview-import') button.disabled = !importBackup;
      else button.disabled = false;
    }
  });
}
function markDirty() {
  dirty = true;
  $('#draft-state').textContent = '有未保存修改，点击“保存入口与去重规则”生效';
  updateComparison();
}
function favoritesFromForm() {
  return [...$('#favorite-fields').children].map(row => {
    const [name, url] = row.querySelectorAll('input');
    if (!name.value.trim() && !url.value.trim()) return null;
    if (!url.value.trim()) throw Error('请为常用入口填写完整网址，或清空名称和网址以移除此入口。');
    return { name: name.value.trim() || new URL(url.value.trim()).hostname, url: url.value.trim() };
  });
}
function rulesFromForm() {
  return normalizeDedupRules([...$('#dedup-fields').children].map(row => {
    const [origin, params] = row.querySelectorAll('input');
    return { origin: origin.value.trim(), ignoreParams: params.value.split(/[,，\s]+/).filter(Boolean) };
  }));
}
function appendRule(rule = { origin: '', ignoreParams: [] }) {
  const row = element('div', undefined, 'rule-row');
  row.append(field('网站来源', rule.origin, 'url', 'https://ata.atatech.org'),
    field('忽略的参数', rule.ignoreParams.join(', '), 'text', 'spm'));
  const remove = element('button', '×', 'mini danger');
  remove.type = 'button';
  remove.setAttribute('aria-label', '删除此网站去重规则');
  remove.addEventListener('click', () => { row.remove(); markDirty(); });
  row.append(remove);
  row.addEventListener('input', markDirty);
  $('#dedup-fields').append(row);
}
function renderForms() {
  const container = $('#favorite-fields');
  container.replaceChildren();
  for (let index = 0; index < 3; index++) {
    const favorite = library.favorites[index];
    const row = element('div', undefined, 'favorite-row');
    row.append(element('span', String(index + 1), 'slot'), field('名称', favorite?.name, 'text', '常用站点'),
      field('完整网址', favorite?.url, 'url', 'https://example.com/'));
    row.querySelector('input').maxLength = 80;
    const open = element('button', '打开', 'mini');
    open.type = 'button';
    open.title = '打开此槽位已保存的入口';
    open.disabled = !favorite;
    action(open, async () => {
      const result = await send('FAVORITE_OPEN', { slot: index + 1 });
      notify(result.action === 'focused' ? '已切换到打开的页面。' : '已打开常用页面。');
    });
    row.append(open);
    row.addEventListener('input', markDirty);
    container.append(row);
  }
  $('#dedup-fields').replaceChildren();
  library.dedupRules.forEach(appendRule);
  formRevision = library.revision;
  formBase = preferencesSignature(library);
  dirty = false;
  $('#draft-state').textContent = '当前配置已保存';
  updateComparison();
}
function updateComparison() {
  const a = $('#compare-a').value.trim();
  const b = $('#compare-b').value.trim();
  if (!a || !b) { $('#compare-result').textContent = '使用当前表单中的规则进行本地预览'; return; }
  try {
    const rules = rulesFromForm();
    const first = canonicalUrl(a, rules);
    const second = canonicalUrl(b, rules);
    $('#compare-result').textContent = !first || !second ? '请输入有效的 HTTP(S) 网址。'
      : first === second ? '根据当前规则，这两个网址会视为重复。' : '根据当前规则，这两个网址分别保留。';
  } catch (error) { $('#compare-result').textContent = error.message; }
}
function summary(result) {
  return [result.restored !== undefined ? `恢复 ${result.restored} 个` : '',
    result.reused !== undefined ? `复用 ${result.reused} 个` : '',
    result.skipped ? `跳过 ${result.skipped} 个` : '', result.failed ? `失败 ${result.failed} 个` : '',
    result.interrupted ? '部分操作已中断，请查看记录后再决定' : ''].filter(Boolean).join(' · ') || '操作已完成';
}
function renderWorkspaces() {
  const list = $('#workspace-list');
  list.replaceChildren();
  if (!library.workspaces.length) list.append(element('p', '尚未保存工作区。', 'empty'));
  for (const workspace of library.workspaces) {
    const item = element('div', undefined, 'item');
    const copy = element('div');
    copy.append(element('strong', workspace.name), element('p', `${workspace.windowCount ?? workspace.windows.length} 个窗口 · ${workspace.tabCount ?? workspace.windows.reduce((n, win) => n + win.tabs.length, 0)} 个网页`, 'small muted'));
    const actions = element('div', undefined, 'actions');
    const restore = element('button', '恢复工作区');
    action(restore, async () => {
      const result = await send('WORKSPACE_RESTORE', { id: workspace.id });
      notify(summary(result), result.failed || result.interrupted ? 'error' : 'info');
      await refresh();
    });
    const remove = element('button', '删除', 'danger');
    action(remove, async () => {
      if (!confirm(`删除工作区“${workspace.name}”的保存记录？不会关闭任何已打开页面。`)) return;
      await send('WORKSPACE_DELETE', { id: workspace.id });
      await refresh();
      notify('已删除工作区记录。');
    });
    actions.append(restore, remove);
    item.append(copy, actions);
    list.append(item);
  }
}
function renderUndo(undo) {
  const list = $('#undo-list');
  list.replaceChildren();
  const items = undo?.items || [];
  if (!items.length) list.append(element('p', '暂无可恢复的清理记录。', 'empty'));
  for (const record of items) {
    const row = element('div', undefined, 'item');
    const label = element('label');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.value = record.id;
    checkbox.disabled = record.status !== 'available';
    const text = element('span');
    text.append(element('strong', record.title || record.url), element('p', record.url, 'url'));
    if (record.status !== 'available') text.append(element('p', '上次恢复或关闭结果不确定，暂不自动重试。', 'small muted'));
    label.append(checkbox, text);
    row.append(label);
    list.append(row);
  }
  $('#undo-all').disabled = !items.some(item => item.status === 'available');
  $('#undo-selected').disabled = $('#undo-all').disabled;
}
async function refresh({ forms = false } = {}) {
  const data = await send('LIBRARY_GET');
  library = data.library;
  renderWorkspaces();
  renderUndo(data.undo);
  if (forms || (!dirty && preferencesSignature(library) !== formBase)) renderForms();
  else if (preferencesSignature(library) === formBase) formRevision = library.revision;
}
function invalidatePreview() {
  previewToken = null;
  $('#confirm-import').disabled = true;
  $('#import-preview').hidden = true;
}
const names = { settingsChanged: '分组设置将更新', readingAdded: '新增稍后读', readingReplaced: '覆盖稍后读', favoritesChanged: '常用入口变更', dedupRulesChanged: '去重规则变更', workspacesAdded: '新增工作区', workspacesReplaced: '覆盖工作区', totalItems: '导入后条目合计' };
function showPreview(result) {
  const box = $('#import-preview');
  box.replaceChildren(element('strong', $('#import-mode').value === 'merge' ? '合并预览：冲突时保留本机配置' : '覆盖预览：本机配置将使用此备份'));
  const details = element('ul');
  for (const [key, value] of Object.entries(result.summary || {})) {
    details.append(element('li', `${names[key] || key}：${typeof value === 'boolean' ? value ? '是' : '否' : value}`));
  }
  box.append(details);
  if (result.conflicts?.length) {
    box.append(element('p', `发现 ${result.conflicts.length} 项冲突：`));
    const conflicts = element('ul');
    result.conflicts.slice(0, 20).forEach(conflict => conflicts.append(element('li', typeof conflict === 'string' ? conflict : `${({ settings: '分组设置', rules: '分组规则', favorites: '常用入口', dedupRules: '去重规则', readingList: '稍后读', workspaces: '工作区' })[conflict.section] || '配置'}：${conflict.key}`)));
    box.append(conflicts);
  }
  box.append(element('p', '确认后才会写入。若其他页面修改了配置，请重新预览。', 'small muted'));
  box.hidden = false;
}
action($('#save-library'), () => withConfigurationLock(async () => {
  await send('LIBRARY_SAVE', { favorites: favoritesFromForm(), dedupRules: rulesFromForm(), baseRevision: formRevision });
  await refresh({ forms: true });
  notify('常用入口与去重规则已保存。');
}));
action($('#reload'), async () => {
  if (dirty && !confirm('重新读取将放弃当前未保存的入口和去重规则修改，是否继续？')) return;
  await refresh({ forms: true });
  notify('已读取最新配置与恢复记录。');
});
$('#add-dedup-rule').addEventListener('click', () => { appendRule(); markDirty(); });
$('#compare-a').addEventListener('input', updateComparison);
$('#compare-b').addEventListener('input', updateComparison);
action($('#shortcuts'), () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('#workspace-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter || event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const tab = await chrome.tabs.getCurrent();
    const result = await send('WORKSPACE_SAVE', { name: $('#workspace-name').value.trim(), scope: $('#workspace-scope').value, windowId: tab?.windowId });
    await refresh();
    notify(`已保存 ${result.saved ?? 0} 个网页${result.skipped ? `，跳过 ${result.skipped} 个受保护或内部页面` : ''}。`);
    $('#workspace-name').value = '';
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; }
});
action($('#undo-discard'), async () => {
  if (!confirm('清空所有清理恢复记录？不会关闭或修改已打开的网页，清空后无法再通过这些记录恢复。')) return;
  const result = await send('UNDO_DISCARD');
  await refresh();
  notify(`已清空 ${result.discarded ?? 0} 条恢复记录。`);
});
action($('#undo-all'), async () => { const result = await send('UNDO_RESTORE'); await refresh(); notify(summary(result), result.failed || result.interrupted ? 'error' : 'info'); });
action($('#undo-selected'), async () => {
  const ids = [...$('#undo-list').querySelectorAll('input:checked')].map(input => input.value);
  if (!ids.length) throw Error('请先勾选要恢复的网页。');
  const result = await send('UNDO_RESTORE', { ids });
  await refresh();
  notify(summary(result), result.failed || result.interrupted ? 'error' : 'info');
});
action($('#export-config'), async () => {
  const { backup } = await send('CONFIG_EXPORT');
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
  const link = element('a');
  link.href = url;
  link.download = `TorranceTabs-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('已生成配置备份文件。浏览器授权不会导出。');
});
$('#import-file').addEventListener('change', async event => {
  const generation = ++fileGeneration;
  invalidatePreview();
  importBackup = null;
  $('#preview-import').disabled = true;
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw Error('备份文件过大，最大支持 1 MB。');
    const parsed = JSON.parse(await file.text());
    if (generation !== fileGeneration) return;
    importBackup = parsed;
    $('#preview-import').disabled = false;
  } catch (error) { if (generation === fileGeneration) notify(`无法读取备份：${error.message}`, 'error'); }
});
$('#import-mode').addEventListener('change', invalidatePreview);
action($('#preview-import'), async () => {
  if (!importBackup) throw Error('请先选择备份文件。');
  const generation = fileGeneration;
  const mode = $('#import-mode').value;
  const result = await send('CONFIG_PREVIEW', { backup: importBackup, mode });
  if (generation !== fileGeneration || mode !== $('#import-mode').value) return;
  previewToken = result.token;
  showPreview(result);
  $('#confirm-import').disabled = !previewToken;
});
action($('#confirm-import'), () => withConfigurationLock(async () => {
  if (!previewToken) throw Error('请重新预览导入。');
  if (dirty && !confirm('导入完成后会载入导入结果，当前未保存的表单修改将被放弃。是否继续？')) return;
  const token = previewToken;
  invalidatePreview();
  await send('CONFIG_IMPORT', { token, backup: importBackup });
  await refresh({ forms: true });
  notify('配置已导入。网页提醒授权仍由此浏览器单独管理。');
}));
action($('#check-update'), async () => {
  const granted = await chrome.permissions.request({ origins: ['https://api.github.com/*'] });
  if (!granted) throw Error('未获准访问 GitHub，尚未检查更新。');
  $('#update-result').textContent = '正在检查正式版本…';
  const result = await send('CHECK_UPDATE');
  if (result.manual) {
    $('#update-result').textContent = 'GitHub API 暂时受限，尚未自动比较版本。点击“查看最新发布页”检查；也可直接使用下方更新命令。';
    $('#release-link').href = 'https://github.com/TorranceZHANG/TorranceTabs/releases/latest';
    $('#release-link').textContent = '查看最新发布页';
    return;
  }
  $('#release-link').textContent = '查看发布记录';
  $('#update-result').textContent = result.available ? `发现新版 ${result.latest}，当前 ${result.current}。可查看发布记录，或复制下方命令更新。` : `当前 ${result.current}；最新正式版 ${result.latest}。暂无更新。`;
  if (typeof result.url === 'string' && /^https:\/\/github\.com\/TorranceZHANG\/TorranceTabs\/releases\/tag\/v\d+\.\d+\.\d+$/.test(result.url)) $('#release-link').href = result.url;
});
action($('#copy-update'), async () => {
  try { await navigator.clipboard.writeText($('#update-command').value); notify('更新命令已复制。运行后记得重新加载扩展。'); }
  catch { $('#update-command').focus(); $('#update-command').select(); throw Error('无法自动复制，命令已选中，请按复制快捷键。'); }
});
$('#version').textContent = $('#current-version').textContent = `v${chrome.runtime.getManifest().version}`;
refresh({ forms: true }).catch(error => notify(error.message, 'error'));
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
