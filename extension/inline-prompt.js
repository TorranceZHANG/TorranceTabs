(() => {
  const STATE_KEY = '__prefixTabGroupsInlinePromptState__';
  const result = { url: location.href, ready: Boolean(document.documentElement) };

  if (globalThis[STATE_KEY]) return result;

  const state = { active: null, invalid: false };
  globalThis[STATE_KEY] = state;

  function runtimeId() {
    try {
      return typeof chrome !== 'undefined' && chrome.runtime?.id
        ? chrome.runtime.id
        : null;
    } catch {
      return null;
    }
  }

  function httpUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url : null;
    } catch {
      return null;
    }
  }

  function validSender(sender) {
    const id = runtimeId();
    return Boolean(id) && sender?.id === id && globalThis.top === globalThis;
  }

  function validToken(token) {
    return typeof token === 'string' && token.length > 0 && token.length <= 512;
  }

  function currentActive() {
    if (state.active && !state.active.host.isConnected) {
      document.removeEventListener('keydown', state.active.escapeHandler, true);
      state.active = null;
    }
    return state.active;
  }

  function removePrompt(token) {
    const active = currentActive();
    if (!active || (token && active.token !== token)) return false;
    document.removeEventListener('keydown', active.escapeHandler, true);
    active.host.remove();
    state.active = null;
    return true;
  }

  function notifyChoice(token, choice) {
    if (!runtimeId()) return;
    try {
      const request = chrome.runtime.sendMessage({
        type: 'INLINE_DUPLICATE_CHOOSE',
        token,
        choice,
      });
      if (request?.catch) request.catch(() => {});
    } catch {
      // The overlay is already gone; the backend cleans stale state later.
    }
  }

  const notifyKeep = token => notifyChoice(token, 'keep');

  function keepAndRemove(active) {
    if (currentActive() !== active) return;
    const { token } = active;
    removePrompt(token);
    notifyKeep(token);
  }

  function pauseAndRemove(active) {
    if (currentActive() !== active) return;
    const { token } = active;
    removePrompt(token);
    notifyChoice(token, 'pause-site');
  }

  function terminalCommunicationFailure(error) {
    if (!runtimeId()) return true;
    const message = String(error?.message || error || '');
    return /Extension context invalidated|Receiving end does not exist|Could not establish connection/i.test(message)
      || /(?:页内提醒|提醒|token).*(?:失效|无效|过期|不存在)/i.test(message)
      || /(?:失效|无效|过期|不存在).*(?:页内提醒|提醒|token)/i.test(message)
      || /权限已撤销|页内提醒已关闭/i.test(message);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildPrompt(message) {
    const rawCount = Number(message.count);
    const duplicateCount = Number.isFinite(rawCount) ? Math.max(1, Math.floor(rawCount)) : 1;
    const host = document.createElement('prefix-tab-groups-inline-prompt');
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('top', '14px', 'important');
    host.style.setProperty('right', '14px', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('width', 'min(360px, calc(100vw - 28px))', 'important');
    host.style.setProperty('max-width', '360px', 'important');
    const theme = ['light', 'dark'].includes(message.preferences?.theme) ? message.preferences.theme : 'system';
    const density = message.preferences?.density === 'compact' ? 'compact' : 'comfortable';
    host.style.setProperty('color-scheme', theme === 'system' ? 'light dark' : theme, 'important');
    host.style.setProperty('contain', 'layout style', 'important');

    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { --bg:#fff;--surface:#f7f9f8;--text:#172a28;--muted:#586c68;--border:#dce5e2;--soft:#edf3f0;display:block!important;box-sizing:border-box!important;color:var(--text)!important;font-family:"Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif!important;line-height:1.5!important;text-align:left!important;-webkit-font-smoothing:antialiased; }
      *,*::before,*::after{box-sizing:border-box}
      .card{overflow-y:auto;max-height:calc(100dvh - 28px);border:1px solid var(--border);border-radius:12px;padding:18px;background:var(--bg);box-shadow:0 4px 12px #172a280a,0 16px 48px #172a2824;color:var(--text);overscroll-behavior:contain}.card.compact{padding:12px}.card.compact .target{margin-top:10px;padding:8px 10px}.card.compact .status,.card.compact .actions{margin-top:8px}
      .header{display:flex;align-items:flex-start;gap:10px}.mark{position:relative;display:block;flex:0 0 auto;width:30px;height:30px;border-radius:8px;background:#087f6c;color:transparent;font-size:0}.mark::before,.mark::after{content:"";position:absolute;width:14px;height:11px;border:1.5px solid white;border-radius:3px}.mark::before{top:7px;left:6px;opacity:.65}.mark::after{top:11px;left:10px;background:#087f6c}.heading{min-width:0;flex:1}.title{margin:0;color:var(--text);font-size:14px;font-weight:650;line-height:1.4}.subtitle{margin:4px 0 0;color:var(--muted);font-size:11px;line-height:1.6}
      button{margin:0;font:inherit;text-transform:none;cursor:pointer;transition:background-color 140ms,border-color 140ms;touch-action:manipulation}button:focus-visible{outline:2px solid #18a58d;outline-offset:3px}button:disabled{cursor:not-allowed;opacity:.5}.close{display:grid;flex:0 0 auto;place-items:center;width:28px;height:28px;border:0;border-radius:6px;padding:0;background:transparent;color:var(--muted);font-size:19px;line-height:1}.close:hover{background:var(--soft);color:var(--text)}
      .target{margin-top:16px;padding:11px 12px;border-left:2px solid #91ada3;border-radius:0 6px 6px 0;background:var(--surface)}.target-title{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550;line-height:1.5;color:var(--text)}.url{max-height:44px;margin:4px 0 0;overflow:auto;overflow-wrap:anywhere;color:var(--muted);font-size:10px;scrollbar-width:thin}.count{margin:8px 0 0;color:#0d9b82;font-size:10px;font-weight:500}.status{margin:12px 0 0;color:var(--muted);font-size:10px;line-height:1.7}.status.error{padding:8px;border-radius:6px;background:#fff0ef;color:#b53632}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.action{min-height:36px;border-radius:7px;padding:8px;font-size:12px;font-weight:550}.switch{border:1px solid #087f6c;background:#087f6c;color:white}.switch:hover:not(:disabled){border-color:#066957;background:#066957}.keep,.pause{border:1px solid #91ada3;background:var(--bg);color:var(--text)}.keep:hover:not(:disabled),.pause:hover:not(:disabled){background:var(--soft)}.pause{grid-column:1/-1;min-height:30px;font-size:11px}@media(max-width:360px){.actions{grid-template-columns:1fr}}@media(prefers-color-scheme:dark){.card.system{--bg:#15201f;--surface:#1d2b29;--text:#eef6f3;--muted:#adbfba;--border:#354a46;--soft:#263936}.status.error{background:#442724;color:#ffb4ac}}.card.dark{--bg:#15201f;--surface:#1d2b29;--text:#eef6f3;--muted:#adbfba;--border:#354a46;--soft:#263936}.card.light{--bg:#fff;--surface:#f7f9f8;--text:#172a28;--muted:#586c68;--border:#dce5e2;--soft:#edf3f0}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important}}
    `;

    const card = element('section', `card ${theme} ${density}`);
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', '重复链接提醒');

    const header = element('div', 'header');
    const mark = element('span', 'mark', '↗');
    mark.setAttribute('aria-hidden', 'true');
    const heading = element('div', 'heading');
    heading.append(
      element('p', 'title', '链接已打开'),
      element('p', 'subtitle', '按当前去重规则，这个网址已在其他标签页中打开。'),
    );
    const close = element('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭并保留新标签');
    close.title = '关闭并保留新标签';
    header.append(mark, heading, close);

    const target = element('div', 'target');
    target.append(
      element('p', 'target-title', typeof message.title === 'string' && message.title.trim()
        ? message.title.trim() : message.url),
      element('p', 'url', message.url),
      element('p', 'count', `已找到 ${duplicateCount} 个相同标签`),
    );

    const status = element('p', 'status', '请选择跳转到已打开的标签，或保留这个新标签。');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const actions = element('div', 'actions');
    const switchButton = element('button', 'action switch', '跳转到已打开');
    switchButton.type = 'button';
    const keepButton = element('button', 'action keep', '保留新标签');
    keepButton.type = 'button';
    const pauseButton = element('button', 'action pause', '暂停本站提醒 30 分钟');
    pauseButton.type = 'button';
    actions.append(switchButton, keepButton, pauseButton);
    card.append(header, target, status, actions);
    shadow.append(style, card);

    const active = {
      token: message.token,
      url: message.url,
      host,
      status,
      switchButton,
      keepButton,
      pauseButton,
      closeButton: close,
      busy: false,
      escapeHandler: null,
    };

    function handleFailure(error) {
      if (currentActive() !== active) return;
      if (terminalCommunicationFailure(error)) {
        removePrompt(active.token);
        return;
      }
      active.busy = false;
      switchButton.disabled = false;
      switchButton.textContent = '重试跳转';
      status.textContent = '未能跳转。你可以重试或保留新标签。';
      status.classList.add('error');
    }

    switchButton.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      if (active.busy || currentActive() !== active) return;
      if (location.href !== active.url || !httpUrl(location.href)) {
        removePrompt(active.token);
        return;
      }
      if (!runtimeId()) {
        removePrompt(active.token);
        return;
      }
      active.busy = true;
      switchButton.disabled = true;
      switchButton.textContent = '正在跳转…';
      status.textContent = '正在切换到已打开的标签…';
      status.classList.remove('error');

      let request;
      try {
        request = chrome.runtime.sendMessage({
          type: 'INLINE_DUPLICATE_CHOOSE',
          token: active.token,
          choice: 'switch',
        });
      } catch (error) {
        handleFailure(error);
        return;
      }
      Promise.resolve(request)
        .then((response) => {
          if (!response?.ok) throw new Error(response?.error || '未能跳转');
          if (response.closed === false) {
            throw new Error('已有标签已定位，但新标签未能关闭。你可以重试或保留新标签');
          }
          removePrompt(active.token);
        })
        .catch(handleFailure);
    });

    keepButton.addEventListener('click', (event) => {
      if (event.isTrusted) keepAndRemove(active);
    });
    pauseButton.addEventListener('click', (event) => {
      if (event.isTrusted) pauseAndRemove(active);
    });
    close.addEventListener('click', (event) => {
      if (event.isTrusted) keepAndRemove(active);
    });
    active.escapeHandler = (event) => {
      if (event.isTrusted && event.key === 'Escape') keepAndRemove(active);
    };

    return active;
  }

  function showPrompt(message) {
    if (state.invalid
      || !document.documentElement
      || !validToken(message.token)
      || !httpUrl(location.href)
      || message.url !== location.href) {
      return { shown: false, ready: false };
    }

    const existing = currentActive();
    if (existing?.token === message.token) return { shown: true };
    if (existing) {
      const oldToken = existing.token;
      removePrompt(oldToken);
      notifyKeep(oldToken);
    }

    const active = buildPrompt(message);
    state.active = active;
    document.documentElement.append(active.host);
    document.addEventListener('keydown', active.escapeHandler, true);
    return { shown: true };
  }

  globalThis.addEventListener('pagehide', () => {
    state.invalid = true;
    removePrompt();
  }, { once: true });

  if (globalThis.top === globalThis) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!validSender(sender) || !message || typeof message !== 'object') return false;

      if (message.type === 'INLINE_DUPLICATE_SHOW') {
        sendResponse(showPrompt(message));
        return false;
      }
      if (message.type === 'INLINE_DUPLICATE_HIDE') {
        sendResponse({ hidden: validToken(message.token) && removePrompt(message.token) });
        return false;
      }
      if (message.type === 'INLINE_DUPLICATE_PING') {
        const active = state.invalid ? null : currentActive();
        sendResponse({ token: active?.token ?? null, url: location.href });
        return false;
      }
      return false;
    });
  }

  return result;
})();
