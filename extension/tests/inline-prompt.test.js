import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SCRIPT = readFileSync(new URL('../inline-prompt.js', import.meta.url), 'utf8');
const PAGE_URL = 'https://example.test/article?q=1#part';
const settle = async () => {
  for (let index = 0; index < 3; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

class MockClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
}

class MockElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.isConnected = false;
    this.className = '';
    this.classList = new MockClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {} };
    this.textContent = '';
    this.disabled = false;
    this.shadow = null;
  }

  setConnected(connected) {
    this.isConnected = connected;
    this.shadow?.setConnected(connected);
    this.children.forEach(child => child.setConnected?.(connected));
  }

  append(...children) {
    children.forEach(child => {
      this.children.push(child);
      child.parentNode = this;
      child.setConnected?.(this.isConnected);
    });
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    }
    this.parentNode = null;
    this.setConnected(false);
  }

  setAttribute(name, value) { this.attributes.set(name, value); }

  attachShadow() {
    this.shadow = new MockElement('shadow-root');
    this.shadow.setConnected(this.isConnected);
    return this.shadow;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== listener));
    },
    emit(type, event = {}) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
  };
}

function findClass(root, className) {
  if (String(root.className).split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const found = findClass(child, className);
    if (found) return found;
  }
  return null;
}

function fixture({ hasDOM = true } = {}) {
  const documentEvents = eventTarget();
  const windowEvents = eventTarget();
  const documentElement = hasDOM ? new MockElement('html') : null;
  documentElement?.setConnected(true);
  const document = {
    documentElement,
    createElement: tagName => new MockElement(tagName),
    addEventListener: documentEvents.addEventListener,
    removeEventListener: documentEvents.removeEventListener,
  };
  const location = { href: PAGE_URL };
  const state = {
    sent: [],
    switchGates: [],
    sendMode: 'pending',
    runtimeListeners: [],
  };
  const chrome = {
    runtime: {
      id: 'extension-id',
      onMessage: {
        addListener(listener) { state.runtimeListeners.push(listener); },
      },
      sendMessage(message) {
        state.sent.push(message);
        if (message.choice === 'keep') return Promise.resolve({ ok: true, action: 'kept' });
        if (state.sendMode === 'invalid-runtime') {
          return Promise.reject(new Error('Extension context invalidated.'));
        }
        if (state.sendMode === 'invalid-token') {
          return Promise.resolve({ ok: false, error: '这个页内提醒已失效。' });
        }
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        state.switchGates.push({ promise, resolve });
        return promise;
      },
    },
  };
  const context = {
    chrome,
    document,
    location,
    URL: globalThis.URL,
    Promise,
    console,
    setImmediate,
    addEventListener: windowEvents.addEventListener,
  };
  context.globalThis = context;
  context.top = context;
  vm.createContext(context);

  const run = () => vm.runInContext(SCRIPT, context);
  const dispatch = message => {
    let response;
    const listener = state.runtimeListeners[0];
    assert.equal(typeof listener, 'function');
    listener(message, { id: 'extension-id' }, value => { response = value; });
    return response;
  };
  const show = (token, overrides = {}) => dispatch({
    type: 'INLINE_DUPLICATE_SHOW',
    token,
    url: location.href,
    title: '测试页面',
    count: 2,
    ...overrides,
  });
  const ping = () => dispatch({ type: 'INLINE_DUPLICATE_PING' });
  const host = () => documentElement?.children.find(child => child.tagName === 'prefix-tab-groups-inline-prompt');
  const control = className => findClass(host().shadow, className);

  return {
    chrome,
    context,
    documentEvents,
    windowEvents,
    location,
    state,
    run,
    dispatch,
    show,
    ping,
    host,
    control,
  };
}

test('只有可信点击和Escape能选择，switch防连点且在途仍可X或保留', async () => {
  const page = fixture();
  page.run();

  assert.deepEqual({ ...page.show('token-click') }, { shown: true });
  const originalHost = page.host();
  page.control('switch').emit('click', { isTrusted: false });
  page.control('keep').emit('click', { isTrusted: false });
  page.control('close').emit('click', { isTrusted: false });
  page.documentEvents.emit('keydown', { isTrusted: false, key: 'Escape' });
  assert.equal(page.state.sent.length, 0);
  assert.equal(originalHost.isConnected, true);

  page.control('switch').emit('click', { isTrusted: true });
  assert.deepEqual({ ...page.show('token-click') }, { shown: true });
  assert.equal(page.host(), originalHost);
  assert.equal(page.control('switch').disabled, true);
  page.control('switch').emit('click', { isTrusted: true });
  assert.equal(page.state.sent.filter(message => message.choice === 'switch').length, 1);
  assert.equal(page.control('switch').disabled, true);
  assert.equal(page.control('close').disabled, false);
  page.control('close').emit('click', { isTrusted: true });
  assert.equal(originalHost.isConnected, false);
  assert.equal(page.state.sent.filter(message => message.choice === 'keep').length, 1);
  page.state.switchGates[0].resolve({ ok: true, action: 'switched', closed: false });
  await settle();

  assert.deepEqual({ ...page.show('token-keep') }, { shown: true });
  const keepHost = page.host();
  page.control('switch').emit('click', { isTrusted: true });
  page.control('keep').emit('click', { isTrusted: true });
  assert.equal(keepHost.isConnected, false);
  assert.equal(page.state.sent.filter(message => message.choice === 'keep').length, 2);
  page.state.switchGates[1].resolve({ ok: true, action: 'switched', closed: false });
  await settle();

  assert.deepEqual({ ...page.show('token-escape') }, { shown: true });
  const escapeHost = page.host();
  page.documentEvents.emit('keydown', { isTrusted: false, key: 'Escape' });
  assert.equal(escapeHost.isConnected, true);
  page.documentEvents.emit('keydown', { isTrusted: true, key: 'Escape' });
  assert.equal(escapeHost.isConnected, false);
  assert.equal(page.state.sent.filter(message => message.choice === 'keep').length, 3);
});

test('SPA地址变化、pagehide与失效runtime只撤下提示，不执行过期选择', async () => {
  const spa = fixture();
  spa.run();
  spa.show('token-spa');
  const spaHost = spa.host();
  spa.location.href = 'https://example.test/other';
  spa.control('switch').emit('click', { isTrusted: true });
  assert.equal(spaHost.isConnected, false);
  assert.equal(spa.state.sent.length, 0);
  assert.equal(spa.ping().token, null);

  const unloaded = fixture();
  unloaded.run();
  unloaded.show('token-pagehide');
  const unloadedHost = unloaded.host();
  unloaded.windowEvents.emit('pagehide', { isTrusted: true });
  assert.equal(unloadedHost.isConnected, false);
  assert.equal(unloaded.ping().token, null);
  assert.deepEqual({ ...unloaded.show('token-after-pagehide') }, { shown: false, ready: false });

  const missingRuntime = fixture();
  missingRuntime.run();
  missingRuntime.show('token-no-runtime');
  const missingRuntimeHost = missingRuntime.host();
  missingRuntime.chrome.runtime.id = undefined;
  missingRuntime.control('switch').emit('click', { isTrusted: true });
  assert.equal(missingRuntimeHost.isConnected, false);
  assert.equal(missingRuntime.state.sent.length, 0);

  for (const mode of ['invalid-runtime', 'invalid-token']) {
    const failed = fixture();
    failed.state.sendMode = mode;
    failed.run();
    failed.show(`token-${mode}`);
    const failedHost = failed.host();
    failed.control('switch').emit('click', { isTrusted: true });
    await settle();
    assert.equal(failedHost.isConnected, false);
    assert.equal(failed.ping().token, null);
  }
});

test('无DOM安全返回；重复注入与SHOW幂等，PING/HIDE只反映当前token', () => {
  const empty = fixture({ hasDOM: false });
  assert.deepEqual({ ...empty.run() }, { url: PAGE_URL, ready: false });
  assert.deepEqual({ ...empty.show('token-no-dom') }, { shown: false, ready: false });
  empty.run();
  assert.equal(empty.state.runtimeListeners.length, 1);

  const page = fixture();
  assert.deepEqual({ ...page.run() }, { url: PAGE_URL, ready: true });
  page.run();
  assert.equal(page.state.runtimeListeners.length, 1);
  assert.deepEqual({ ...page.show('token-current') }, { shown: true });
  const firstHost = page.host();
  assert.deepEqual({ ...page.show('token-current') }, { shown: true });
  assert.equal(page.host(), firstHost);
  assert.deepEqual({ ...page.ping() }, { token: 'token-current', url: PAGE_URL });

  assert.deepEqual({ ...page.dispatch({ type: 'INLINE_DUPLICATE_HIDE', token: 'token-other' }) }, { hidden: false });
  assert.equal(firstHost.isConnected, true);
  assert.deepEqual({ ...page.dispatch({ type: 'INLINE_DUPLICATE_HIDE', token: 'token-current' }) }, { hidden: true });
  assert.equal(firstHost.isConnected, false);
  assert.deepEqual({ ...page.ping() }, { token: null, url: PAGE_URL });
});

test('暂停本站按钮可信点击后立即撤下并沿用INLINE_DUPLICATE_CHOOSE协议，主题密度来自消息', () => {
  const page = fixture();
  page.run();
  page.show('token-pause', { preferences: { theme: 'dark', density: 'compact' } });
  assert.match(page.control('card').className, /dark/);
  assert.match(page.control('card').className, /compact/);
  const host = page.host();
  page.control('pause').emit('click', { isTrusted: false });
  assert.equal(host.isConnected, true);
  page.control('pause').emit('click', { isTrusted: true });
  assert.equal(host.isConnected, false);
  assert.deepEqual(page.state.sent.map(message => ({ ...message })), [{
    type: 'INLINE_DUPLICATE_CHOOSE', token: 'token-pause', choice: 'pause-site',
  }]);
});
