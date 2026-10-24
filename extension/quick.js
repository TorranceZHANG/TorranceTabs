const STATUS_KEY = 'cleanupStatus';
const STATUS_STATES = new Set(['idle', 'running', 'done', 'error', 'interrupted']);
const TERMINAL_STATES = new Set(['done', 'error', 'interrupted']);

const refreshButton = document.querySelector('#refresh-data');
const cleanupButton = document.querySelector('#cleanup-tabs');
const cleanupButtonLabel = document.querySelector('#cleanup-button-label');
const tabCount = document.querySelector('#tab-count');
const duplicateCount = document.querySelector('#duplicate-count');
const snapshotTime = document.querySelector('#snapshot-time');
const cleanupState = document.querySelector('#cleanup-state');
const operationStatus = document.querySelector('#operation-status');
const operationSummary = document.querySelector('#operation-summary');
const operationDetails = document.querySelector('#operation-details');
const nativePromptHint = document.querySelector('#native-prompt-hint');
const loadError = document.querySelector('#load-error');
const loadErrorText = document.querySelector('#load-error-text');
const retryLoadButton = document.querySelector('#retry-load');
const shortcutValue = document.querySelector('#shortcut-value');
const editShortcutButton = document.querySelector('#edit-shortcut');
const dashboardButton = document.querySelector('#open-dashboard');
const settingsButton = document.querySelector('#open-settings');

let currentStatus = null;
let statusKnown = false;
let actionPending = false;
let refreshPending = false;
let nativePromptTimer = null;
let statusSyncTimer = null;
let statusRevision = 0;
let statusRequestEpoch = 0;
let statusPollInFlight = false;
let statusFailureCount = 0;
let lastTerminalSnapshotKey = '';
let lastBackendOperationId = '';
let actionResultGuard = null;
let snapshotRequest = 0;
const loadErrors = new Map();

function nonNegativeInteger(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function normalizeResult(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('清理结果格式无效。');
  }
  const fields = ['closed', 'skipped', 'failed', 'remaining'];
  if (fields.some(field => !Number.isFinite(raw[field]) || raw[field] < 0)) {
    throw new Error('清理结果格式无效。');
  }
  return {
    closed: nonNegativeInteger(raw.closed),
    skipped: nonNegativeInteger(raw.skipped),
    failed: nonNegativeInteger(raw.failed),
    remaining: nonNegativeInteger(raw.remaining),
  };
}

function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object' || !STATUS_STATES.has(raw.state)) {
    throw new Error('后台返回的清理状态无效。');
  }
  if (raw.state === 'done' && (!raw.result || typeof raw.result !== 'object' || Array.isArray(raw.result))) {
    throw new Error('后台返回的清理结果无效。');
  }
  return {
    state: raw.state,
    result: raw.result && typeof raw.result === 'object' ? normalizeResult(raw.result) : null,
    error: typeof raw.error === 'string' ? raw.error : '',
    warning: typeof raw.warning === 'string' ? raw.warning : '',
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
    finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : null,
    origin: typeof raw.origin === 'string' ? raw.origin : '',
    operationId: typeof raw.operationId === 'string' ? raw.operationId : '',
  };
}

function renderLoadErrors() {
  const messages = [...loadErrors.values()];
  loadError.hidden = messages.length === 0;
  loadErrorText.textContent = messages.join(' ');
}

function setLoadError(key, message) {
  if (message) loadErrors.set(key, message);
  else loadErrors.delete(key);
  renderLoadErrors();
}

function updateButtons() {
  const running = currentStatus?.state === 'running';
  cleanupButton.disabled = actionPending || running || !statusKnown;
  cleanupButtonLabel.textContent = actionPending || running ? '正在清理…' : '一键清理重复页';
  refreshButton.disabled = refreshPending;
}

function scheduleStatusSync() {
  clearTimeout(statusSyncTimer);
  statusSyncTimer = null;
  if (statusFailureCount >= 3) return;
  const delay = currentStatus?.state === 'running' || actionPending ? 2000 : 5000;
  statusSyncTimer = setTimeout(async () => {
    statusSyncTimer = null;
    if (statusPollInFlight) {
      scheduleStatusSync();
      return;
    }
    statusPollInFlight = true;
    try {
      await loadCleanupStatus();
    } finally {
      statusPollInFlight = false;
      scheduleStatusSync();
    }
  }, delay);
}

function scheduleNativePromptHint(status) {
  clearTimeout(nativePromptTimer);
  nativePromptTimer = null;
  nativePromptHint.hidden = true;
  if (status.state !== 'running') return;

  const elapsed = status.startedAt ? Math.max(0, Date.now() - status.startedAt) : 0;
  const showHint = () => {
    if (currentStatus?.state === 'running') nativePromptHint.hidden = false;
  };
  if (elapsed >= 5000) showHint();
  else nativePromptTimer = setTimeout(showHint, 5000 - elapsed);
}

function formatFinishedTime(timestamp) {
  if (!timestamp) return '';
  try {
    return ` · ${new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    return '';
  }
}

function renderStatus(status) {
  currentStatus = status;
  cleanupState.dataset.state = status.state;
  operationDetails.hidden = true;
  operationDetails.textContent = '';
  operationStatus.dataset.kind = 'info';

  if (status.state === 'running') {
    cleanupState.textContent = '清理中';
    operationSummary.textContent = '清理正在后台进行，关闭面板也不会中断。';
  } else if (status.state === 'done') {
    const result = normalizeResult(status.result);
    cleanupState.textContent = '已完成';
    operationStatus.dataset.kind = result.failed || result.remaining || status.warning ? 'warning' : 'success';
    if (result.closed === 0 && result.remaining === 0 && result.failed === 0) {
      operationSummary.textContent = `没有需要关闭的重复标签${formatFinishedTime(status.finishedAt)}。`;
    } else if (result.remaining > 0) {
      operationSummary.textContent = `已关闭 ${result.closed} 个；仍有 ${result.remaining} 个额外重复标签被保留。`;
    } else {
      operationSummary.textContent = `已关闭 ${result.closed} 个重复标签${formatFinishedTime(status.finishedAt)}。`;
    }
    operationDetails.textContent = `跳过 ${result.skipped} 个 · 失败 ${result.failed} 个 · 剩余 ${result.remaining} 个`
      + (status.warning ? ` · 提醒：${status.warning}` : '');
    operationDetails.hidden = false;
  } else if (status.state === 'error') {
    cleanupState.textContent = '未完成';
    operationStatus.dataset.kind = 'error';
    operationSummary.textContent = status.error || '清理失败，请手动重试。';
    operationDetails.textContent = '不会自动重试；确认后可再次点击清理。';
    operationDetails.hidden = false;
  } else if (status.state === 'interrupted') {
    cleanupState.textContent = '结果未知';
    operationStatus.dataset.kind = 'warning';
    operationSummary.textContent = '无法确认上次清理结果。';
    operationDetails.textContent = '不会自动运行；你可以显式开始一次新的清理。';
    operationDetails.hidden = false;
  } else {
    cleanupState.textContent = '就绪';
    operationSummary.textContent = '准备好后，点击上方按钮开始清理。';
  }

  scheduleNativePromptHint(status);
  updateButtons();
  scheduleStatusSync();
}

function renderStatusReadFailure(message = '清理状态读取失败，请重新读取。') {
  if (currentStatus?.state === 'done') {
    renderStatus(currentStatus);
    statusKnown = false;
    operationStatus.dataset.kind = 'warning';
    const syncMessage = statusFailureCount >= 3
      ? '显示上次已确认结果；状态同步连续失败，已停止自动同步，请手动重新读取。'
      : '暂时无法同步后台状态；显示上次已确认结果。';
    operationDetails.textContent += ` · 提醒：${syncMessage}`;
    operationDetails.hidden = false;
    setLoadError('status', message);
    updateButtons();
    scheduleStatusSync();
    return;
  }
  statusKnown = false;
  const mayStillBeRunning = currentStatus?.state === 'running' || actionPending;
  if (!mayStillBeRunning) currentStatus = null;
  cleanupState.dataset.state = mayStillBeRunning ? 'interrupted' : 'error';
  cleanupState.textContent = mayStillBeRunning ? '暂无法确认' : '读取失败';
  operationStatus.dataset.kind = mayStillBeRunning ? 'warning' : 'error';
  operationSummary.textContent = mayStillBeRunning
    ? '暂时无法确认后台清理结果。'
    : '未能确认后台是否正在清理。';
  operationDetails.textContent = statusFailureCount >= 3
    ? '连续读取失败，已停止自动同步；请手动重新读取。'
    : '不会自动开始新的清理，正在等待下一次状态同步。';
  operationDetails.hidden = false;
  if (!mayStillBeRunning) scheduleNativePromptHint({ state: 'idle' });
  setLoadError('status', message);
  updateButtons();
  scheduleStatusSync();
}

function terminalSnapshotKey(status) {
  if (status.operationId) return `operation:${status.operationId}`;
  if (status.state === 'done') {
    const result = status.result;
    return `done:${status.finishedAt ?? ''}:${result.closed}:${result.skipped}:${result.failed}:${result.remaining}`;
  }
  return `${status.state}:${status.finishedAt ?? ''}:${status.error}`;
}

async function loadTabSnapshot() {
  const request = ++snapshotRequest;
  try {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    if (request !== snapshotRequest) return;
    const webTabs = tabs.filter(tab => !tab.incognito && isHttpUrl(tab.url));
    const counts = new Map();
    webTabs.forEach(tab => counts.set(tab.url, (counts.get(tab.url) || 0) + 1));
    const extraDuplicates = [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    tabCount.textContent = String(webTabs.length);
    duplicateCount.textContent = String(extraDuplicates);
    snapshotTime.textContent = extraDuplicates
      ? '快照中的重复页不一定都能关闭。'
      : '当前快照没有发现完整网址相同的标签。';
    setLoadError('tabs', '');
  } catch {
    if (request !== snapshotRequest) return;
    tabCount.textContent = '—';
    duplicateCount.textContent = '—';
    snapshotTime.textContent = '未能读取标签快照。';
    setLoadError('tabs', '标签统计读取失败，请重新读取。');
  }
}

async function loadCleanupStatus() {
  const requestRevision = statusRevision;
  const requestEpoch = ++statusRequestEpoch;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_CLEANUP_STATUS' });
    if (requestRevision !== statusRevision || requestEpoch !== statusRequestEpoch) return;
    if (!response?.ok) throw new Error(response?.error || '无法读取清理状态');
    const status = normalizeStatus(response.status);
    const guardedResult = actionResultGuard;
    if (guardedResult) {
      const isNewOperation = Boolean(status.operationId)
        && status.operationId !== guardedResult.baselineOperationId
        && Number.isFinite(status.startedAt)
        && status.startedAt >= guardedResult.startedAt;
      if (!isNewOperation) {
        if (status.operationId) lastBackendOperationId = status.operationId;
        statusFailureCount = 0;
        statusKnown = true;
        setLoadError('status', '');
        updateButtons();
        scheduleStatusSync();
        return;
      }
      actionResultGuard = null;
    }
    if (status.operationId) lastBackendOperationId = status.operationId;
    statusFailureCount = 0;
    statusKnown = true;
    setLoadError('status', '');
    renderStatus(status);
    if (TERMINAL_STATES.has(status.state)) {
      const snapshotKey = terminalSnapshotKey(status);
      if (guardedResult?.snapshotRefreshed) lastTerminalSnapshotKey = snapshotKey;
      if (snapshotKey !== lastTerminalSnapshotKey) {
        lastTerminalSnapshotKey = snapshotKey;
        void loadTabSnapshot();
      }
    }
  } catch {
    if (requestRevision !== statusRevision || requestEpoch !== statusRequestEpoch) return;
    statusFailureCount += 1;
    renderStatusReadFailure();
  }
}

async function loadShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const command = commands.find(item => item.name === 'deduplicate-tabs');
    shortcutValue.textContent = command?.shortcut || '未分配';
    setLoadError('shortcut', '');
  } catch {
    shortcutValue.textContent = '无法读取';
    setLoadError('shortcut', '快捷键读取失败，请重新读取。');
  }
}

async function refreshAll() {
  if (refreshPending) return;
  statusRevision += 1;
  statusFailureCount = 0;
  refreshPending = true;
  updateButtons();
  await Promise.allSettled([loadTabSnapshot(), loadCleanupStatus(), loadShortcut()]);
  refreshPending = false;
  updateButtons();
}

cleanupButton.addEventListener('click', async () => {
  if (cleanupButton.disabled || actionPending || currentStatus?.state === 'running') return;
  const baselineOperationId = lastBackendOperationId;
  const actionStartedAt = Date.now();
  actionResultGuard = null;
  statusRevision += 1;
  statusFailureCount = 0;
  actionPending = true;
  renderStatus({ state: 'running', startedAt: actionStartedAt, origin: 'quick' });
  try {
    const response = await chrome.runtime.sendMessage({ type: 'DEDUPLICATE_TABS' });
    if (!response?.ok) throw new Error(response?.error || '清理失败，请重试。');
    const confirmedStatus = {
      state: 'done',
      result: normalizeResult(response),
      warning: typeof response.warning === 'string' ? response.warning : '',
      finishedAt: Date.now(),
      origin: 'quick',
    };
    statusKnown = true;
    renderStatus(confirmedStatus);
    actionResultGuard = {
      kind: 'confirmed-done',
      baselineOperationId,
      startedAt: actionStartedAt,
      snapshotRefreshed: true,
    };
    await loadTabSnapshot();
    await loadCleanupStatus();
  } catch (error) {
    statusKnown = true;
    renderStatus({ state: 'error', error: error.message || '清理失败，请重试。', finishedAt: Date.now(), origin: 'quick' });
    actionResultGuard = {
      kind: 'send-failed',
      baselineOperationId,
      startedAt: actionStartedAt,
      snapshotRefreshed: false,
    };
    await loadCleanupStatus();
  } finally {
    actionPending = false;
    updateButtons();
    scheduleStatusSync();
  }
});

refreshButton.addEventListener('click', refreshAll);
retryLoadButton.addEventListener('click', refreshAll);

dashboardButton.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }).catch(() => {});
});

settingsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage().catch(() => {});
});

editShortcutButton.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'session' || !Object.hasOwn(changes, STATUS_KEY)) return;
  statusRevision += 1;
  void loadCleanupStatus();
});

refreshAll();
