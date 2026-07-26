/**
 * tmux 启动参数：identity 的变量到底有没有传进会话。
 *
 * 这里守的是「同一台机器上两个订阅账号」那条路 —— 它会静默失败：
 * 界面上凭证配得好好的，开着 tmux 就是不生效，看不出任何异常。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleSpawnArgs } from '../src/main/tmux-args.ts'

const TMUX = '/opt/homebrew/bin/tmux'
const base = { session: 'tb-t1', conf: '/u/tmux.conf', shell: '/bin/zsh', cwd: '/proj' }
const build = (env: Record<string, string>, identity?: { keys: string[]; unset: string[] }) =>
  assembleSpawnArgs(TMUX, base.session, base.conf, base.shell, base.cwd, env, identity)

const pairs = (args: string[]): string[] =>
  args.filter((_, i) => args[i - 1] === '-e')

test('CODEX_HOME 传得进会话 —— 两个订阅号靠它区分', () => {
  const a = build({ CODEX_HOME: '/Users/me/.codex-a' }, { keys: ['CODEX_HOME'], unset: [] })
  const b = build({ CODEX_HOME: '/Users/me/.codex-b' }, { keys: ['CODEX_HOME'], unset: [] })
  assert.ok(pairs(a.args).includes('CODEX_HOME=/Users/me/.codex-a'))
  assert.ok(pairs(b.args).includes('CODEX_HOME=/Users/me/.codex-b'))
})

/* 曾经的静默失败：转发靠前缀白名单猜，OPENAI_* 不在表里，
   于是 identity 里写 OPENAI_API_KEY 在开着 tmux 时根本没传进去。 */
test('identity 显式声明的键一律转发，不靠前缀猜', () => {
  const r = build(
    { WEIRD_VENDOR_TOKEN: 'v1', UNRELATED: 'x' },
    { keys: ['WEIRD_VENDOR_TOKEN'], unset: [] }
  )
  assert.ok(pairs(r.args).includes('WEIRD_VENDOR_TOKEN=v1'))
  assert.ok(!pairs(r.args).some((p) => p.startsWith('UNRELATED=')), '没声明的不该跟着漏出去')
})

test('unset 用 env -u 真删，而不是 -e KEY=（那只是空串）', () => {
  const r = build({ CODEX_HOME: '/x' }, { keys: ['CODEX_HOME'], unset: ['OPENAI_API_KEY'] })
  const i = r.args.indexOf('/usr/bin/env')
  assert.ok(i > 0, '应该在 shell 前插入 env -u')
  assert.deepEqual(r.args.slice(i, i + 3), ['/usr/bin/env', '-u', 'OPENAI_API_KEY'])
  // env -u 必须紧挨在 shell 之前，且 shell 仍以登录 shell 启动
  assert.deepEqual(r.args.slice(-2), ['/bin/zsh', '-l'])
  assert.ok(!pairs(r.args).some((p) => p.startsWith('OPENAI_API_KEY=')), '不能退化成设空串')
})

test('无 tmux 时也要能剥掉变量', () => {
  const r = assembleSpawnArgs(null, base.session, base.conf, base.shell, base.cwd, {}, {
    keys: [],
    unset: ['ANTHROPIC_API_KEY']
  })
  assert.equal(r.file, '/usr/bin/env')
  assert.deepEqual(r.args, ['-u', 'ANTHROPIC_API_KEY', '/bin/zsh', '-l'])
})

test('无 tmux 且无 unset 时退回纯 shell', () => {
  const r = assembleSpawnArgs(null, base.session, base.conf, base.shell, base.cwd, {})
  assert.deepEqual(r, { file: '/bin/zsh', args: ['-l'] })
})

test('TERMBOARD_* 照常注入，TERM 交给 tmux 管', () => {
  const r = build({ TERMBOARD_NODE_ID: 't1', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
  assert.ok(pairs(r.args).includes('TERMBOARD_NODE_ID=t1'))
  assert.ok(!pairs(r.args).some((p) => p.startsWith('TERM=')))
  assert.ok(!pairs(r.args).some((p) => p.startsWith('COLORTERM=')))
})
