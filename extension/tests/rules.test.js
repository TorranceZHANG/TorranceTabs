import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, findRule } from '../rules.js';

const rule = (prefix, group = '开发', color = 'blue') => ({ prefix, group, color, enabled: true });
const settings = rules => validateSettings({ enabled: true, rules });

test('最长前缀覆盖站点规则，路径保留大小写', () => {
  const { rules } = settings([
    rule('https://github.com/', '代码'), rule('https://github.com/OpenAI/', '研究', 'purple'),
  ]);
  assert.equal(findRule('https://github.com/OpenAI/project', rules).group, '研究');
  assert.equal(findRule('https://github.com/openai/project', rules).group, '代码');
});

test('规范化站点、默认端口和空路径，并防止相似域名误匹配', () => {
  const { rules } = settings([rule(' HTTPS://EXAMPLE.COM:443 ')]);
  assert.equal(rules[0].prefix, 'https://example.com/');
  assert.ok(findRule('https://EXAMPLE.com/page', rules));
  assert.equal(findRule('https://example.com.evil.test/page', rules), null);
  assert.equal(findRule('https://example.com@evil.test/page', rules), null);
  assert.equal(findRule('http://example.com/page', rules), null);
});

test('严格的字面前缀匹配支持路径、查询和片段', () => {
  const { rules } = settings([rule('https://example.com/docs?lang=zh#intro')]);
  assert.ok(findRule('https://example.com/docs?lang=zh#introduction', rules));
  assert.equal(findRule('https://example.com/docs?lang=en#intro', rules), null);
});

test('禁用规则和非网页 URL 不参与匹配', () => {
  const { rules } = settings([{ ...rule('https://example.com'), enabled: false }]);
  for (const url of ['https://example.com/', 'chrome://newtab/', 'about:blank', 'file:///tmp/a', 'bad']) {
    assert.equal(findRule(url, rules), null);
  }
});

test('校验拒绝无效前缀、空组名、重复规则和同组不同颜色', () => {
  for (const prefix of ['', 'github.com', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    assert.throws(() => settings([rule(prefix)]));
  }
  assert.throws(() => settings([rule('https://example.com', ' ')]));
  assert.throws(() => settings([rule('https://example.com'), rule('https://EXAMPLE.com:443/')]));
  assert.throws(() => settings([rule('https://a.test'), rule('https://b.test', '开发', 'red')]));
  assert.throws(() => validateSettings({ enabled: 'yes', rules: [] }));
});

test('多个前缀可以归入同一个标签组', () => {
  const { rules } = settings([rule('https://a.test'), rule('https://b.test')]);
  assert.equal(findRule('https://b.test/thing', rules).group, '开发');
});

test('旧规则兼容默认开启重复提醒，开关独立于自动分组', () => {
  const old = validateSettings({ enabled: false, rules: [] });
  assert.equal(old.duplicatePromptEnabled, true);
  assert.equal(old.enabled, false);
  assert.equal(validateSettings({ enabled: true, rules: [], duplicatePromptEnabled: false }).duplicatePromptEnabled, false);
  assert.throws(() => validateSettings({ enabled: true, rules: [], duplicatePromptEnabled: 'yes' }));
});
