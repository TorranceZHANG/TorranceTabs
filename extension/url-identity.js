const HTTP = new Set(['http:', 'https:']);
const PARAM = /^[^\u0000-\u001f\u007f]{1,120}$/;

export function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!HTTP.has(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeDedupRules(raw) {
  if (!Array.isArray(raw) || raw.length > 100) throw Error('忽略参数规则格式无效。');
  const origins = new Set();
  return raw.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || Object.keys(rule).some(key => !['origin', 'ignoreParams'].includes(key))) throw Error('忽略参数规则包含未知字段。');
    let parsed;
    try { parsed = new URL(rule.origin); } catch { throw Error('忽略参数规则的站点无效。'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.origin !== rule.origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw Error('忽略参数规则必须是精确 HTTP(S) origin。');
    }
    if (origins.has(parsed.origin)) throw Error('同一站点只能配置一条忽略参数规则。');
    origins.add(parsed.origin);
    if (!Array.isArray(rule.ignoreParams) || rule.ignoreParams.length > 30) throw Error('忽略参数列表格式无效。');
    const seen = new Set();
    const ignoreParams = rule.ignoreParams.map(value => {
      if (typeof value !== 'string' || !PARAM.test(value) || seen.has(value)) throw Error('忽略参数名无效或重复。');
      seen.add(value);
      return value;
    });
    return { origin: parsed.origin, ignoreParams };
  });
}

export function canonicalUrl(raw, rules = []) {
  if (!safeHttpUrl(raw)) return null;
  const url = new URL(raw);
  const rule = rules.find(item => item?.origin === url.origin);
  if (!rule?.ignoreParams?.length) return raw;
  const hashAt = raw.indexOf('#');
  const beforeHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const hash = hashAt >= 0 ? raw.slice(hashAt) : '';
  const queryAt = beforeHash.indexOf('?');
  if (queryAt < 0) return raw;
  const ignored = new Set(rule.ignoreParams);
  let removed = false;
  const kept = beforeHash.slice(queryAt + 1).split('&').filter(pair => {
    const encodedName = pair.slice(0, pair.indexOf('=') < 0 ? pair.length : pair.indexOf('='));
    let name;
    try { name = decodeURIComponent(encodedName.replace(/\+/g, ' ')); } catch { return true; }
    if (!ignored.has(name)) return true;
    removed = true;
    return false;
  });
  if (!removed) return raw;
  return `${beforeHash.slice(0, queryAt)}${kept.length ? `?${kept.join('&')}` : ''}${hash}`;
}

export const identityForUrl = canonicalUrl;
export function identityForTab(tab, rules = []) {
  return tab && !tab.incognito && Number.isInteger(tab.id) ? canonicalUrl(tab.url, rules) : null;
}
export function sameUrlIdentity(left, right, rules = []) {
  const a = canonicalUrl(left, rules);
  return a !== null && a === canonicalUrl(right, rules);
}
