import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const cleanupScript = readFileSync(new URL('../cleanup-page.js', import.meta.url), 'utf8');
const toolsScript = readFileSync(new URL('../tools-enhancements.js', import.meta.url), 'utf8')
  .replace("import { confirmAction } from './ui-dialog.js';", 'const confirmAction = globalThis.confirmAction;')
  .replaceAll('export async function ', 'async function ')
  .replaceAll('export function ', 'function ');
const appearanceScript = readFileSync(new URL('../appearance.js', import.meta.url), 'utf8')
  .replace("import { DEFAULT_PREFERENCES, validatePreferences } from './preferences.js';",
    'const { DEFAULT_PREFERENCES, validatePreferences } = globalThis.preferenceModule;');

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve));
};

function gate() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class Element {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.isConnected = true;
    this.parentElement = null;
    this.type = '';
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  async dispatch(type) {
    if (type === 'click' && this.disabled) return;
    for (const listener of this.listeners.get(type) || []) await listener({ currentTarget: this, target: this, isTrusted: true });
  }

  click() { return this.dispatch('click'); }

  append(...nodes) {
    for (const child of nodes) {
      if (typeof child === 'string') { this.children.push(child); continue; }
      child.parentElement = this;
      this.children.push(child);
      if (this.tagName === 'SELECT' && !this.value && child.tagName === 'OPTION') this.value = child.value;
    }
  }

  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this[name] = value; }
  focus() {}
  get options() { return this.children.filter(child => child?.tagName === 'OPTION'); }
  get selectedOptions() { return this.options.filter(option => option.value === this.value).slice(0, 1); }
  querySelector(selector) {
    if (selector === 'input') return this.children.find(child => child?.tagName === 'INPUT') || null;
    if (selector === 'select') return this.children.find(child => child?.tagName === 'SELECT') || null;
    if (selector.startsWith('.')) return walk(this).find(child => child.className.split(/\s+/).includes(selector.slice(1))) || null;
    return null;
  }
}

function walk(root) {
  const result = [];
  for (const child of root.children || []) if (typeof child !== 'string') { result.push(child); result.push(...walk(child)); }
  return result;
}

function documentFixture(ids = []) {
  const elements = Object.fromEntries(ids.map(id => [id, new Element('div', id)]));
  const body = new Element('body', 'body');
  const documentElement = new Element('html', 'html');
  const named = [];
  const classes = new Map();
  const document = {
    body,
    documentElement,
    activeElement: body,
    createElement(tag) { return new Element(tag); },
    querySelector(selector) {
      if (selector.startsWith('#')) return elements[selector.slice(1)] || null;
      if (selector.startsWith('.')) return classes.get(selector.slice(1)) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-preference]') return walk(body).filter(node => node.dataset.preference);
      if (selector === '[name=sync-section]:checked') return named.filter(node => node.name === 'sync-section' && node.checked);
      if (selector === '[name=sync-section],#sync-device') return [...named.filter(node => node.name === 'sync-section'), elements['sync-device']];
      if (selector === '.duplicate-choice') return [];
      if (selector.startsWith('#cleanup-scope')) return [elements['cleanup-scope'], elements['cleanup-window'], elements['cleanup-group'], elements['preview-cleanup']];
      return [];
    },
  };
  return { document, elements, body, documentElement, named, classes };
}

test('cleanup延迟预览返回前改变范围会作废旧token并保持执行按钮禁用', async () => {
  const dom = documentFixture(['cleanup-scope', 'cleanup-window', 'cleanup-group', 'execute-cleanup', 'cleanup-preview',
    'preview-cleanup', 'cleanup-status', 'window-field', 'group-field', 'duplicate-allowlist', 'save-allowlist', 'policy-status']);
  Object.assign(dom.elements['cleanup-scope'], { tagName: 'SELECT', value: 'window' });
  Object.assign(dom.elements['cleanup-window'], { tagName: 'SELECT', value: '1' });
  Object.assign(dom.elements['cleanup-group'], { tagName: 'SELECT', value: '7' });
  dom.elements['execute-cleanup'].disabled = true;
  const previewGate = gate();
  const calls = [];
  const chrome = {
    runtime: { async sendMessage(message) {
      calls.push(message);
      if (message.type === 'DUPLICATE_POLICY_GET') return { ok: true, allowlist: [] };
      if (message.type === 'DEDUPLICATE_PREVIEW') return previewGate.promise;
      return { ok: true };
    } },
    windows: { async getAll() { return [{ id: 1, incognito: false }]; } },
    tabGroups: { async query() { return []; } },
    storage: { onChanged: { addListener() {} } },
  };
  const context = { chrome, document: dom.document, console, URL, Promise, Object, Set, Map, Number, Error, structuredClone };
  vm.createContext(context);
  vm.runInContext(cleanupScript, context);
  await settle();

  const pending = dom.elements['preview-cleanup'].click();
  await settle();
  assert.equal(calls.filter(call => call.type === 'DEDUPLICATE_PREVIEW').length, 1);
  dom.elements['cleanup-window'].value = '2';
  await dom.elements['cleanup-window'].dispatch('change');
  previewGate.resolve({ ok: true, token: 'stale-token', buckets: [{ id: 'bucket', tabs: [{ id: 1, windowId: 1, url: 'https://a.test/' }] }] });
  await pending;

  assert.equal(dom.elements['execute-cleanup'].disabled, true);
  assert.equal(dom.elements['cleanup-preview'].children[0].textContent, '范围已变化，请重新预览。');
  await dom.elements['execute-cleanup'].click();
  assert.equal(calls.some(call => call.type === 'DEDUPLICATE_EXECUTE'), false);
});

function toolsFixture() {
  const ids = ['snapshots', 'sync-refresh', 'save-snapshot-config', 'capture-snapshot', 'sync-enabled', 'sync-device',
    'sync-upload', 'sync-preview', 'sync-apply', 'sync-state', 'snapshots-enabled', 'snapshot-interval',
    'snapshot-retention', 'snapshot-list', 'sync-result', 'sync-preview-result', 'enhancement-status'];
  const dom = documentFixture(ids);
  for (const id of ['sync-device', 'snapshot-interval', 'snapshot-retention']) dom.elements[id].tagName = 'SELECT';
  dom.elements['sync-apply'].disabled = true;
  const rules = new Element('input'); rules.name = 'sync-section'; rules.value = 'rules'; rules.checked = true;
  const preferences = new Element('input'); preferences.name = 'sync-section'; preferences.value = 'preferences';
  dom.named.push(rules, preferences);
  const previewGate = gate();
  const calls = [];
  const chrome = { runtime: { async sendMessage(message) {
    calls.push(message);
    if (message.type === 'SNAPSHOT_GET') return { ok: true, config: { enabled: false, intervalMinutes: 30, retention: 5 }, snapshots: [] };
    if (message.type === 'SYNC_GET') return { ok: true, config: { enabled: true }, deviceId: 'a', remoteDigest: null,
      devices: [{ deviceId: 'a', updatedAt: 1, sections: ['rules'], revision: 1 },
        { deviceId: 'b', updatedAt: 2, sections: ['rules', 'preferences'], revision: 1 }] };
    if (message.type === 'SYNC_PREVIEW') return previewGate.promise;
    return { ok: true };
  } }, windows: { async getCurrent() { return { id: 1 }; } } };
  const context = { chrome, document: dom.document, confirmAction: async () => true, console, Date, JSON, Promise, Object,
    Set, Map, Number, Error, structuredClone };
  vm.createContext(context);
  vm.runInContext(toolsScript, context);
  return { dom, rules, preferences, previewGate, calls };
}

test('sync延迟预览期间改变section和device，旧响应不能启用应用', async () => {
  const value = toolsFixture();
  await settle();
  assert.equal(value.dom.elements['sync-preview'].disabled, false);
  value.dom.elements['sync-device'].value = 'a';
  const pending = value.dom.elements['sync-preview'].click();
  await settle();
  assert.equal(value.calls.filter(call => call.type === 'SYNC_PREVIEW').length, 1);

  value.rules.checked = false;
  value.preferences.checked = true;
  await value.preferences.dispatch('change');
  value.dom.elements['sync-device'].value = 'b';
  await value.dom.elements['sync-device'].dispatch('change');
  value.previewGate.resolve({ ok: true, token: 'stale-sync-token', changes: { rules: true }, remote: { rules: [] } });
  await pending;

  assert.equal(value.dom.elements['sync-apply'].disabled, true);
  assert.equal(value.dom.elements['sync-preview-result'].children.length, 0);
  await value.dom.elements['sync-apply'].click();
  assert.equal(value.calls.some(call => call.type === 'SYNC_APPLY'), false);
});

test('appearance保存期间锁定两个控件，第二次change不会发送旧主题全对象', async () => {
  const dom = documentFixture([]);
  const sidebar = new Element('aside');
  dom.classes.set('app-sidebar', sidebar);
  dom.body.append(sidebar);
  const saveGate = gate();
  const calls = [];
  const chrome = {
    storage: { local: { async get() { return { preferences: { theme: 'system', density: 'comfortable' } }; } },
      onChanged: { addListener() {} } },
    runtime: { async sendMessage(message) { calls.push(structuredClone(message)); return saveGate.promise; } },
  };
  const preferenceModule = {
    DEFAULT_PREFERENCES: { theme: 'system', density: 'comfortable' },
    validatePreferences(value) {
      if (!['system', 'light', 'dark'].includes(value.theme) || !['comfortable', 'compact'].includes(value.density)) throw Error('invalid');
      return { theme: value.theme, density: value.density };
    },
  };
  const context = { chrome, document: dom.document, preferenceModule, console, Promise, Object, Error, structuredClone };
  vm.createContext(context);
  vm.runInContext(appearanceScript, context);
  await settle();
  const controls = dom.document.querySelectorAll('[data-preference]');
  assert.equal(controls.length, 2);
  const theme = controls.find(control => control.dataset.preference === 'theme');
  const density = controls.find(control => control.dataset.preference === 'density');

  theme.value = 'dark';
  const pendingTheme = theme.dispatch('change');
  await settle();
  assert.equal(theme.disabled, true);
  assert.equal(density.disabled, true);
  density.value = 'compact';
  await density.dispatch('change');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { type: 'PREFERENCES_SAVE', preferences: { theme: 'dark', density: 'comfortable' } });
  assert.equal(density.value, 'comfortable');

  saveGate.resolve({ ok: true, preferences: { theme: 'dark', density: 'comfortable' } });
  await pendingTheme;
  assert.equal(theme.disabled, false);
  assert.equal(density.disabled, false);
  assert.equal(dom.documentElement.dataset.theme, 'dark');
  assert.equal(dom.documentElement.dataset.density, 'comfortable');
});
