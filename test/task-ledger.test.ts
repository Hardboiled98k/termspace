/**
 * 任务账本。
 *
 * 它存在的理由是「人离开一小时回来，知道哪些结果可信、哪些要接管」——
 * 所以最该钉的不是"能不能写进去"，而是这三件**坏了也不报错**的事：
 *
 * 1. **半条记录不能带走整份账本**。追加写在断电/被杀时最后一行可能是半条，
 *    整份 JSON.parse 会直接抛，前面几百条一起消失。
 * 2. **同一任务的两条记录（开始/结束）必须合并成最终态**，
 *    否则界面上会同时出现一条"运行中"和一条"已完成"的同一个任务。
 * 3. **排序要把需要处理的排在前面**。按时间倒序看着合理，
 *    但失败的那条会被后来一堆成功的挤下去 —— 而它才是你回来要看的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLedger,
  parseLedger,
  mergeLedger,
  sortForReview,
  briefly,
  type TaskRecord
} from '../src/main/task-ledger.ts'

const rec = (o: Partial<TaskRecord>): TaskRecord =>
  ({ id: 'x', source: 's', target: 't', brief: 'b', startedAt: 1, state: 'done', ...o }) as TaskRecord

test('**半条记录跳过，前面的全都保住**', () => {
  const good = JSON.stringify(rec({ id: 'a' }))
  const text = `${good}\n{"id":"b","startedAt":2,"sta`
  const r = parseLedger(text)
  assert.equal(r.length, 1)
  assert.equal(r[0].id, 'a')
})

test('空行、空文件不炸', () => {
  assert.deepEqual(parseLedger(''), [])
  assert.deepEqual(parseLedger('\n\n  \n'), [])
})

test('没有 id 的行不算数；只有 id 的补丁留到 merge 再判', () => {
  /* **不能在 parse 阶段要求 startedAt** —— 结束时写的那条只有
     id/state/endedAt/result，要求它带 startedAt 等于把所有"结束"记录丢掉，
     任务永远停在运行中。这条是写完实现后被端到端用例逮到的。 */
  assert.deepEqual(parseLedger('{"foo":1}'), [])
  assert.equal(parseLedger('{"id":"a","state":"done"}').length, 1)
})

test('没有配对开始记录的孤儿补丁会被 merge 剔除', () => {
  // 否则界面上会出现一条没有来源、没有任务正文的空卡
  assert.deepEqual(mergeLedger([{ id: 'a', state: 'done' } as TaskRecord]), [])
})

test('同一任务的开始与结束合并成最终态', () => {
  const merged = mergeLedger([
    rec({ id: 'a', state: 'running', startedAt: 10 }),
    rec({ id: 'a', state: 'done', startedAt: 10, result: '答完了' })
  ])
  assert.equal(merged.length, 1, '界面上不能同时有同一任务的两张卡')
  assert.equal(merged[0].state, 'done')
  assert.equal(merged[0].result, '答完了')
  assert.equal(merged[0].source, 's', '先写的字段不能被后写的空值冲掉')
})

test('合并后新的在前（"我离开这段时间发生了什么"）', () => {
  const m = mergeLedger([rec({ id: 'a', startedAt: 1 }), rec({ id: 'b', startedAt: 9 })])
  assert.deepEqual(m.map((r) => r.id), ['b', 'a'])
})

test('**排序把失败的顶上来**，不是单纯按时间倒序', () => {
  const r = sortForReview([
    rec({ id: 'new-done', state: 'done', startedAt: 100 }),
    rec({ id: 'old-failed', state: 'failed', startedAt: 1 }),
    rec({ id: 'running', state: 'running', startedAt: 50 })
  ])
  assert.deepEqual(r.map((x) => x.id), ['old-failed', 'running', 'new-done'])
})

test('摘要截断，且不把整段对话存进账本', () => {
  const long = 'a'.repeat(1000)
  assert.ok(briefly(long).length <= 281)
  assert.ok(briefly(long).endsWith('…'))
  assert.equal(briefly('  多  空白\n压平  '), '多 空白 压平')
})

test('端到端：start → finish → list 拿到的是最终态', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ledger-'))
  const file = path.join(dir, 'tasks.jsonl')
  let t = 1000
  const led = createLedger(file, () => t)

  const id = await led.start({ source: 't-a', target: 't-b', brief: '把测试跑绿', branch: 'feat/x' })
  t = 2000
  await led.finish(id, { state: 'done', result: '跑绿了', transcript: '/x/y.jsonl' })

  const all = await led.list()
  assert.equal(all.length, 1)
  assert.equal(all[0].state, 'done')
  assert.equal(all[0].branch, 'feat/x', '开始时写的上下文不能在结束时丢掉')
  assert.equal(all[0].endedAt, 2000)
  assert.equal(all[0].transcript, '/x/y.jsonl')

  // 落盘的是 JSONL：两行、各自能单独解析
  const raw = await readFile(file, 'utf8')
  assert.equal(raw.trim().split('\n').length, 2, '写入必须是追加，不是整份重写')
})

test('账本被写坏一行之后，新任务照样记得下、旧记录还在', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ledger2-'))
  const file = path.join(dir, 'tasks.jsonl')
  const led = createLedger(file, () => 1)
  const id = await led.start({ source: 'a', target: 'b', brief: '第一件' })
  await led.finish(id, { state: 'done' })
  await writeFile(file, (await readFile(file, 'utf8')) + '{"半条\n')

  const id2 = await led.start({ source: 'a', target: 'b', brief: '第二件' })
  await led.finish(id2, { state: 'failed', error: '目标不在了' })
  const all = await led.list()
  assert.deepEqual(all.map((r) => r.brief).toSorted(), ['第一件', '第二件'])
})

test('派活返回文本 → 账本状态的分类（判据只有一份）', async () => {
  /* 这些话术是 delegate 自己产生的。本机 tb/ask、跨机 peer、将来的 UI
     各猜一份就会改一处漏三处 —— 所以判据留在 delegate.ts 里，这里只钉行为。
     `[派活中断]` 归 failed 不是 timeout：它的语义是"本轮结果不可取"，
     和"还在跑"完全不同，用户回来时要区别对待。 */
  const { classifyDelegateResult: c } = await import('../src/main/delegate.ts')
  assert.equal(c('派活被拒：t-x 当前状态是 running'), 'rejected')
  assert.equal(c('派活失败：找不到终端 t-x'), 'failed')
  assert.equal(c('[派活超时：t-x 在 240s 内未完成…]'), 'timeout')
  assert.equal(c('[派活中断：t-x 在等待期间换了会话…]'), 'failed')
  assert.equal(c('好的，我把测试跑绿了。'), 'done')
})
