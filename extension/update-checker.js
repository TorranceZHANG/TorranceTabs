const ENDPOINT = 'https://api.github.com/repos/TorranceZHANG/TorranceTabs/releases/latest';
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
const MAX_BYTES = 128 * 1024;

function parseVersion(value) {
  const match = typeof value === 'string' && value.match(VERSION);
  return match ? match.slice(1).map(Number) : null;
}
function newer(latest, current) {
  for (let index = 0; index < 3; index += 1) {
    if (latest[index] !== current[index]) return latest[index] > current[index];
  }
  return false;
}
async function limitedText(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw Error('更新响应超过大小限制。');
  if (!response.body?.getReader) {
    const value = await response.text();
    if (new TextEncoder().encode(value).length > MAX_BYTES) throw Error('更新响应超过大小限制。');
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw Error('更新响应超过大小限制。'); }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export function createUpdateChecker(api, fetchImpl = globalThis.fetch, timeoutMs = 8000) {
  return async function checkUpdate() {
    const current = api.runtime.getManifest().version;
    const currentParts = parseVersion(current);
    if (!currentParts) throw Error('当前扩展版本格式无效。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(ENDPOINT, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
        redirect: 'error', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) throw Error(`GitHub 返回 ${response.status}。`);
      const payload = JSON.parse(await limitedText(response));
      const latestParts = parseVersion(payload.tag_name);
      if (!latestParts || payload.draft === true || payload.prerelease === true) throw Error('最新 release 信息无效。');
      const latest = latestParts.join('.');
      const expected = `https://github.com/TorranceZHANG/TorranceTabs/releases/tag/v${latest}`;
      if (payload.html_url !== expected) throw Error('release 链接不符合预期。');
      return { current, latest, available: newer(latestParts, currentParts), url: expected };
    } catch (error) {
      if (error?.name === 'AbortError') throw Error('检查更新超时，请稍后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  };
}
