const pageTitle = document.querySelector('#page-title');
const switchButton = document.querySelector('#switch-existing');
const openButton = document.querySelector('#open-new');
const closeButton = document.querySelector('#close-prompt');
const retryButton = document.querySelector('#retry-info');
const dashboardLink = document.querySelector('#dashboard-link');
const footerLinks = document.querySelector('#footer-links');
const explanation = document.querySelector('#choice-explanation');
const summary = document.querySelector('#summary');
const targetDetails = document.querySelector('#target-details');
const targetTitle = document.querySelector('#target-title');
const targetUrl = document.querySelector('#target-url');
const matchCount = document.querySelector('#match-count');
const statusBox = document.querySelector('#status');

const token = location.hash.slice(1);
let tabId = null;
let promptInfo = null;
let presentation = 'unknown';
let loading = false;
let choosing = false;
let choiceCompleted = false;

function setStatus(message, kind = 'info') {
  statusBox.textContent = message;
  statusBox.dataset.kind = kind;
  statusBox.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

function parseHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeInfo(response) {
  const url = parseHttpUrl(response?.url);
  if (!response?.ok || !url || !Array.isArray(response.matches)) {
    throw new Error(response?.error || '后台返回的重复标签信息无效');
  }

  const mode = response.presentation === 'popup' ? 'popup' : 'page';
  const matches = response.matches.filter((match) => (
    match
    && typeof match.id === 'number'
    && typeof match.windowId === 'number'
  ));

  return {
    url: url.href,
    title: typeof response.title === 'string' && response.title.trim()
      ? response.title.trim()
      : url.hostname,
    matches,
    presentation: mode,
    sourceAvailable: mode === 'page' || response.sourceAvailable === true,
    busy: response.busy === true,
  };
}

function updateFooter() {
  footerLinks.hidden = retryButton.hidden && dashboardLink.hidden;
}

function showRetry(show) {
  retryButton.hidden = !show;
  updateFooter();
}

function applyPresentation(mode) {
  presentation = mode;
  document.body.dataset.presentation = mode;
  const popup = mode !== 'page';
  pageTitle.textContent = popup ? '链接已打开' : '发现重复标签';
  document.title = pageTitle.textContent;
  dashboardLink.hidden = popup || mode === 'unknown';
  explanation.textContent = mode === 'unknown'
    ? '正在读取这次重复标签的处理信息。'
    : popup
      ? '跳转会切换到已有标签并安全关闭这次新开的重复页；保留会回到新标签。直接关闭提醒也会保留新标签。'
      : '跳转会关闭本提醒页；继续打开会在当前新标签页载入原链接。';
  updateFooter();
}

function setDefaultButtonLabels() {
  switchButton.textContent = presentation === 'page' ? '跳转到已有标签' : '跳转到已打开';
  openButton.textContent = presentation === 'page' ? '仍然打开新标签' : '保留新标签';
}

function updateButtons() {
  const unavailable = loading
    || choosing
    || choiceCompleted
    || !promptInfo
    || !promptInfo.sourceAvailable
    || promptInfo.busy;
  switchButton.disabled = unavailable || promptInfo.matches.length === 0;
  openButton.disabled = unavailable;
  retryButton.disabled = loading || choosing || choiceCompleted;
}

function renderInfo(info) {
  promptInfo = info;
  applyPresentation(info.presentation);
  setDefaultButtonLabels();
  targetTitle.textContent = info.title;
  targetUrl.textContent = info.url;
  targetDetails.hidden = false;

  if (info.busy) {
    summary.textContent = 'Chrome 正在处理这次重复标签。';
    matchCount.textContent = '暂时无法提交新的选择';
    setStatus('正在等待 Chrome 完成关闭，请处理浏览器提示；也可以关闭此提醒。', 'warning');
    showRetry(true);
  } else if (!info.sourceAvailable) {
    summary.textContent = '原网页已经变化，当前提醒已失效。';
    matchCount.textContent = '无法安全定位这次新开的标签';
    setStatus('请关闭此提醒。不会对其他标签页执行操作。', 'warning');
    showRetry(true);
  } else if (info.matches.length > 0) {
    summary.textContent = info.presentation === 'popup'
      ? '这个链接已经在其他标签页中打开。'
      : '这个完整网址已经在普通窗口中打开。';
    matchCount.textContent = `找到 ${info.matches.length} 个已打开的相同标签`;
    setStatus(info.presentation === 'popup'
      ? '请选择跳转到已打开的标签，或保留这次新开的标签。'
      : '请选择跳转到已有标签，或仍然打开这个新标签。');
    showRetry(false);
  } else {
    summary.textContent = '原先检测到的相同标签当前已经不可用。';
    matchCount.textContent = '当前没有可跳转的相同标签';
    setStatus(info.presentation === 'popup'
      ? '你仍可保留并返回这次新开的标签。'
      : '你仍可在当前标签打开原链接。', 'warning');
    showRetry(true);
  }
  updateButtons();
}

async function loadInfo() {
  if (loading || choosing || choiceCompleted) return;
  if (!token) {
    promptInfo = null;
    summary.textContent = '这个提醒缺少有效凭据。';
    setStatus('无法读取目标信息，请关闭提醒。', 'error');
    showRetry(false);
    updateButtons();
    return;
  }

  loading = true;
  promptInfo = null;
  targetDetails.hidden = true;
  showRetry(false);
  summary.textContent = '正在检查已经打开的标签页…';
  setStatus('正在读取重复标签信息…');
  updateButtons();

  try {
    const tab = await chrome.tabs.getCurrent();
    if (!tab || typeof tab.id !== 'number') throw new Error('无法确定当前提醒窗口');
    tabId = tab.id;
    const response = await chrome.runtime.sendMessage({
      type: 'DUPLICATE_PROMPT_INFO',
      tabId,
      token,
    });
    renderInfo(normalizeInfo(response));
  } catch (error) {
    promptInfo = null;
    targetDetails.hidden = true;
    summary.textContent = '暂时无法读取重复标签信息。';
    setStatus(`${error.message}。请重新检测或关闭提醒。`, 'error');
    showRetry(true);
  } finally {
    loading = false;
    updateButtons();
  }
}

function progressLabels(choice) {
  if (choice === 'switch') {
    switchButton.textContent = '正在跳转…';
    setStatus('正在切换到已有标签…');
  } else if (presentation === 'popup') {
    openButton.textContent = '正在保留…';
    setStatus('正在保留并聚焦新标签…');
  } else {
    openButton.textContent = '正在打开…';
    setStatus('正在当前标签打开原链接…');
  }
}

function showChoiceSuccess(choice, response) {
  if (choice === 'open') {
    if (presentation === 'popup' && response.popupClosed === false) {
      setStatus('已保留新标签，提醒窗口未能关闭，请手动关闭。', 'warning');
      return;
    }
    setStatus(presentation === 'popup'
      ? '已保留新标签，正在关闭提醒。'
      : '正在当前标签打开原链接…', 'success');
    return;
  }

  if (response.closed === false) {
    setStatus(presentation === 'popup'
      ? '已有标签已定位，新标签仍保留，请手动处理或关闭提醒。'
      : '已切换到已有标签，但本提醒页未能关闭，请手动关闭。', 'warning');
  } else if (presentation === 'popup' && response.popupClosed === false) {
    setStatus('已切换并关闭新重复页，提醒窗口未能关闭，请手动关闭。', 'warning');
  } else {
    setStatus('已切换到已有标签，正在关闭提醒。', 'success');
  }
}

async function choose(choice) {
  if (choosing
    || choiceCompleted
    || !promptInfo
    || !promptInfo.sourceAvailable
    || promptInfo.busy
    || typeof tabId !== 'number') return;
  if (choice === 'switch' && promptInfo.matches.length === 0) return;

  choosing = true;
  showRetry(false);
  progressLabels(choice);
  updateButtons();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DUPLICATE_PROMPT_CHOOSE',
      tabId,
      token,
      choice,
    });
    if (!response?.ok) throw new Error(response?.error || '后台未能完成这个选择');
    if (choice === 'switch' && response.action !== 'switched') {
      throw new Error('后台未确认已切换到已有标签');
    }
    if (choice === 'open' && response.action !== 'opened') {
      throw new Error('后台未确认已保留或打开新标签');
    }

    choiceCompleted = true;
    showChoiceSuccess(choice, response);
  } catch (error) {
    const operation = choice === 'switch' ? '跳转' : presentation === 'popup' ? '保留' : '打开';
    setStatus(`${operation}失败：${error.message}。你可以重试或选择另一项。`, 'error');
    showRetry(true);
  } finally {
    choosing = false;
    setDefaultButtonLabels();
    updateButtons();
  }
}

switchButton.addEventListener('click', () => choose('switch'));
openButton.addEventListener('click', () => choose('open'));
closeButton.addEventListener('click', () => window.close());
retryButton.addEventListener('click', loadInfo);

applyPresentation('unknown');
setDefaultButtonLabels();
loadInfo();
