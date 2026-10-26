const $ = selector => document.querySelector(selector);
let token = null;
let previewGeneration = 0;
async function send(type, data = {}) { const result = await chrome.runtime.sendMessage({ type, ...data }); if (!result?.ok) throw Error(result?.error || '操作失败'); return result; }
function node(tag, text, className) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; }
function invalidate() { previewGeneration += 1; token = null; $('#execute-cleanup').disabled = true; }
function scopeChanged() {
  invalidate(); $('#window-field').hidden = $('#cleanup-scope').value !== 'window'; $('#group-field').hidden = $('#cleanup-scope').value !== 'group';
  $('#cleanup-preview').replaceChildren(node('p', '范围已变化，请重新预览。', 'small muted'));
}
$('#cleanup-scope').addEventListener('change', scopeChanged);
$('#cleanup-window').addEventListener('change', scopeChanged); $('#cleanup-group').addEventListener('change', scopeChanged);
$('#preview-cleanup').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true; invalidate();
  const generation = previewGeneration;
  try {
    const scope = $('#cleanup-scope').value;
    const groupOption = $('#cleanup-group').selectedOptions[0];
    const response = await send('DEDUPLICATE_PREVIEW', { scope,
      ...(scope === 'window' ? { windowId: Number($('#cleanup-window').value) } : {}),
      ...(scope === 'group' ? { groupId: Number($('#cleanup-group').value), windowId: Number(groupOption?.dataset.windowId) } : {}) });
    if (generation !== previewGeneration) return;
    token = response.token; const box = $('#cleanup-preview'); box.replaceChildren();
    for (const bucket of response.buckets || []) {
      const section = node('section', undefined, 'duplicate-choice'); section.dataset.bucketId = bucket.id || bucket.bucketId;
      const label = node('label', undefined, 'bucket-label'); const check = node('input'); check.type = 'checkbox'; check.checked = true;
      label.append(check, node('strong', bucket.url || bucket.tabs?.[0]?.url || '重复页面')); section.append(label);
      const keeperLabel = node('label', '保留这一份'); const keeper = node('select'); keeper.className = 'keeper-select';
      for (const tab of bucket.tabs || []) {
        const states = [tab.pinned ? '固定' : '', tab.audible ? '发声' : '', tab.active ? '活跃' : ''].filter(Boolean).join(' / ');
        const option = node('option', `窗口 ${tab.windowId} · ${tab.title || tab.url}${states ? ` · ${states}` : ''}`); option.value = String(tab.id); keeper.append(option);
      }
      keeper.value = String(bucket.keeperId ?? bucket.tabs?.[0]?.id); keeperLabel.append(keeper); section.append(keeperLabel);
      section.append(node('p', ({ 'exact-url': '这些页面的完整网址一致。', 'ignored-parameters': '按已保存规则忽略指定参数后，这些页面的网址一致。' })[bucket.reason] || '默认优先保留正在使用、固定、发声或最近访问的页面。', 'small muted'));
      const details = node('details'); details.append(node('summary', `查看 ${bucket.tabs?.length || 0} 份页面`));
      const list = node('ul'); for (const tab of bucket.tabs || []) list.append(node('li', `窗口 ${tab.windowId} / 标签 ${tab.id}：${tab.title || tab.url}`)); details.append(list); section.append(details); box.append(section);
    }
    const count = response.buckets?.length || 0; $('#execute-cleanup').disabled = !count;
    $('#cleanup-status').textContent = count ? `发现 ${count} 组重复页面。可调整保留项，再执行清理。` : '当前范围没有可清理的重复页面。';
  } catch (error) { if (generation === previewGeneration) $('#cleanup-status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#execute-cleanup').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  const selections = [...document.querySelectorAll('.duplicate-choice')].filter(section => section.querySelector('input').checked)
    .map(section => ({ bucketId: section.dataset.bucketId, keeperId: Number(section.querySelector('select').value) }));
  if (!selections.length) { $('#cleanup-status').textContent = '请至少选择一组。'; button.disabled = false; return; }
  const current = token; invalidate();
  const locked = [...document.querySelectorAll('#cleanup-scope,#cleanup-window,#cleanup-group,#preview-cleanup,.duplicate-choice input,.duplicate-choice select')];
  locked.forEach(control => { control.disabled = true; });
  try {
    $('#cleanup-status').textContent = '正在清理；如 Chrome 提示离开网站，请在浏览器中处理。';
    const result = await send('DEDUPLICATE_EXECUTE', { token: current, selections });
    $('#cleanup-status').textContent = `已关闭 ${result.closed} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个。可到工具箱恢复记录找回链接。`;
    $('#cleanup-preview').replaceChildren(node('p', '本次预览已使用，请重新预览后继续。', 'small muted'));
  } catch (error) { $('#cleanup-status').textContent = `${error.message} 请重新预览。`; }
  finally { locked.forEach(control => { control.disabled = false; }); }
});
$('#save-allowlist').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const result = await send('DUPLICATE_ALLOWLIST_SAVE', { origins: $('#duplicate-allowlist').value.split(/\s+/).filter(Boolean) });
    $('#duplicate-allowlist').value = result.allowlist.join('\n'); $('#policy-status').textContent = '例外名单已保存。'; invalidate();
  } catch (error) { $('#policy-status').textContent = error.message; }
  finally { button.disabled = false; }
});
async function initialize() {
  try {
    const [windows, groups, policy] = await Promise.all([chrome.windows.getAll({ windowTypes: ['normal'] }), chrome.tabGroups.query({}), send('DUPLICATE_POLICY_GET')]);
    for (const window of windows.filter(window => !window.incognito)) { const option = node('option', `窗口 ${window.id}`); option.value = String(window.id); $('#cleanup-window').append(option); }
    for (const group of groups.filter(group => group.shared !== true && windows.some(window => window.id === group.windowId && !window.incognito))) {
      const option = node('option', `窗口 ${group.windowId} / ${group.title || '未命名组'}`); option.value = String(group.id); option.dataset.windowId = String(group.windowId); $('#cleanup-group').append(option);
    }
    $('#duplicate-allowlist').value = policy.allowlist.join('\n');
  } catch (error) { $('#cleanup-status').textContent = error.message; }
}
void initialize();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.duplicateAllowlist || changes.library)) {
    invalidate(); $('#cleanup-status').textContent = '配置已更新，请重新预览后清理。';
  }
});
