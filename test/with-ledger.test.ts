/**
 * 钉住 run 崩溃却被任务账本记成 done 的 bug：
 * 异常必须写入 failed/error，同时原异常必须原样继续抛给调用方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withLedger, type Ledger, type TaskRecord } from '../src/main/task-ledger.ts'

test('任务执行崩溃时记为 failed 且原异常照常抛出', async () => {
  const finishes: Array<Partial<TaskRecord>> = []
  const ledger: Ledger = {
    start: async () => 'task-1',
    finish: async (_id, patch) => {
      finishes.push(patch)
    },
    list: async () => []
  }
  const crash = new TypeError('argv 含有空字节')

  await assert.rejects(
    withLedger(
      ledger,
      { source: 'term-1', target: 'broker:postgres:prod#p1', task: 'select 1' },
      async () => {
        throw crash
      }
    ),
    (error) => error === crash
  )
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0]?.state, 'failed')
  assert.equal(finishes[0]?.error, crash.message)
  assert.equal(finishes[0]?.result, undefined)
})
