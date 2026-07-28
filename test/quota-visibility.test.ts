/**
 * 额度面板显示哪些账号。
 *
 * 钉的是**用户实测报的一个噪音问题**：他没在画布里开 codex，右上角却一直显示
 * codex 的额度（copilot 同）。原因是旧判据只藏 `unconfigured` 的系统号 ——
 * 而他的 codex 在**系统层面**是登录着的，于是"已登录 + 有真数据"，一直显示。
 *
 * 这条判据以前写在两个地方（AccountBlock 内一份、外层 filter 一份），
 * 注释还写着"两处保持一致"。那种一致靠人记，改一处漏一处只是时间问题 ——
 * 所以抽成纯函数，这个文件就是它的护栏。
 *
 * 跑法：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldShowAccount } from '../src/renderer/src/quota-visibility.ts'

test('系统号没人用 → 不显示（用户报的就是这条）', () => {
  assert.equal(shouldShowAccount({ accountId: 'system:codex', usingCount: 0 }), false)
  assert.equal(shouldShowAccount({ accountId: 'system:copilot', usingCount: 0 }), false)
})

test('系统号有节点在用 → 显示', () => {
  assert.equal(shouldShowAccount({ accountId: 'system:codex', usingCount: 1 }), true)
})

test('用户自建的凭证永远显示，哪怕没人用', () => {
  /* 藏起来等于"我建的号凭空消失了"。而且「未登录」是**可以自己修**的状态
     （去跑一次 login），必须在界面上存在 —— 和"查不到"完全不是一回事 */
  assert.equal(shouldShowAccount({ accountId: 'i-abc123', usingCount: 0 }), true)
})

test('不看登录状态 —— 同一个号在任何状态下结论都一样', () => {
  /* 旧规则栽在这：codex 在系统层登录着，state 是 'ok'，于是永远不满足
     "unconfigured 才隐藏"。新判据只问一件事：画布上有没有人在用。

     ⚠️ **这条原来是假绿的**：它只对一个临时对象跑 `Object.keys`，
     压根没调用 `shouldShowAccount` —— 函数重新引入 state、去读外部状态、
     或整个改写判据，它照样通过。codex 对手方审查逮到的。
     现在改成表驱动真调用：状态是噪音，结论只由 usingCount 决定。 */
  for (const state of ['ok', 'unconfigured', 'logged-out', 'unknown', 'error']) {
    const extra = { state } as unknown as { accountId: string; usingCount: number }
    assert.equal(
      shouldShowAccount({ ...extra, accountId: 'system:codex', usingCount: 0 }),
      false,
      `state=${state} 时系统号没人用就该藏`
    )
    assert.equal(
      shouldShowAccount({ ...extra, accountId: 'system:codex', usingCount: 1 }),
      true,
      `state=${state} 时有人用就该显示`
    )
    assert.equal(
      shouldShowAccount({ ...extra, accountId: 'i-mine', usingCount: 0 }),
      true,
      `state=${state} 时用户自建的凭证永远显示`
    )
  }
})
