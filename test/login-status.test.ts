/**
 * `codex login status` 输出解析。
 *
 * 这里钉的是一个**已经上线过的 P0**：原来判 `/Logged in/i` 在前、`/Not logged in/i` 在后，
 * 而前者命中后者的文本（"Not **logged in**"），于是每个未登录的号都显示成「已登录」。
 * 凭证节点显示登录态的唯一意义就是防止"拉了线以为就登录了"—— 判反比不显示更糟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCodexLogin } from '../src/main/login-status.ts'

test('未登录不能被判成已登录（回归：Not logged in 含 "logged in" 子串）', () => {
  const r = parseCodexLogin('Not logged in')
  assert.equal(r.state, 'out')
})

test('已登录判 in（codex 0.145 实测文案）', () => {
  assert.equal(parseCodexLogin('Logged in using ChatGPT').state, 'in')
})

test('其他几种未登录说法也认', () => {
  for (const s of ['Logged out', 'No stored credentials', 'Please run codex login']) {
    assert.equal(parseCodexLogin(s).state, 'out', `${s} 应判 out`)
  }
})

test('认不出的输出报 unknown，不猜成 in', () => {
  // 猜"已登录"会让用户对着一个不存在的号白等
  assert.equal(parseCodexLogin('error: connection refused').state, 'unknown')
  assert.equal(parseCodexLogin('').state, 'unknown')
  assert.equal(parseCodexLogin('   ').state, 'unknown')
})

test('home 原样带回给界面', () => {
  assert.equal(parseCodexLogin('Not logged in', '/tmp/x').home, '/tmp/x')
})
