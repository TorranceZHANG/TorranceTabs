const STATUS_KEY = 'cleanupStatus';
const TITLE = '一键清理重复页 · 标签工具';
const STATES = new Set(['idle', 'running', 'done', 'error', 'interrupted']);
const count = value => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export function createCleanupController(api, deduplicate) {
  let status = { state: 'idle' };
  let inFlight = null;

  async function badge(current) {
    let text = '';
    let title = TITLE;
    let color = '#4f46e5';
    if (current.state === 'running') {
      text = '…';
      title = '正在清理重复页；如有“离开网站”提示，请在 Chrome 中处理';
    } else if (current.state === 'done') {
      const result = current.result || {};
      text = count(result.closed) > 99 ? '99+' : String(count(result.closed));
      color = count(result.failed) || count(result.remaining) ? '#a16207' : '#168257';
      title = `已关闭 ${count(result.closed)} 个重复页，剩余 ${count(result.remaining)} 个；点击查看结果`;
    } else if (current.state === 'error' || current.state === 'interrupted') {
      text = '!';
      color = '#b42318';
      title = current.error || '上次清理结果无法确认，点击查看';
    }
    await Promise.allSettled([
      Promise.resolve().then(() => api.action.setBadgeText({ text })),
      Promise.resolve().then(() => api.action.setBadgeBackgroundColor({ color })),
      Promise.resolve().then(() => api.action.setTitle({ title })),
    ]);
  }

  async function store(next) {
    status = next;
    try { await api.storage.session.set({ [STATUS_KEY]: next }); return true; }
    catch { return false; }
  }

  const ready = (async () => {
    try {
      const stored = (await api.storage.session.get({ [STATUS_KEY]: null }))[STATUS_KEY];
      if (stored && STATES.has(stored.state)) status = stored;
      if (status.state === 'running') {
        await store({ ...status, state: 'interrupted', finishedAt: Date.now(),
          error: '上次清理已中断，结果无法确认。请刷新查看；不会自动重试。' });
      }
    } catch {
      status = { state: 'error', error: '无法读取上次清理状态，请刷新查看。' };
    }
    await badge(status);
  })();

  const getStatus = async () => { await ready; return structuredClone(status); };
  const run = (origin = 'panel') => {
    if (inFlight) return inFlight;
    const task = (async () => {
      await ready;
      const operation = { operationId: crypto.randomUUID(), startedAt: Date.now(), origin };
      const saved = await store({ ...operation, state: 'running' });
      if (!saved) {
        status = { ...operation, state: 'error', error: '无法记录清理状态，尚未开始关闭标签。请刷新后手动重试。' };
        await badge(status);
        throw Error(status.error);
      }
      await badge(status);
      try {
        const result = await deduplicate();
        const next = { ...operation, state: 'done', finishedAt: Date.now(), result };
        if (!(await store(next))) {
          status.warning = '清理结果未能保存，关闭面板后可能无法查看；请以当前标签列表为准。';
        }
        await badge(status);
        return { ...result, ...(status.warning ? { warning: status.warning } : {}) };
      } catch (error) {
        await store({ ...operation, state: 'error', finishedAt: Date.now(),
          error: error.message || '清理未完成，请刷新列表查看。不会自动重试。' });
        await badge(status);
        throw error;
      }
    })();
    inFlight = task;
    const clear = () => { if (inFlight === task) inFlight = null; };
    task.then(clear, clear);
    return task;
  };
  return { run, getStatus };
}
