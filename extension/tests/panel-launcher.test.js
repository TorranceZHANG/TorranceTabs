import test from 'node:test';
import assert from 'node:assert/strict';
import { launchPanel } from '../panel-launcher.js';
function fixture(sidePanel) {
  const calls = [];
  return { calls, api: { sidePanel, runtime: { getURL: path => `chrome-extension://test/${path}` },
    tabs: { create: async values => calls.push(values) }, permissions: { request: async () => true } } };
}
test('不支持侧栏或打开失败时在新标签打开看板', async () => {
  for (const panel of [undefined, { open: async () => { throw Error('not supported'); } }]) {
    const { api, calls } = fixture(panel);
    assert.equal((await launchPanel(api, { windowId: 1, granted: true })).action, 'dashboard');
    assert.deepEqual(calls, [{ url: 'chrome-extension://test/dashboard.html' }]);
  }
});
test('首次授权只配置，下一次明确点击才打开；配置失败也降级', async () => {
  let opened = 0; let configured = 0;
  const { api, calls } = fixture({ open: async () => { opened++; }, setOptions: async () => { configured++; } });
  assert.equal((await launchPanel(api, { windowId: 1 })).action, 'configured');
  assert.equal(opened, 0); assert.equal(configured, 1);
  assert.equal((await launchPanel(api, { windowId: 1, granted: true })).action, 'opened');
  assert.equal(opened, 1); assert.equal(calls.length, 0);
  api.sidePanel.setOptions = async () => { throw Error('permission unavailable'); };
  assert.equal((await launchPanel(api, { windowId: 1 })).action, 'dashboard');
  assert.equal(calls.length, 1);
});
