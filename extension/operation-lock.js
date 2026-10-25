export function createOperationLock() {
  let active = null;
  return {
    async run(kind, task) {
      if (active) throw Error(`正在执行${active === 'cleanup' ? '重复页清理' : '恢复操作'}，请稍后再试。`);
      active = kind;
      try { return await task(); } finally { active = null; }
    },
    current: () => active,
  };
}
