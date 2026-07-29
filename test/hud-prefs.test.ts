/**
 * HUD 折叠偏好的读写。
 *
 * 钉两件：
 *
 * 1. **默认值是产品判断，不是随便填的**：`board: true`（不改既有行为，
 *    用户只要求"能折叠"）、`accounts: []`（**默认精简**是用户明确要求的 ——
 *    邮箱和登录态文案是查证信息，日常每张卡占两行不值）。
 *    改默认值时这条用例会红，逼你重新想一遍。
 *
 * 2. **存坏了不能让整个面板炸**。localStorage 里的东西会被用户手改、
 *    被上一版写成别的形状、在隐私模式下压根写不进去。任何一种都不能让
 *    右上角的用量面板整块白掉 —— 它是这个产品缩到全景时唯一的信息源。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadHudPrefs, saveHudPrefs, toggleIn } from '../src/renderer/src/hud-prefs.ts'

/** 最小 Storage 桩：只实现 get/set */
const store = (init?: string): Pick<Storage, 'getItem' | 'setItem'> & { v?: string } => {
  const o = {
    v: init,
    getItem: (): string | null => o.v ?? null,
    setItem: (_k: string, val: string): void => {
      o.v = val
    }
  }
  return o
}

test('没存过 → 画布展开、账号全部精简', () => {
  const p = loadHudPrefs(store())
  assert.equal(p.board, true, '不改既有行为：画布区块默认还是展开的')
  assert.deepEqual(p.accounts, [], '**账号默认精简** —— 这是用户明确要求的')
})

test('存过就按存的来（重启后折叠状态必须还在）', () => {
  const s = store(JSON.stringify({ board: false, accounts: ['system:codex'] }))
  const p = loadHudPrefs(s)
  assert.equal(p.board, false)
  assert.deepEqual(p.accounts, ['system:codex'])
})

test('**存坏了不能炸**：非 JSON / 非对象 / 字段类型不对，一律落回默认', () => {
  for (const bad of ['', '不是 json', 'null', '123', '"x"', '[]', '{"board":"yes"}']) {
    const p = loadHudPrefs(store(bad))
    assert.equal(typeof p.board, 'boolean', `board 类型坏了：${bad}`)
    assert.ok(Array.isArray(p.accounts), `accounts 不是数组：${bad}`)
  }
})

test('accounts 里混进非字符串要被滤掉，不是整份丢掉', () => {
  /* 整份丢掉的话，用户展开的那几个账号会因为存进去一个脏值全部复位 ——
     逐字段兜底而不是整份信任。 */
  const p = loadHudPrefs(store(JSON.stringify({ board: true, accounts: ['a', 1, null, 'b'] })))
  assert.deepEqual(p.accounts, ['a', 'b'])
})

test('写不进去（隐私模式 / 配额满）不能抛', () => {
  const boom = {
    setItem: (): void => {
      throw new Error('QuotaExceededError')
    }
  }
  assert.doesNotThrow(() => saveHudPrefs({ board: false, accounts: [] }, boom))
})

test('往返一次不丢信息', () => {
  const s = store()
  const want = { board: false, accounts: ['system:claude', 'u-1'] }
  saveHudPrefs(want, s)
  assert.deepEqual(loadHudPrefs(s), want)
})

test('toggleIn 是开关不是追加（点两次要回到原样）', () => {
  assert.deepEqual(toggleIn([], 'a'), ['a'])
  assert.deepEqual(toggleIn(['a'], 'a'), [])
  assert.deepEqual(toggleIn(['a', 'b'], 'b'), ['a'])
  // 点两次回到原样 —— 写成 push 的话这条会红
  assert.deepEqual(toggleIn(toggleIn(['x'], 'y'), 'y'), ['x'])
})
