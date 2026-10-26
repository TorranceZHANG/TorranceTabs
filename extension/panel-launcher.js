export async function launchPanel(api, { windowId, granted = false } = {}) {
  const fallback = async () => {
    await api.tabs.create({ url: api.runtime.getURL('dashboard.html') });
    return { action: 'dashboard', granted };
  };
  if (!api.sidePanel?.open || !Number.isInteger(windowId)) return fallback();
  try {
    if (!granted) {
      granted = await api.permissions.request({ permissions: ['sidePanel'] });
      if (!granted) return fallback();
      await api.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
      // Opening needs a fresh user gesture after Chrome's async permission UI.
      return { action: 'configured', granted: true };
    }
    await api.sidePanel.open({ windowId }); return { action: 'opened', granted: true };
  } catch { return fallback(); }
}

if (typeof document !== 'undefined') {
  let panelWindowId;
  let panelGranted = false;
  if (chrome.sidePanel?.open) Promise.all([chrome.windows.getCurrent(), chrome.permissions.contains({ permissions: ['sidePanel'] })])
    .then(([window, granted]) => { panelWindowId = window.id; panelGranted = granted; }).catch(() => {});
  document.querySelector('#open-side-panel')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const result = await launchPanel(chrome, { windowId: panelWindowId, granted: panelGranted });
      panelGranted = result.granted;
      button.textContent = ({ configured: '侧栏已启用，点击打开', dashboard: '已打开标签看板', opened: '打开侧栏' })[result.action];
    } catch { button.textContent = '看板打开失败，请重试'; }
    finally { button.disabled = false; }
  });
  document.querySelector('#rule-current-page')?.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find(tab => !tab.incognito && /^https?:\/\//.test(tab.url || ''));
    await chrome.tabs.create({ url: chrome.runtime.getURL(`settings.html${tab ? `?tab=${tab.id}` : ''}`) });
  });
}
