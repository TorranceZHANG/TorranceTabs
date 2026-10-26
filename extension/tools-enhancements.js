import { confirmAction } from './ui-dialog.js';
const $ = selector => document.querySelector(selector);
const rpc = async (type, data = {}) => { const result = await chrome.runtime.sendMessage({ type, ...data }); if (!result?.ok) throw Error(result?.error || '操作失败'); return result; };
const make = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const time = value => new Date(value).toLocaleString('zh-CN');
function report(text, target = '#enhancement-status') { const status = $(target); if (status) { status.textContent = text; status.hidden = false; } }
function bind(button, action, target) { button.addEventListener('click', async () => { button.disabled = true; try { await action(); } catch (error) { report(error.message, target); } finally { button.disabled = button.id === 'sync-apply' ? !syncToken : ['sync-upload','sync-preview'].includes(button.id) ? !syncState?.enabled || (button.id === 'sync-preview' && !$('#sync-device').options.length) : false; if (!button.disabled && button.isConnected && document.activeElement === document.body) button.focus(); } }); }
export async function previewWorkspace(request) {
  const preview = await rpc('WORKSPACE_PREVIEW_RESTORE', { source: 'workspace', ...request });
  const count = value => Array.isArray(value) ? value.length : Number(value) || 0;
  const missing = count(preview.missing ?? preview.restore?.missing); const existing = count(preview.existing ?? preview.restore?.reused);
  const details = preview.diff ? `与当前保存版本相比：新增 ${preview.diff.added.length} 项，移除 ${preview.diff.removed.length} 项。` : '';
  const proceed = await confirmAction({ title: '恢复工作区预览',
    message: `将打开缺失的 ${missing} 个页面，复用已打开的 ${existing} 个页面。\n${details}\n${(preview.restore?.missingUrls || []).slice(0, 8).join('\n')}${missing > 8 ? '\n…其余页面省略' : ''}\n现有页面会保留原位置。未保存表单和运行状态无法恢复。`, confirmLabel: '恢复缺失页面' });
  if (!proceed) return null;
  const result = await rpc('WORKSPACE_RESTORE_PREVIEW', { token: preview.token });
  report(`已恢复 ${result.restored || 0} 个，复用 ${result.reused || 0} 个，跳过 ${result.skipped || 0} 个，失败 ${result.failed || 0} 个。`);
  return result;
}
export function attachWorkspaceActions(actions, workspace, revision, refresh) {
  const update = make('button', '更新为当前窗口'); update.type = 'button';
  bind(update, async () => {
    if (!(await confirmAction({ title: '更新工作区', message: `使用当前窗口的页面更新“${workspace.name}”。原内容会保留为历史版本，最多保留 5 版。`, confirmLabel: '保存新版本' }))) return;
    const current = await chrome.windows.getCurrent();
    const result = await rpc('WORKSPACE_UPDATE', { id: workspace.id, baseRevision: revision, name: workspace.name, scope: 'current', windowId: current.id });
    report(`工作区已更新，保存 ${result.saved || 0} 个页面。`); await refresh();
  });
  const history = make('button', '历史版本'); history.type = 'button';
  bind(history, async () => {
    const result = await rpc('WORKSPACE_HISTORY', { id: workspace.id });
    let list = actions.parentElement.querySelector('.workspace-versions');
    if (!list) { list = make('div', undefined, 'workspace-versions'); actions.parentElement.append(list); }
    list.replaceChildren();
    if (!result.history?.length) list.append(make('p', '更新工作区后，旧版本会显示在这里。', 'small muted'));
    for (const version of result.history || []) {
      const row = make('div', undefined, 'version-row'); row.append(make('span', time(version.archivedAt)));
      const restore = make('button', '预览恢复'); restore.type = 'button';
      bind(restore, () => previewWorkspace({ id: workspace.id, source: 'history', versionId: version.versionId })); row.append(restore); list.append(row);
    }
  });
  actions.append(update, history);
}

let syncState = null;
let syncToken = null;
let syncGeneration = 0;
let syncRefreshGeneration = 0;
const sections = () => [...document.querySelectorAll('[name=sync-section]:checked')].map(input => input.value);
function invalidateSync() { syncGeneration += 1; syncToken = null; if ($('#sync-apply')) $('#sync-apply').disabled = true; }
async function refreshSync() {
  const generation = ++syncRefreshGeneration;
  const state = await rpc('SYNC_GET'); if (generation !== syncRefreshGeneration) return;
  syncState = state; syncState.enabled = Boolean(syncState.enabled ?? syncState.config?.enabled); $('#sync-enabled').checked = syncState.enabled;
  const select = $('#sync-device'); const previous = select.value; select.replaceChildren();
  for (const device of syncState.devices || []) {
    const option = make('option', `${device.deviceId === syncState.deviceId ? '本机' : '设备'} ${device.deviceId.slice(0, 8)} · ${time(device.updatedAt)}`);
    option.value = device.deviceId; select.append(option);
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  $('#sync-device').disabled = !syncState.enabled || !select.options.length;
  $('#sync-upload').disabled = !syncState.enabled; $('#sync-preview').disabled = !syncState.enabled || !select.options.length;
  $('#sync-state').textContent = syncState.enabled ? syncState.remoteError || `同步已启用。${(syncState.devices || []).length} 台设备有可选设置；上传和应用均需手动操作。` : '同步未启用。规则和链接默认保留在本机。';
}
async function refreshSnapshots() {
  const state = await rpc('SNAPSHOT_GET'); $('#snapshots-enabled').checked = Boolean(state.config.enabled);
  $('#snapshot-interval').value = String(state.config.intervalMinutes); $('#snapshot-retention').value = String(state.config.retention);
  const list = $('#snapshot-list'); list.replaceChildren();
  for (const snapshot of state.snapshots || []) {
    const row = make('div', undefined, 'version-row'); row.append(make('span', time(snapshot.capturedAt)));
    const button = make('button', '预览恢复'); button.type = 'button';
    bind(button, () => previewWorkspace({ id: snapshot.workspace.id, versionId: snapshot.versionId, source: 'auto' })); row.append(button); list.append(row);
  }
  if (!state.snapshots?.length) list.append(make('p', '尚无快照。可立即保存一份，或启用定时保存。', 'small muted'));
}
if ($('#snapshots')) {
  bind($('#sync-refresh'), async () => { invalidateSync(); await refreshSync(); report('设备列表已刷新。', '#sync-result'); }, '#sync-result');
  bind($('#save-snapshot-config'), async () => {
    await rpc('SNAPSHOT_CONFIGURE', { config: { enabled: $('#snapshots-enabled').checked, intervalMinutes: Number($('#snapshot-interval').value), retention: Number($('#snapshot-retention').value) } });
    await refreshSnapshots(); report('自动快照设置已保存。');
  });
  bind($('#capture-snapshot'), async () => {
    const result = await rpc('SNAPSHOT_CAPTURE'); await refreshSnapshots(); report(result.reason === 'unchanged' ? '页面没有变化，保留现有快照。' : '快照已保存在本机。');
  });
  $('#sync-enabled').addEventListener('change', async event => {
    const enabled = event.target.checked; event.target.disabled = true; invalidateSync();
    try {
      if (enabled && !(await confirmAction({ title: '启用按需同步', message: '启用后可读取同一 Chrome 扩展在其他设备上传的设置。只有点击“上传所选设置”才会向 Chrome 同步存储写入；规则和常用入口可能含内部链接。', confirmLabel: '启用按需同步' }))) { event.target.checked = false; return; }
      await rpc('SYNC_CONFIGURE', { enabled }); await refreshSync();
    } catch (error) { report(error.message, '#sync-result'); await refreshSync().catch(() => {}); }
    finally { event.target.disabled = false; }
  });
  for (const element of document.querySelectorAll('[name=sync-section],#sync-device')) element.addEventListener('change', invalidateSync);
  bind($('#sync-upload'), async () => {
    invalidateSync(); const selected = sections(); if (!selected.length) throw Error('请至少选择一类设置。');
    const names = { rules: '分组规则', preferences: '外观偏好', favorites: '常用入口' };
    if (!(await confirmAction({ title: '上传所选设置', message: `将${selected.map(key => names[key]).join('、')}上传到 Chrome 同步存储，供相同扩展身份的其他设备读取。规则和常用入口可能包含内部网址。`, confirmLabel: '上传所选设置' }))) return;
    await rpc('SYNC_UPLOAD', { sections: selected, baseRemoteDigest: syncState.remoteDigest }); await refreshSync(); report('本机设置已上传。其他设备需预览并确认应用。', '#sync-result');
  }, '#sync-result');
  bind($('#sync-preview'), async () => {
    invalidateSync(); const selected = sections(); if (!selected.length) throw Error('请至少选择一类设置。');
    const generation = syncGeneration; const remoteId = $('#sync-device').value;
    const preview = await rpc('SYNC_PREVIEW', { sections: selected, remoteId });
    if (generation !== syncGeneration || remoteId !== $('#sync-device').value || JSON.stringify(selected) !== JSON.stringify(sections())) return;
    syncToken = preview.token;
    const labels = { rules: '分组规则', favorites: '常用入口', preferences: '外观偏好' };
    const details = make('div'); details.append(make('p', '确认后，所选项目会使用此设备上传的版本；未选项目保留本机设置。'));
    const list = make('ul'); for (const key of selected) list.append(make('li', labels[key])); details.append(list);
    if (preview.changes) {
      const changes = make('ul'); for (const [key, changed] of Object.entries(preview.changes)) changes.append(make('li', `${labels[key] || key}：${changed ? '将更新' : '与本机一致'}`)); details.append(changes);
    }
    if (preview.remote) {
      const content = make('details'); content.append(make('summary', '查看将应用的完整设置'), make('pre', JSON.stringify(preview.remote, null, 2))); details.append(content);
    }
    $('#sync-preview-result').replaceChildren(details); $('#sync-apply').disabled = false; report('预览已就绪，请核对后确认应用。', '#sync-result');
  }, '#sync-result');
  bind($('#sync-apply'), async () => {
    const token = syncToken; invalidateSync(); await rpc('SYNC_APPLY', { token }); report('所选设置已应用。', '#sync-result'); await refreshSync();
  }, '#sync-result');
  Promise.all([refreshSnapshots(), refreshSync()]).catch(error => report(error.message));
}
