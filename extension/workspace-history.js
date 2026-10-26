import { DEFAULT_SNAPSHOT_CONFIG, validateAutoSnapshots, validateSnapshotConfig } from './library-schema.js';

export const AUTO_SNAPSHOT_ALARM = 'torrance-tabs-auto-snapshot';
export const AUTO_SNAPSHOT_CONFIG_KEY = 'autoSnapshotConfig';
export const AUTO_SNAPSHOTS_KEY = 'autoSnapshots';

const clone = value => structuredClone(value);

async function digest(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (globalThis.crypto?.subtle) {
    const result = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(result)].map(item => item.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

export function createSnapshotService(api, store, library, operationLock, now = () => Date.now()) {
  async function readState() {
    const stored = await api.storage.local.get({ [AUTO_SNAPSHOT_CONFIG_KEY]: DEFAULT_SNAPSHOT_CONFIG,
      [AUTO_SNAPSHOTS_KEY]: [] });
    return { config: validateSnapshotConfig(stored[AUTO_SNAPSHOT_CONFIG_KEY]),
      snapshots: validateAutoSnapshots(stored[AUTO_SNAPSHOTS_KEY]) };
  }
  async function getState() {
    const state = await readState();
    return { config: state.config, snapshots: state.snapshots.flatMap(snapshot => snapshot.workspaces.map(workspace => ({
      versionId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, libraryRevision: snapshot.libraryRevision,
      workspace: clone(workspace),
    }))) };
  }

  async function configure(config) {
    const valid = validateSnapshotConfig(config);
    const saved = await store.configureAutoSnapshots(valid);
    if (api.alarms) {
      await api.alarms.clear(AUTO_SNAPSHOT_ALARM);
      if (saved.enabled) await api.alarms.create(AUTO_SNAPSHOT_ALARM, { periodInMinutes: saved.intervalMinutes });
    }
    return saved;
  }

  async function capture({ manual = false } = {}) {
    const run = async () => {
      const state = await readState();
      if (!manual && !state.config.enabled) return { captured: false, reason: 'disabled' };
      if (!library || typeof library.captureCurrentWorkspace !== 'function') throw Error('无法读取当前浏览器工作区。');
      const [current, captured] = await Promise.all([store.snapshot(), library.captureCurrentWorkspace()]);
      const workspaces = [clone(captured.workspace)];
      const contentDigest = await digest(workspaces);
      if (state.snapshots[0]?.digest === contentDigest) return { captured: false, reason: 'unchanged' };
      const snapshot = { snapshotId: crypto.randomUUID(), capturedAt: now(), libraryRevision: current.library.revision,
        digest: contentDigest, workspaces };
      return store.saveAutoSnapshot(snapshot, { manual });
    };
    return operationLock?.run ? operationLock.run('workspace-snapshot', run) : run();
  }

  async function handleAlarm(alarm) {
    if (alarm?.name !== AUTO_SNAPSHOT_ALARM) return { handled: false };
    return { handled: true, ...await capture({ manual: false }) };
  }

  return { getState, configure, capture, handleAlarm };
}
