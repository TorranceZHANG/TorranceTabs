import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationLock } from '../operation-lock.js';

test('清理、撤销与工作区恢复共享互斥锁，失败后锁会释放', async () => {
  const lock = createOperationLock();
  let release;
  const pending = lock.run('cleanup', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(lock.run('restore', async () => {}), /正在执行重复页清理/);
  release();
  await pending;
  await assert.rejects(lock.run('restore', async () => { throw Error('restore failed'); }), /restore failed/);
  assert.equal(lock.current(), null);
  await lock.run('cleanup', async () => {});
});
