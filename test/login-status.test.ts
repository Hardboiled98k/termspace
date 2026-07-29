/**
 * `codex login status` 输出解析。
 *
 * 这里钉的是一个**已经上线过的 P0**：原来判 `/Logged in/i` 在前、`/Not logged in/i` 在后，
 * 而前者命中后者的文本（"Not **logged in**"），于是每个未登录的号都显示成「已登录」。
 * 凭证节点显示登录态的唯一意义就是防止"拉了线以为就登录了"—— 判反比不显示更糟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClaudeAuth, parseCodexLogin } from '../src/main/login-status.ts'

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

// ── Claude：`claude auth status --json` 真实存在（项目一度以为没有）─────────

test('Claude 已登录：显示套餐和邮箱', () => {
  // 本机实测的真实返回形状
  const out = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'a@b.com',
    subscriptionType: 'max'
  })
  const r = parseClaudeAuth(out)
  assert.equal(r.state, 'in')
  assert.match(r.detail, /max/)
  /* **detail 里的邮箱必须是脱敏的**（这条断言的上一版要求的是明文，
     把泄漏行为固化成了期望）。实测撞到的现象：额度卡上同一个邮箱出现两遍 ——
     「v***@…」（渲染层 maskEmail 过的）和「max · abc123xyz@…」（这里拼的，明文）。
     判据：**脱敏只能有一个出口**，谁把邮箱拼进给人看的字符串，谁就得先脱敏。
     `r.email` 字段仍是原值 —— 那是给程序区分两个同 provider 订阅号用的。 */
  assert.match(r.detail, /a\*\*\*@b\.com/)
  assert.ok(!/(?<!\*)a@b\.com/.test(r.detail), `detail 里有明文邮箱：${r.detail}`)
  assert.equal(r.email, 'a@b.com', '结构化字段仍是原值')
})

test('Claude 未登录（隔离目录里是空的）', () => {
  const r = parseClaudeAuth(JSON.stringify({ loggedIn: false, authMethod: 'none' }))
  assert.equal(r.state, 'out')
})

test('Claude 走 api_key 时要标出「按量计费」', () => {
  /* 订阅和按量在界面上长得一样但账单完全不同 —— 这正是那条
     "用户 shell export 的 ANTHROPIC_API_KEY 让订阅号白开"的坑 */
  const r = parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }))
  assert.equal(r.state, 'in')
  assert.match(r.detail, /按量计费/)
})

test('Claude 输出不是 JSON 时报 unknown，不编一个登录态出来', () => {
  assert.equal(parseClaudeAuth('command not found').state, 'unknown')
})

test('claude auth 返回 null / 数字 → unknown，不抛也不报"未登录"', () => {
  // JSON.parse('null') 成功但读属性会抛；'0' 成功但 loggedIn 是 undefined
  for (const s of ['null', '0', '"x"', '[]']) {
    const r = parseClaudeAuth(s)
    assert.equal(r.state, 'unknown', `${s} 应该是 unknown，得到 ${r.state}`)
  }
})

/* ── 第三条邮箱路径（codex 第二轮 P1-6）───────────────────────────────
   光把 `maskEmail` 提到 shared 还不够：CLI 的**原始输出**会被整段当成展示文案。
   `parseCodexLogin('Authenticated as alice@example.com')` 把整行放进 detail，
   凭证节点的 tooltip 直接显示它；认不出的输出也会原样回显前 80 字符。
   判据：**谁把外部文本拿去给人看，谁就得先过 maskEmailsInText。** */

test('**codex 登录输出里的邮箱也要脱敏**（它整行进 tooltip）', () => {
  const r = parseCodexLogin('Logged in using ChatGPT account alice@example.com')
  assert.equal(r.state, 'in')
  assert.ok(!r.detail.includes('alice@example.com'), `明文邮箱进了 detail：${r.detail}`)
  assert.match(r.detail, /a\*\*\*@example\.com/)
})

test('认不出的原始输出回显时同样脱敏', () => {
  const r = parseCodexLogin('weird output for bob@corp.io please check')
  assert.equal(r.state, 'unknown')
  assert.ok(!r.detail.includes('bob@corp.io'), r.detail)
})

test('Claude 那边非 JSON 的原始回显也脱敏', () => {
  const r = parseClaudeAuth('not json at all, carol@x.org')
  assert.equal(r.state, 'unknown')
  assert.ok(!r.detail.includes('carol@x.org'), r.detail)
})
