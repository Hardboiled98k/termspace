/**
 * 钉住一次**真实回归**：面板从"有数据"变成"没数据"，而 334 条测试一条都没红。
 *
 * 现象（自检截图拍到的）：codex 卡片原本显示
 *   `CODEX 系统默认 pro / a***@gmail.com / 周 ▓ 1% 156h8m`
 * 变成了三行互相矛盾的话：
 *   `等待确认` + `仅管理员可查询` + `API key 按量计费，没有订阅额度可查`
 *
 * 根因：本机登录 shell 里 export 着 `OPENAI_API_KEY`（app 会继承），
 * 于是 `billingKind` 把 `system:codex` 判成 api-key，而那条分支**在调用采集器之前**
 * 就短路返回了。可事实是 codex CLI 走的是 OAuth 订阅 —— 采集器本来查得到。
 *
 * 判据因此定成一句话：**只有目标存储属于该账号才允许探测，且观测压过推断**。
 * 「采集器真拿到了窗口」是观测，「env 里有 key」只是推断。
 * 订阅和 API key 完全可以同时存在，只有采集器确实空手而归才退回按量计费那句。
 * 用户自建凭证没有隔离目录时则不许碰系统默认目录或默认钥匙串，避免把系统号额度错标给它。
 *
 * 第二条同源：拿到真实窗口本身就是登录态的证明（那个接口要凭据才答得出话），
 * 却仍挂着默认的「等待确认」，于是卡片上「已经查到 1%」和「等待确认」并存。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decorateQuota,
  hasRealWindows,
  defaultPresence,
  apiKeyUnavailable,
  pickQuota,
  startQuotaHub,
  type QuotaAccount
} from '../src/main/quota/index.ts'
import { now, type AccountQuota } from '../src/main/quota/types.ts'

const acct = (over: Partial<QuotaAccount> = {}): QuotaAccount => ({
  accountId: 'system:codex',
  provider: 'codex',
  name: '系统默认',
  env: {},
  ...over
})

const collected = (over: Partial<AccountQuota> = {}): AccountQuota => ({
  accountId: 'system:codex',
  provider: 'codex',
  name: '系统默认',
  state: 'ok',
  quotaCapability: 'supported',
  presence: { state: 'verified', detail: '', discovered: false },
  capturedAt: now(),
  source: 'app-server',
  windows: [{ label: '周', usedPercent: 1, windowDurationMins: 10080, resetsInMins: 9368 }],
  ...over
})

test('只有拿到真实窗口时才算查到了额度。', () => {
  assert.equal(hasRealWindows(collected()), true)
  assert.equal(hasRealWindows(collected({ state: 'stale' })), true, 'stale 是旧数据但仍是真数据')
  assert.equal(hasRealWindows(collected({ windows: [] })), false, '空窗口不能画进度条')
  assert.equal(hasRealWindows(collected({ state: 'unavailable' })), false)
  assert.equal(hasRealWindows(collected({ state: 'unconfigured' })), false)
  assert.equal(hasRealWindows(null), false)
})

test('查到额度后不能继续显示「等待确认」。', () => {
  const a = acct()
  const p = defaultPresence(a)
  assert.equal(p.state, 'unknown', '前提：系统账号默认就是 unknown')
  assert.equal(p.detail, '等待确认')

  const out = decorateQuota(a, p, collected())
  assert.equal(out.presence.state, 'verified', '拿到真窗口 = 这个账号确实登录着')
  assert.ok(!out.presence.detail.includes('等待确认'), `文案没换：${out.presence.detail}`)
  assert.ok(out.presence.detail.length <= 8, `这行紧挨着进度条，别啰嗦：${out.presence.detail}`)
})

test('没查到额度时不能伪造登录态。', () => {
  const a = acct()
  const p = defaultPresence(a)
  const out = decorateQuota(a, p, collected({ state: 'unavailable', windows: [] }))
  assert.equal(out.presence.state, 'unknown', '查不到就只能说不知道')
})

test('已经验证的 presence 不会被较笼统的结果覆盖。', () => {
  const a = acct({ presence: { state: 'verified', detail: 'codex login status 已验证', discovered: false } })
  const out = decorateQuota(a, defaultPresence(a), collected())
  assert.equal(out.presence.detail, 'codex login status 已验证')
})

test('API key 兜底与真实数据互斥，并且兜底结果不带窗口。', () => {
  /* 这条钉的是形状：兜底对象**必须**是空窗口 + unavailable，
     否则它一旦被误用在有订阅的账号上，界面会画出一个空进度槽 ——
     而"空槽"和"用了 0%"在视觉上分不开。 */
  const a = acct({ kind: 'api-key' })
  const fb = apiKeyUnavailable(a, defaultPresence(a))
  assert.equal(fb.state, 'unavailable')
  assert.deepEqual(fb.windows, [])
  assert.equal(hasRealWindows(fb), false)
  assert.match(fb.hint ?? '', /按量计费/)
})

test('系统账号被推断为 API key 时仍然优先显示采集到的真实数据。', () => {
  /* 模拟本机实况：shell 里 export 了 OPENAI_API_KEY（→ kind 判成 api-key），
     而 codex 实际走 OAuth 订阅，采集器返回了真实的周窗口。
     老实现在 probe 之前就 return 了兜底 → 真数据永远到不了界面。 */
  const a = acct({ kind: 'api-key' })
  const p = defaultPresence(a)
  const r = collected()

  const final = pickQuota(a, p, r)

  assert.equal(final?.state, 'ok', 'api-key 这个标签把真实订阅额度顶掉了')
  assert.equal(final?.windows.length, 1)
  assert.ok(!final.hint?.includes('按量计费'), '不该再挂按量计费的说明')
})

test('API key 账号只有在采集器空手时才退回按量计费说明。', () => {
  const a = acct({ kind: 'api-key' })
  const p = defaultPresence(a)
  const r = collected({ state: 'unconfigured', windows: [] })
  const final = pickQuota(a, p, r)
  assert.match(final?.hint ?? '', /按量计费/)
})

test('API key 账号没有隔离目录时不会调用 probe。', async () => {
  let probeCalls = 0
  const updates: AccountQuota[][] = []
  const hub = startQuotaHub(
    '/tmp',
    (list) => updates.push(list),
    undefined,
    async () => {
      probeCalls++
      return collected()
    }
  )

  hub.setAccounts([
    acct({
      accountId: 'user-api-key',
      kind: 'api-key',
      env: {}
    })
  ])
  for (let i = 0; i < 50 && updates.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  hub.dispose()

  assert.equal(probeCalls, 0, '无隔离目录的自建凭证碰了系统默认存储')
  assert.equal(updates.length, 1, '采集轮次没有完成')
  assert.match(updates[0]?.[0]?.hint ?? '', /按量计费/)
})

test('账号自带的 email 和 plan 会覆盖采集器结果。', () => {
  const a = acct({ email: 'x@y.com', plan: 'pro' })
  const out = decorateQuota(a, defaultPresence(a), collected({ email: 'old@z.com' }))
  assert.equal(out.email, 'x@y.com')
  assert.equal(out.plan, 'pro')
})
