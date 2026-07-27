/**
 * 跨机派活的幂等。
 *
 * 要防的事只有一件：**同一个任务被注入两遍。**
 *
 * 派活超时或 ssh 断掉之后，任务其实**已经注入进对面那个 agent 了** ——
 * 断线只能理解成 detach，不是 cancel（注入不可撤回）。人或 agent 这时很自然会
 * 再发一次同样的任务，于是同一个会话里就有了两份。
 *
 * 关键是幂等键**必须从内容派生**：随机 id 在重试时是另一个值，等于没有幂等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { peerRequestId, createRequestLog } from '../src/main/peer.ts'

test('同一个人把同一个任务派给同一个终端 = 同一个 id', () => {
  const a = peerRequestId('t-1', 't-2', '跑测试')
  assert.equal(a, peerRequestId('t-1', 't-2', '跑测试'))
  // 三个维度任一不同就是另一次派活
  assert.notEqual(a, peerRequestId('t-9', 't-2', '跑测试'))
  assert.notEqual(a, peerRequestId('t-1', 't-9', '跑测试'))
  assert.notEqual(a, peerRequestId('t-1', 't-2', '跑测试 2'))
})

test('id 的分隔不能有歧义（拼串式哈希的经典坑）', () => {
  // ('a','b','c') 和 ('a b','c') 之类的组合不能撞
  assert.notEqual(peerRequestId('a', 'b', 'c d'), peerRequestId('a', 'b c', 'd'))
})

test('重试时不再注入，并说清楚上次到底怎么了', () => {
  const log = createRequestLog()
  const id = peerRequestId('t-1', 't-2', '跑测试')

  assert.equal(log.begin(id, 1000), null, '第一次必须放行')

  const second = log.begin(id, 2000)
  assert.ok(second, '第二次必须被挡住')
  assert.equal(second.state, 'running', '还在跑 —— 要能告诉用户去哪看')

  log.finish(id, '测试全过', 3000)
  const third = log.begin(id, 4000)
  assert.equal(third?.state, 'done')
  assert.equal(third?.result, '测试全过', '拿得到上次的结果，否则用户只会再试一次')
})

test('并发的两个请求只有一个能过 —— begin 必须是原子登记', () => {
  const log = createRequestLog()
  const id = peerRequestId('t-1', 't-2', 'x')
  const results = [log.begin(id, 1000), log.begin(id, 1000), log.begin(id, 1000)]
  assert.equal(results.filter((r) => r === null).length, 1, '只能有一个 null（放行）')
})

test('被拒的派活要撤销登记 —— 否则开关打开后十分钟内都派不出去', () => {
  const log = createRequestLog()
  const id = peerRequestId('t-1', 't-2', 'x')
  assert.equal(log.begin(id, 1000), null)
  log.abandon(id) // 比如"这台机器没开接受跨机派活"
  assert.equal(log.begin(id, 1100), null, '撤销后必须能重派')
})

test('过了 TTL 就放行（真想重派同一个任务的人得有出路）', () => {
  const ttl = 10 * 60_000
  const log = createRequestLog(ttl)
  const id = peerRequestId('t-1', 't-2', 'x')
  log.begin(id, 0)
  log.finish(id, '结果', 0)
  assert.ok(log.begin(id, ttl - 1), 'TTL 内仍要挡')
  assert.equal(log.begin(id, ttl + 1), null, 'TTL 过了要放行')
})

test('TTL 从完成时刻起算，不是从发起时刻', () => {
  const ttl = 10 * 60_000
  const log = createRequestLog(ttl)
  const id = peerRequestId('t-1', 't-2', 'x')
  log.begin(id, 0)
  // 一次派活本身可能跑 4 分钟；若按发起时刻算，结果只留得住 6 分钟
  log.finish(id, '结果', 240_000)
  const hit = log.begin(id, 240_000 + ttl - 1000)
  assert.equal(hit?.result, '结果', '拿到结果之后才开始算那十分钟')
})

test('表不会无限涨（每次派活都是一条新记录）', () => {
  const log = createRequestLog(10 * 60_000, 50)
  for (let i = 0; i < 500; i++) log.begin(peerRequestId('s', 't', `任务${i}`), 1000)
  assert.ok(log.size() <= 50, `表涨到了 ${log.size()}`)
})
