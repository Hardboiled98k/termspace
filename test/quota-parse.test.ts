/**
 * 额度解析。
 *
 * 这一层的全部要求就一条：**「查不到」和「用了 0%」必须是两种东西**。
 * 所有用例都在钉这条 —— 认不出的字段要么整条跳过、要么如实报 unknown-shape，
 * 绝不能被折叠成一个自信的 0，因为界面上的 0% 意思是"你还有整整一格额度"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMoneyMinor, windowLabel } from '../src/main/quota/types.ts'
import { toWindows as codexWindows, type RateSnapshot } from '../src/main/quota/codex.ts'
import {
  toWindows as copilotWindows,
  resetSeconds,
  type Snapshot
} from '../src/main/quota/copilot.ts'
import { fingerprint } from '../src/main/quota/index.ts'

// ── 窗口标签：语义从分钟数推，不从数组位置推 ──

test('windowLabel 按时长推语义', () => {
  assert.equal(windowLabel(300), '5h')
  assert.equal(windowLabel(10080), '周')
  assert.equal(windowLabel(30), '30m')
})

test('windowLabel 不能把月窗口标成周', () => {
  // 老写法第一条是 `>= 10000 → 周`，于是 Copilot 的月配额（43200）也成了"周"
  assert.equal(windowLabel(43200), '月')
  assert.equal(windowLabel(20160), '14天')
})

test('windowLabel 拿不到时长时不猜', () => {
  // 本机实测 codex 的 primary 就是 10080（周）。按数组位置认会标成 5h
  assert.equal(windowLabel(undefined), '?')
  assert.equal(windowLabel(0), '?')
})

// ── codex ──

test('codex：真的用了 0% 要保留，不能被当成假值丢掉', () => {
  const snap: RateSnapshot = { primary: { usedPercent: 0, windowDurationMins: 10080 } }
  const w = codexWindows(snap, 'a')
  assert.equal(w.length, 1)
  assert.equal(w[0]?.usedPercent, 0)
  assert.equal(w[0]?.label, '周')
})

test('codex：缺 windowDurationMins 的窗口整条跳过', () => {
  // 认不出窗口语义时画一行"0%"就是撒谎 —— 宁可少一行
  const snap: RateSnapshot = { primary: { usedPercent: 42 } }
  assert.equal(codexWindows(snap, 'a').length, 0)
})

test('codex：secondary 为 null 时不能凭空多出一行', () => {
  // 本机账号只有周窗口、secondary 是 null。按位置认会多出一行不存在的 5h
  const snap: RateSnapshot = {
    primary: { usedPercent: 1, windowDurationMins: 10080 },
    secondary: null
  }
  assert.equal(codexWindows(snap, 'a').length, 1)
})

test('codex：usedPercent 不是数字就跳过', () => {
  const snap = { primary: { usedPercent: '8' as unknown as number, windowDurationMins: 300 } }
  assert.equal(codexWindows(snap, 'a').length, 0)
})

// ── 金额：余额是字符串，可能带货币符号 ──

test('parseMoneyMinor 认得带符号和千分位的金额', () => {
  assert.deepEqual(parseMoneyMinor('$766.76'), { minor: 76676, currency: 'USD' })
  assert.deepEqual(parseMoneyMinor('1,234.50'), { minor: 123450, currency: 'USD' })
  assert.deepEqual(parseMoneyMinor('€10'), { minor: 1000, currency: 'EUR' })
  // 实测本机 codex 给的就是这个
  assert.deepEqual(parseMoneyMinor('0'), { minor: 0, currency: 'USD' })
})

test('parseMoneyMinor 认不出返回 null，不返回 0', () => {
  // 老实现是 Number('$766.76') * 100 → NaN，直接画进 HUD
  for (const bad of ['', '  ', 'unlimited', null, undefined, {}]) {
    assert.equal(parseMoneyMinor(bad), null, `${JSON.stringify(bad)} 应该是 null`)
  }
})

// ── Copilot ──

const SNAP_REAL: Record<string, Snapshot> = {
  chat: { percent_remaining: 100, entitlement: 200, has_quota: true, unlimited: false },
  completions: { percent_remaining: 100, entitlement: 2000, has_quota: true, unlimited: false },
  // 本机实测：这个套餐不含高级请求，上游用 has_quota:false 明说了
  premium_interactions: { percent_remaining: 0, entitlement: 0, has_quota: false, unlimited: false }
}

test('copilot：has_quota:false 的桶不渲染（否则是假的"额度耗尽"警报）', () => {
  const w = copilotWindows(SNAP_REAL, 1, 'x')
  assert.deepEqual(
    w.map((x) => x.label),
    ['对话', '补全']
  )
  assert.equal(w[0]?.usedPercent, 0) // 100% remaining = 用了 0%
})

test('copilot：has_quota 缺失时退回 entitlement 猜测', () => {
  const snaps: Record<string, Snapshot> = {
    chat: { percent_remaining: 30, entitlement: 100 },
    ghost: { percent_remaining: 0, entitlement: 0 }
  }
  const w = copilotWindows(snaps, undefined, 'x')
  assert.equal(w.length, 1)
  assert.equal(w[0]?.usedPercent, 70)
})

test('copilot：unlimited 桶即使 entitlement 为 0 也要保留', () => {
  const snaps: Record<string, Snapshot> = {
    chat: { percent_remaining: 100, entitlement: 0, unlimited: true }
  }
  assert.equal(copilotWindows(snaps, undefined, 'x').length, 1)
})

test('copilot：优先用 quota_reset_date_utc，别替上游猜时区', () => {
  const utc = resetSeconds({ quota_reset_date_utc: '2026-08-01T00:00:00.000Z' })
  assert.equal(utc, Date.parse('2026-08-01T00:00:00.000Z') / 1000)
  // 只有裸日期时才自己补
  assert.equal(resetSeconds({ quota_reset_date: '2026-08-01' }), utc)
})

test('copilot：日期解析不出来返回 undefined，不返回 0', () => {
  // 0 会被下游当成 1970 年，画成"早就该重置了"
  assert.equal(resetSeconds({ quota_reset_date: '不是日期' }), undefined)
  assert.equal(resetSeconds({}), undefined)
})

// ── Hub 指纹：账号变了就要重采 ──

const acc = (id: string, name: string, env: Record<string, string> = {}): Parameters<typeof fingerprint>[0][number] => ({
  accountId: id,
  provider: 'codex',
  name,
  env
})

test('fingerprint：改名要触发重采（名字就画在 HUD 上）', () => {
  assert.notEqual(fingerprint([acc('i1', '工作号')]), fingerprint([acc('i1', '个人号')]))
})

test('fingerprint：换 CODEX_HOME 要触发重采', () => {
  // 只比 accountId 的话，凭证指向另一个订阅号后 HUD 会继续显示旧号的额度
  const a = fingerprint([acc('i1', 'x', { CODEX_HOME: '/a' })])
  const b = fingerprint([acc('i1', 'x', { CODEX_HOME: '/b' })])
  assert.notEqual(a, b)
})

test('fingerprint：只是顺序不同不算变', () => {
  assert.equal(fingerprint([acc('i1', 'a'), acc('i2', 'b')]), fingerprint([acc('i2', 'b'), acc('i1', 'a')]))
})
