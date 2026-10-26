import { validateSettings } from './rules.js';
import { validateFavorites, validateLibrary } from './library-schema.js';
import { validatePreferences } from './preferences.js';

export const SYNC_STORAGE_PREFIX = 'ttSync_';
export const SYNC_CONFIG_KEY = 'selectiveSyncConfig';
export const SYNC_DEVICE_ID_KEY = 'selectiveSyncDeviceId';
export const SYNC_ITEM_BYTES_LIMIT = 7 * 1024;
const MAX_REMOTE_DEVICES = 8;
const PREVIEW_TOKEN_KEY = 'selectiveSyncPreview';
const TOKEN_TTL = 5 * 60 * 1000;
const ALLOWED_SECTIONS = new Set(['rules', 'preferences', 'favorites']);
const clone = value => structuredClone(value);

function exactObject(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw Error(message);
}

function validateConfig(raw = { enabled: false }) {
  exactObject(raw, ['enabled'], '跨设备同步设置包含未知字段。');
  if (typeof raw.enabled !== 'boolean') throw Error('跨设备同步设置无效。');
  return { enabled: raw.enabled };
}

function validateSections(raw) {
  if (!Array.isArray(raw) || !raw.length) throw Error('请至少选择一项同步内容。');
  const seen = new Set();
  for (const value of raw) {
    if (!ALLOWED_SECTIONS.has(value) || seen.has(value)) throw Error('同步内容范围无效。');
    seen.add(value);
  }
  return [...seen];
}

function validateRuleList(raw) {
  if (!Array.isArray(raw)) throw Error('云端规则格式无效。');
  return validateSettings({ enabled: true, duplicatePromptEnabled: true, rules: raw }).rules;
}

function validateRemote(raw) {
  if (raw === null || raw === undefined) return null;
  exactObject(raw, ['schemaVersion', 'remoteId', 'revision', 'updatedAt', 'sections'], '云端同步数据包含未知字段。');
  if (raw.schemaVersion !== 1 || typeof raw.remoteId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(raw.remoteId)
    || !Number.isInteger(raw.revision) || raw.revision < 1 || !Number.isFinite(raw.updatedAt)) throw Error('云端同步数据格式无效。');
  exactObject(raw.sections, ['rules', 'preferences', 'favorites'], '云端同步范围包含未知字段。');
  const sections = {};
  if (raw.sections.rules !== undefined) sections.rules = validateRuleList(raw.sections.rules);
  if (raw.sections.preferences !== undefined) sections.preferences = validatePreferences(raw.sections.preferences);
  if (raw.sections.favorites !== undefined) sections.favorites = validateFavorites(raw.sections.favorites);
  if (!Object.keys(sections).length) throw Error('云端同步数据没有可应用的内容。');
  return { schemaVersion: 1, remoteId: raw.remoteId, revision: raw.revision, updatedAt: raw.updatedAt, sections };
}

function byteLength(value) { return new TextEncoder().encode(value).length; }
function syncKey(remoteId) { return `${SYNC_STORAGE_PREFIX}${remoteId}`; }
function itemSize(value) { return byteLength(syncKey(value.remoteId)) + byteLength(JSON.stringify(value)); }

async function digest(value) {
  if (value === null) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (globalThis.crypto?.subtle) {
    const result = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(result)].map(item => item.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

function selectedLocal(current, sections) {
  const selected = {};
  if (sections.includes('rules')) selected.rules = current.settings.rules;
  if (sections.includes('preferences')) selected.preferences = current.preferences;
  if (sections.includes('favorites')) selected.favorites = current.library.favorites;
  return selected;
}

export function createSyncService(api, store, enqueue = store.enqueue, now = () => Date.now()) {
  async function readRemotes() {
    const stored = await api.storage.sync.get(null);
    const remotes = [];
    for (const [key, value] of Object.entries(stored || {})) {
      if (!key.startsWith(SYNC_STORAGE_PREFIX)) continue;
      const remote = validateRemote(value);
      if (!remote || key !== syncKey(remote.remoteId)) throw Error('云端同步槽位与设备标识不匹配。');
      remotes.push({ remote, remoteDigest: await digest(remote) });
    }
    if (remotes.length > MAX_REMOTE_DEVICES) throw Error('云端同步设备槽位超过 8 台限制。');
    return remotes.sort((left, right) => right.remote.updatedAt - left.remote.updatedAt);
  }

  async function getState() {
    const local = await api.storage.local.get({ [SYNC_CONFIG_KEY]: { enabled: false }, [SYNC_DEVICE_ID_KEY]: null });
    const config = validateConfig(local[SYNC_CONFIG_KEY]);
    if (!config.enabled) return { config, deviceId: local[SYNC_DEVICE_ID_KEY], devices: [], remoteDigest: null };
    try {
      const remotes = await readRemotes();
      const own = remotes.find(item => item.remote.remoteId === local[SYNC_DEVICE_ID_KEY]);
      return { config, deviceId: local[SYNC_DEVICE_ID_KEY], devices: remotes.map(({ remote, remoteDigest }) => ({
        deviceId: remote.remoteId, updatedAt: remote.updatedAt, sections: Object.keys(remote.sections), revision: remote.revision,
        sizeBytes: itemSize(remote), remoteDigest })), remoteDigest: own?.remoteDigest ?? null };
    } catch (error) {
      return { config, deviceId: local[SYNC_DEVICE_ID_KEY], devices: [], remoteDigest: null,
        remoteError: error.message || '无法读取云端同步数据。' };
    }
  }

  async function configure(config) {
    const valid = validateConfig(config);
    return enqueue(async () => {
      const stored = await api.storage.local.get({ [SYNC_DEVICE_ID_KEY]: null });
      const deviceId = stored[SYNC_DEVICE_ID_KEY] || crypto.randomUUID();
      await store.setLocal({ [SYNC_CONFIG_KEY]: valid, [SYNC_DEVICE_ID_KEY]: deviceId });
      return { ...valid, deviceId };
    });
  }

  async function upload({ sections: requested, baseRemoteDigest } = {}) {
    return enqueue(async () => {
      const sections = validateSections(requested);
      const local = await api.storage.local.get({ [SYNC_CONFIG_KEY]: { enabled: false }, [SYNC_DEVICE_ID_KEY]: null });
      const config = validateConfig(local[SYNC_CONFIG_KEY]);
      if (!config.enabled) throw Error('请先显式启用跨设备同步。');
      if (typeof local[SYNC_DEVICE_ID_KEY] !== 'string' || !local[SYNC_DEVICE_ID_KEY]) throw Error('本机同步设备标识缺失，请重新配置。');
      const remotes = await readRemotes();
      const own = remotes.find(item => item.remote.remoteId === local[SYNC_DEVICE_ID_KEY]);
      if (baseRemoteDigest === undefined || baseRemoteDigest !== (own?.remoteDigest ?? null)) {
        throw Error('本机云端槽位已变化，请重新读取状态后上传。');
      }
      if (!own && remotes.length >= MAX_REMOTE_DEVICES) throw Error('云端已达到 8 台设备槽位上限。');
      const current = await store.snapshot();
      const payload = validateRemote({ schemaVersion: 1, remoteId: local[SYNC_DEVICE_ID_KEY], revision: (own?.remote.revision || 0) + 1, updatedAt: now(),
        sections: selectedLocal(current, sections) });
      const sizeBytes = itemSize(payload);
      if (sizeBytes > SYNC_ITEM_BYTES_LIMIT) throw Error('所选同步内容超过单项 7 KB 安全限额，请减少规则后重试。');
      await api.storage.sync.set({ [syncKey(payload.remoteId)]: payload });
      return { uploaded: true, remoteId: payload.remoteId, revision: payload.revision, remoteDigest: await digest(payload), sizeBytes,
        sections: Object.keys(payload.sections) };
    });
  }

  async function preview({ sections: requested, remoteId } = {}) {
    const sections = validateSections(requested);
    const config = validateConfig((await api.storage.local.get({ [SYNC_CONFIG_KEY]: { enabled: false } }))[SYNC_CONFIG_KEY]);
    if (!config.enabled) throw Error('请先显式启用跨设备同步。');
    if (typeof remoteId !== 'string' || !remoteId) throw Error('请选择要预览的远端设备。');
    const selectedRemote = (await readRemotes()).find(item => item.remote.remoteId === remoteId);
    if (!selectedRemote) throw Error('所选远端设备不存在或已变化。');
    const { remote, remoteDigest } = selectedRemote;
    for (const section of sections) if (remote.sections[section] === undefined) throw Error(`云端不包含 ${section} 数据。`);
    const current = await store.snapshot();
    const localSelected = selectedLocal(current, sections);
    const remoteSelected = Object.fromEntries(sections.map(section => [section, remote.sections[section]]));
    const token = crypto.randomUUID();
    await api.storage.session.set({ [PREVIEW_TOKEN_KEY]: { token, expiresAt: now() + TOKEN_TTL, sections,
      remoteId: remote.remoteId, remoteDigest, localDigest: await digest(localSelected) } });
    return { token, remoteId: remote.remoteId, remoteDigest, sections,
      changes: Object.fromEntries(sections.map(section => [section,
        JSON.stringify(localSelected[section]) !== JSON.stringify(remoteSelected[section])])),
      remote: clone(remoteSelected) };
  }

  async function apply({ token } = {}) {
    if (typeof token !== 'string') throw Error('同步确认已失效，请重新预览。');
    return enqueue(async () => {
      const record = (await api.storage.session.get({ [PREVIEW_TOKEN_KEY]: null }))[PREVIEW_TOKEN_KEY];
      if (!record || record.token !== token || record.expiresAt < now()) throw Error('同步确认已过期，请重新预览。');
      const config = validateConfig((await api.storage.local.get({ [SYNC_CONFIG_KEY]: { enabled: false } }))[SYNC_CONFIG_KEY]);
      if (!config.enabled) throw Error('跨设备同步已关闭。');
      const selectedRemote = (await readRemotes()).find(item => item.remote.remoteId === record.remoteId);
      if (!selectedRemote || selectedRemote.remoteDigest !== record.remoteDigest) {
        throw Error('云端数据已变化，请重新预览。');
      }
      const { remote, remoteDigest } = selectedRemote;
      const current = await store.snapshot();
      if (await digest(selectedLocal(current, record.sections)) !== record.localDigest) {
        throw Error('本机数据已变化，请重新预览。');
      }
      const changes = {};
      if (record.sections.includes('rules')) changes.settings = validateSettings({ ...current.settings, rules: remote.sections.rules });
      if (record.sections.includes('preferences')) changes.preferences = remote.sections.preferences;
      if (record.sections.includes('favorites')) changes.library = validateLibrary({ ...current.library,
        revision: current.library.revision + 1, favorites: remote.sections.favorites });
      await store.setLocal(changes);
      await api.storage.session.remove(PREVIEW_TOKEN_KEY).catch(() => {});
      return { applied: true, sections: [...record.sections], revision: changes.library?.revision ?? current.library.revision };
    });
  }

  return { getState, configure, upload, preview, apply };
}
