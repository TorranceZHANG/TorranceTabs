export const COLORS = Object.freeze([
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
]);

export const COLOR_LABELS = Object.freeze({
  grey: '灰色', blue: '蓝色', red: '红色', yellow: '黄色', green: '绿色',
  pink: '粉色', purple: '紫色', cyan: '青色', orange: '橙色',
});

export const DEFAULT_SETTINGS = Object.freeze({ enabled: true, duplicatePromptEnabled: true, rules: Object.freeze([]) });

function httpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function validateSettings(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.rules)) {
    throw new Error('规则格式无效。');
  }
  if (typeof value.enabled !== 'boolean') throw new Error('自动分组开关必须为布尔值。');
  const duplicatePromptEnabled = value.duplicatePromptEnabled ?? true;
  if (typeof duplicatePromptEnabled !== 'boolean') throw new Error('新标签重复提醒开关必须为布尔值。');
  const prefixes = new Set();
  const groupColors = new Map();
  const rules = value.rules.map((rule, index) => {
    const label = `第 ${index + 1} 条规则`;
    if (!rule || typeof rule !== 'object') throw new Error(`${label}格式无效。`);
    const url = httpUrl(rule.prefix);
    if (!url) throw new Error(`${label}：请输入完整的 http:// 或 https:// 网址前缀，且不能包含账号密码。`);
    const group = typeof rule.group === 'string' ? rule.group.trim() : '';
    if (!group) throw new Error(`${label}：请填写标签组名。`);
    if (!COLORS.includes(rule.color)) throw new Error(`${label}：请选择有效的组颜色。`);
    const enabled = rule.enabled ?? true;
    if (typeof enabled !== 'boolean') throw new Error(`${label}：启用状态无效。`);
    const prefix = url.href;
    if (enabled) {
      if (prefixes.has(prefix)) throw new Error(`${label}：这个网址前缀已有启用的规则。`);
      prefixes.add(prefix);
      if (groupColors.has(group) && groupColors.get(group) !== rule.color) {
        throw new Error(`${label}：同名标签组“${group}”需要使用相同颜色。`);
      }
      groupColors.set(group, rule.color);
    }
    return { prefix, group, color: rule.color, enabled };
  });
  return { enabled: value.enabled, duplicatePromptEnabled, rules };
}

export function findRule(value, rules) {
  const url = httpUrl(value);
  if (!url) return null;
  let best = null;
  for (const rule of rules) {
    if (rule.enabled !== false && url.href.startsWith(rule.prefix)
      && (!best || rule.prefix.length > best.prefix.length)) best = rule;
  }
  return best;
}
