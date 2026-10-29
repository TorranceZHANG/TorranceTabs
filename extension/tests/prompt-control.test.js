import test from 'node:test';
import assert from 'node:assert/strict';
import { initializePromptControl } from '../prompt-control.js';

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ granted = true, settings = { enabled: false, rules: [] } } = {}) {
  const elements = new Map();
  for (const id of ['duplicate-prompt-toggle', 'duplicate-prompt-value', 'duplicate-prompt-status', 'duplicate-prompt-settings', 'refresh-data']) {
    elements.set(`#${id}`, { dataset: {}, attributes: {}, listeners: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, listener) { this.listeners[type] = listener; } });
  }
  const changed = [];
  const state = { settings, granted, calls: [] };
  const api = {
    storage: { local: { async get() { return { settings: structuredClone(state.settings) }; } },
      onChanged: { addListener(fn) { changed.push(fn); } } },
    permissions: { async contains() { return state.granted; } },
    runtime: {
      async sendMessage(message) {
        state.calls.push(message);
        if (state.send) return state.send(message);
        state.settings.duplicatePromptEnabled = message.enabled;
        changed.forEach(fn => fn({ settings: { newValue: state.settings } }, 'local'));
        return { ok: true, settings: state.settings };
      },
      async openOptionsPage() { state.openedSettings = true; },
    },
  };
  return { state, elements, changed, start: () => initializePromptControl(api, { querySelector: id => elements.get(id) }),
    click: id => elements.get(`#${id}`).listeners.click(), element: id => elements.get(`#${id}`) };
}

test('旧配置默认显示开启，快捷开关即时持久化且不包含过期的整份分组配置', async () => {
  const ui = fixture();
  await ui.start();
  assert.equal(ui.element('duplicate-prompt-toggle').attributes['aria-checked'], 'true');
  await ui.click('duplicate-prompt-toggle');
  assert.deepEqual(ui.state.calls, [{ type: 'DUPLICATE_PROMPT_SET_ENABLED', enabled: false }]);
  assert.equal(ui.element('duplicate-prompt-toggle').attributes['aria-checked'], 'false');
  assert.match(ui.element('duplicate-prompt-status').textContent, /已关闭/);
  await ui.click('duplicate-prompt-toggle');
  assert.equal(ui.state.settings.duplicatePromptEnabled, true);
});

test('未授权说明可见，开关不隐式请求权限，手动设置与外部更改可用', async () => {
  const ui = fixture({ granted: false });
  await ui.start();
  assert.match(ui.element('duplicate-prompt-status').textContent, /需在设置中授权/);
  assert.equal(ui.element('duplicate-prompt-settings').textContent, '去授权');
  await ui.click('duplicate-prompt-settings');
  assert.equal(ui.state.openedSettings, true);
  ui.state.settings.duplicatePromptEnabled = false;
  ui.changed.forEach(fn => fn({ settings: {} }, 'local'));
  await settle();
  assert.equal(ui.element('duplicate-prompt-toggle').attributes['aria-checked'], 'false');
});

test('在途保存阻止双击，保存失败保留真实状态并可重试', async () => {
  const ui = fixture();
  await ui.start();
  let reject;
  ui.state.send = () => new Promise((_, fail) => { reject = fail; });
  const saving = ui.click('duplicate-prompt-toggle');
  assert.equal(ui.element('duplicate-prompt-toggle').disabled, true);
  await ui.click('duplicate-prompt-toggle');
  assert.equal(ui.state.calls.length, 1);
  reject(Error('worker unavailable'));
  await saving;
  assert.equal(ui.element('duplicate-prompt-toggle').attributes['aria-checked'], 'true');
  assert.equal(ui.element('duplicate-prompt-toggle').disabled, false);
  assert.match(ui.element('duplicate-prompt-status').textContent, /未能确认保存结果/);
  delete ui.state.send;
  await ui.click('duplicate-prompt-toggle');
  assert.equal(ui.element('duplicate-prompt-toggle').attributes['aria-checked'], 'false');
});
