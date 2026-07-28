/**
 * 钉住 `tb db` / `tb ssh` 曾经绕过授权和任务账本的漏洞。
 *
 * 这里测的是可注入依赖的主进程 handler：拒绝授权或缺失 source 时绝不能触发
 * brokerRun；允许后必须留下 start + finish，并且授权详情、账本和返回文本都不能泄露连接串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleBroker, classifyBrokerResult, type BrokerHandlerDeps } from '../src/main/broker-handler.ts'
import { classifyDelegateResult } from '../src/main/delegate.ts'

const secret = 'postgres://admin:TOPSECRET@prod.example/app'

const makeDeps = () => {
  const calls = {
    authorize: [] as Array<{ source: string; target: string; detail: string }>,
    run: 0,
    ledger: [] as Array<{ event: 'start' | 'finish'; task?: string; target?: string; state?: string }>
  }
  const deps: BrokerHandlerDeps = {
    getSettings: async () => ({
      brokers: [
        { id: 'p1', name: 'prod', kind: 'postgres', readOnly: true },
        // 同名不同类型是合法配置 —— 授权 key 必须区分得开
        { id: 's1', name: 'prod', kind: 'ssh', readOnly: false }
      ]
    }),
    getBrokerTarget: async () => secret,
    authorize: async (source, target, _what, detail) => {
      calls.authorize.push({ source, target, detail })
      return true
    },
    run: async () => {
      calls.run += 1
      return { ok: true, output: 'ok' }
    },
    withLedger: async (meta, run) => {
      calls.ledger.push({ event: 'start', task: meta.task, target: meta.target })
      const result = await run()
      // 真实实现就是这么定状态的：没给 classify 就落到 delegate 那份
      calls.ledger.push({ event: 'finish', state: (meta.classify ?? classifyDelegateResult)(result) })
      return result
    },
    branchOfNode: () => 'feat/broker-gate'
  }
  return { deps, calls }
}

test('授权被拒时确实不会调用 brokerRun', async () => {
  const { deps, calls } = makeDeps()
  deps.authorize = async () => false

  const result = await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.match(result, /^已拒绝：/)
  assert.equal(calls.run, 0)
})

test('**被拒的调用也要进账本**（拦下来这件事本身最该留痕）', async () => {
  /* `tb ask` 那条路的 withLedger 包在 delegate 外面，而 authorize 在 delegate 内部
     —— 所以它的拒绝是记账的。代理连接如果把 withLedger 放在授权之后，
     "agent 想动生产库、我拦了"就一个字都不会留下。 */
  const { deps, calls } = makeDeps()
  deps.authorize = async () => false

  await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.deepEqual(calls.ledger.map((x) => x.event), ['start', 'finish'])
  assert.equal(calls.ledger[1]?.state, 'rejected')
})

test('**授权 key 必须带 kind**：db:prod 的授权不能白送给 ssh:prod', async () => {
  /* 两个连接都叫 prod（一个 postgres 一个 ssh）是合法配置。
     key 只用 name 的话，用户给 `tb db prod` 勾的"本次不再询问"
     会把 `tb ssh prod` 一起放行 —— 而那个是**可写**连接。 */
  const { deps, calls } = makeDeps()

  await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')
  await handleBroker(deps, 'term-1', 'ssh', 'prod', 'ls')

  const targets = calls.authorize.map((a) => a.target)
  assert.deepEqual(targets, ['broker:postgres:prod', 'broker:ssh:prod'])
  assert.notEqual(targets[0], targets[1], '两种连接共用一个授权 key')
})

test('**失败的代理调用不能在账本里记成 done**', async () => {
  /* `classifyDelegateResult` 认的是 `派活失败` 前缀 —— 那是 delegate 的话术。
     代理连接说的是「执行失败：」，一个字都对不上，
     用默认分类会让所有连不上库/SQL 报错的调用都显示成成功。 */
  const { deps, calls } = makeDeps()
  deps.run = async () => ({ ok: false, error: 'connection refused' })

  const result = await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.match(result, /^执行失败：/)
  assert.equal(calls.ledger[1]?.state, 'failed')
  assert.notEqual(
    classifyDelegateResult(result),
    'failed',
    '如果 delegate 那份也能认出来，这条用例就白写了 —— 说明不需要独立 classify'
  )
})

test('代理连接的分类函数三态都对', () => {
  assert.equal(classifyBrokerResult('已拒绝：xxx'), 'rejected')
  assert.equal(classifyBrokerResult('执行失败：connection refused'), 'failed')
  assert.equal(classifyBrokerResult('rows: 3'), 'done')
})

test('source 为空时直接拒绝且不会取连接串或调用 brokerRun', async () => {
  const { deps, calls } = makeDeps()
  let targetReads = 0
  deps.getBrokerTarget = async () => {
    targetReads += 1
    return secret
  }

  const result = await handleBroker(deps, '', 'postgres', 'prod', 'select 1')

  assert.match(result, /^已拒绝：/)
  assert.equal(targetReads, 0)
  assert.equal(calls.run, 0)
})

test('账本 task 摘要和授权详情都不含连接串', async () => {
  const { deps, calls } = makeDeps()
  const payload = `select '${secret}' as injected_secret, '${'x'.repeat(300)}'`

  await handleBroker(deps, 'term-1', 'postgres', 'prod', payload)

  assert.equal(calls.ledger[0]?.event, 'start')
  assert.ok((calls.ledger[0]?.task?.length ?? 0) <= 200)
  assert.ok(!calls.ledger[0]?.task?.includes(secret))
  assert.ok(!calls.authorize[0]?.detail.includes(secret))
})

test('授权通过后账本有 start 和 finish 两条且 brokerRun 只执行一次', async () => {
  const { deps, calls } = makeDeps()

  const result = await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.equal(result, 'ok')
  assert.equal(calls.run, 1)
  assert.deepEqual(calls.ledger.map((x) => x.event), ['start', 'finish'])
})

test('broker 返回值里的连接串也会被隐去', async () => {
  const { deps } = makeDeps()
  deps.run = async () => ({ ok: true, output: `server replied for ${secret}` })

  const result = await handleBroker(deps, 'term-1', 'postgres', 'prod', 'select 1')

  assert.ok(!result.includes(secret))
  assert.match(result, /«已隐去»/)
})
