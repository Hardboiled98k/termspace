/**
 * 「这个账号有几个终端在用」的判据。
 *
 * 这条判据决定额度卡显不显示（配合 `shouldShowAccount`），而它有**三个来源**，
 * 顺序错了就会出现两种相反的错，两种都很难发现：
 *
 * - 数多了：普通 zsh 被算成 agent → 用户还没在画布上登录 codex，右上角就有额度卡
 *   （老实现的 `provider ?? 'claude'` 就是这个）
 * - 数少了：先开 zsh、再手敲 `claude` 的节点 provider 是空 → **正在烧的账号被藏起来**，
 *   等于账单不吭声（这是修数多了之后新引入的，自检截图里当场看到）
 *
 * 前台进程名不能用来推 provider，**实测**：claude 报版本号 `2.1.220`、
 * codex 报 `Python`、gemini 报 `node`。所以 (2) 只能来自 hook 事件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countUsing } from '../src/renderer/src/quota-usage.ts'

const NONE: Record<string, string> = {}

test('普通 shell 不算任何账号（老实现在这儿把它算成 claude）', () => {
  const nodes = [{ id: 't1' }, { id: 't2' }]
  assert.equal(countUsing(nodes, 'system:claude', NONE), 0)
  assert.equal(countUsing(nodes, 'system:codex', NONE), 0)
})

test('建节点时定的 provider 算数', () => {
  const nodes = [{ id: 't1', provider: 'codex' }, { id: 't2' }]
  assert.equal(countUsing(nodes, 'system:codex', NONE), 1)
})

test('**手敲起来的 agent 也要算**（hook 报的实跑 agent）', () => {
  // t1 是个普通 zsh 节点，用户在里面跑了 claude —— 额度正在烧，不能藏
  const nodes = [{ id: 't1' }]
  assert.equal(countUsing(nodes, 'system:claude', { t1: 'claude' }), 1)
})

test('实跑的 agent 覆盖静态 provider（节点当初是 codex，现在跑着 claude）', () => {
  const nodes = [{ id: 't1', provider: 'codex' }]
  assert.equal(countUsing(nodes, 'system:claude', { t1: 'claude' }), 1)
  assert.equal(countUsing(nodes, 'system:codex', { t1: 'claude' }), 0)
})

test('绑了凭证的节点只认那个凭证，不看 provider 也不看实跑', () => {
  /* 凭证连线是用户显式做的授权，比任何推断都硬。
     漏掉这条会让一个绑了订阅号 A 的节点同时算进「系统默认」头上。 */
  const nodes = [{ id: 't1', identityId: 'i-a', provider: 'claude' }]
  assert.equal(countUsing(nodes, 'i-a', { t1: 'claude' }), 1)
  assert.equal(countUsing(nodes, 'system:claude', { t1: 'claude' }), 0)
})

test('多个节点各自归属，互不串台', () => {
  const nodes = [
    { id: 't1', provider: 'codex' },
    { id: 't2' }, // 普通 zsh
    { id: 't3' }, // 手敲的 claude
    { id: 't4', identityId: 'i-b' }
  ]
  const live = { t3: 'claude' }
  assert.equal(countUsing(nodes, 'system:codex', live), 1)
  assert.equal(countUsing(nodes, 'system:claude', live), 1)
  assert.equal(countUsing(nodes, 'i-b', live), 1)
})
