import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, normalizeDedupRules, safeHttpUrl } from '../url-identity.js';

test('默认保持完整原字符串，只有精确origin规则删除指定参数', () => {
  const raw = 'https://example.com/p?keep=a%20b&utm_source=x&keep2=a+b&utm_source=y#frag';
  assert.equal(canonicalUrl(raw), raw);
  const rules = normalizeDedupRules([{ origin: 'https://example.com', ignoreParams: ['utm_source'] }]);
  assert.equal(canonicalUrl(raw, rules), 'https://example.com/p?keep=a%20b&keep2=a+b#frag');
  assert.equal(canonicalUrl('https://other.example/?utm_source=x', rules), 'https://other.example/?utm_source=x');
});

test('参数名按表单编码解码判断，非选定片段顺序编码与重复项不变', () => {
  const rules = normalizeDedupRules([{ origin: 'https://example.com', ignoreParams: ['track id'] }]);
  const raw = 'https://example.com/?x=1&track+id=a&x=2&track%20id=b&bad%ZZ=3#x';
  assert.equal(canonicalUrl(raw, rules), 'https://example.com/?x=1&x=2&bad%ZZ=3#x');
});

test('拒绝凭据、危险协议、重复origin与未知schema字段', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('https://user:pass@example.com/'), null);
  assert.throws(() => normalizeDedupRules([{ origin: 'https://example.com', ignoreParams: [], extra: true }]), /未知/);
  assert.throws(() => normalizeDedupRules([
    { origin: 'https://example.com', ignoreParams: [] }, { origin: 'https://example.com', ignoreParams: ['x'] },
  ]), /只能配置一条/);
});
