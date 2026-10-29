import { DEFAULT_SETTINGS, validateSettings } from './rules.js';

export function initializePromptControl(api, root) {
  const toggle = root.querySelector('#duplicate-prompt-toggle');
  const value = root.querySelector('#duplicate-prompt-value');
  const status = root.querySelector('#duplicate-prompt-status');
  const settingsLink = root.querySelector('#duplicate-prompt-settings');
  let enabled = true;
  let granted = false;
  let known = false;
  let saving = false;
  let epoch = 0;
  let error = '';

  function render() {
    toggle.disabled = saving || !known;
    toggle.setAttribute('aria-checked', String(enabled));
    toggle.setAttribute('aria-busy', String(saving));
    value.textContent = saving ? '保存中' : !known ? '读取中' : enabled ? '已开启' : '已关闭';
    status.textContent = error || (!known ? '正在读取提醒状态…' : !enabled
      ? '已关闭，不再弹出重复页面提醒。' : granted
        ? '新开重复页面时，在网页右上角提醒。' : '已开启，需在设置中授权网页内提醒。');
    status.dataset.error = String(Boolean(error));
    settingsLink.textContent = known && enabled && !granted ? '去授权' : '设置';
  }

  async function refresh() {
    const request = ++epoch;
    try {
      const [stored, permission] = await Promise.all([
        api.storage.local.get({ settings: DEFAULT_SETTINGS }),
        api.permissions.contains({ permissions: ['scripting'], origins: ['http://*/*', 'https://*/*'] }),
      ]);
      if (request !== epoch) return;
      enabled = validateSettings(stored.settings).duplicatePromptEnabled;
      granted = permission;
      known = true;
      error = '';
    } catch {
      if (request !== epoch) return;
      known = false;
      error = '无法读取提醒状态，请点右上角刷新重试。';
    }
    render();
  }

  toggle.addEventListener('click', async () => {
    if (saving || !known) return;
    const desired = !enabled;
    saving = true;
    error = '';
    ++epoch;
    render();
    try {
      const result = await api.runtime.sendMessage({ type: 'DUPLICATE_PROMPT_SET_ENABLED', enabled: desired });
      if (!result?.ok) throw Error(result?.error || '保存失败');
      await refresh();
    } catch {
      await refresh();
      error = '未能确认保存结果，请检查当前状态或刷新重试。';
    } finally {
      saving = false;
      render();
    }
  });
  settingsLink.addEventListener('click', () => api.runtime.openOptionsPage().catch(() => {
    error = '无法打开设置，请右键扩展图标选择“选项”。';
    render();
  }));
  root.querySelector('#refresh-data')?.addEventListener('click', refresh);
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void refresh();
  });
  api.permissions.onAdded?.addListener(refresh);
  api.permissions.onRemoved?.addListener(refresh);
  render();
  return refresh();
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  void initializePromptControl(chrome, document);
}
