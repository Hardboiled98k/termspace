/**
 * 额度采集的调度。
 *
 * 钉的是一条：**采集期间换了账号，那次刷新不能被丢掉。**
 * 一轮采集要几秒（codex 未登录时硬超时 25s），用户正好在这段时间里
 * 把凭证的 CODEX_HOME 改到另一个订阅号 —— 老代码里 `if (running) return`
 * 把那次 run(true) 吃掉了，而正在跑的那轮用的还是**旧账号列表**
 * （Promise.all 的入参在 await 之前就求值完了），它结束时还会用旧结果
 * onUpdate 一次，等于把新配置的显示又盖回去。界面就一直挂着别人的额度。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startQuotaHub, type QuotaAccount } from '../src/main/quota/index.ts'
import { now, type AccountQuota } from '../src/main/quota/types.ts'

const acct = (id: string): QuotaAccount => ({
  accountId: id,
  provider: 'codex',
  name: id,
  env: {}
})

const fake = (a: QuotaAccount): AccountQuota => ({
  accountId: a.accountId,
  provider: a.provider,
  name: a.name,
  state: 'ok',
  capturedAt: now(),
  source: 'test',
  windows: []
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

test('采集期间换账号 → 那一轮结束后自动补跑，界面最终看到的是新账号', async () => {
  const seen: string[][] = []
  let release = (): void => {}
  const gate = new Promise<void>((r) => (release = r))
  let held = false

  const hub = startQuotaHub(
    '/tmp',
    (list) => seen.push(list.map((a) => a.accountId)),
    async (a) => {
      // 只卡住第一轮：模拟一次慢采集
      if (!held) {
        held = true
        await gate
      }
      return fake(a)
    }
  )

  hub.setAccounts([acct('老号')])
  await tick() // 第一轮起跑并卡在 gate 上

  hub.setAccounts([acct('新号')]) // ← 老代码在这里把刷新丢了
  release()

  // 等补跑那一轮落地
  for (let i = 0; i < 50 && !seen.some((s) => s.includes('新号')); i++) await tick()
  hub.dispose()

  assert.ok(
    seen.some((s) => s.includes('新号')),
    `换账号后没有补跑，onUpdate 只看到 ${JSON.stringify(seen)}`
  )
  assert.deepEqual(seen.at(-1), ['新号'], '最后一次广播必须是新账号，不能被旧那轮盖回去')
  assert.deepEqual(
    hub.snapshot().map((a) => a.accountId),
    ['新号'],
    '快照同理 —— HUD 展开时读的是它'
  )
})

test('指纹一样时不重采（改个不影响结果的东西不该触发网络请求）', async () => {
  let calls = 0
  const hub = startQuotaHub(
    '/tmp',
    () => {},
    async (a) => {
      calls++
      return fake(a)
    }
  )
  hub.setAccounts([acct('a')])
  await tick()
  const first = calls
  hub.setAccounts([acct('a')]) // 同一份
  await tick()
  hub.dispose()
  assert.equal(calls, first, '指纹没变却重采了')
})
