/**
 * identity env 包的展开规则。
 *
 * 这两条语义就是「同一台机器上跑两个订阅账号」能不能成立的关键：
 * 展开错了，CODEX_HOME 会指向一个叫 `~` 的目录；删不掉继承的 API key，
 * CLI 就绕过订阅走按量计费，账单静悄悄。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { materializeEnv } from '../src/main/identity-env.ts'

const HOME = '/Users/me'

test('~/ 和 $HOME/ 都要展开 —— env 值不过 shell', () => {
  const r = materializeEnv({ CODEX_HOME: '~/.codex-b', CLAUDE_CONFIG_DIR: '$HOME/.claude-b' }, HOME)
  assert.equal(r.set['CODEX_HOME'], '/Users/me/.codex-b')
  assert.equal(r.set['CLAUDE_CONFIG_DIR'], '/Users/me/.claude-b')
})

test('绝对路径与普通值原样保留', () => {
  const r = materializeEnv({ CODEX_HOME: '/opt/codex-b', FOO: 'a~b', BAR: 'x$HOME' }, HOME)
  assert.equal(r.set['CODEX_HOME'], '/opt/codex-b')
  // 只认开头的 ~/ 与 $HOME/，中间出现的不动
  assert.equal(r.set['FOO'], 'a~b')
  assert.equal(r.set['BAR'], 'x$HOME')
})

test('空值 = 从继承环境里删掉，而不是设成空串', () => {
  const r = materializeEnv({ OPENAI_API_KEY: '', CODEX_HOME: '/opt/b' }, HOME)
  assert.deepEqual(r.unset, ['OPENAI_API_KEY'])
  assert.ok(!('OPENAI_API_KEY' in r.set), '不能出现在 set 里，否则等于设成了空串')
  assert.equal(r.set['CODEX_HOME'], '/opt/b')
})

test('两个 codex 订阅号 = 两份互不相干的 env 包', () => {
  const a = materializeEnv({ CODEX_HOME: '~/.codex-work', OPENAI_API_KEY: '' }, HOME)
  const b = materializeEnv({ CODEX_HOME: '~/.codex-personal', OPENAI_API_KEY: '' }, HOME)
  assert.notEqual(a.set['CODEX_HOME'], b.set['CODEX_HOME'])
  assert.deepEqual(a.unset, b.unset)
})

// ── 保留键（空值绕过保护的那条路）─────────────────────────────────────────────

test('TERMBOARD_* 连存都不该存 —— set 和 unset 两条路都要挡', () => {
  /* `KEY=`（空值）走的是 unset 那条路，而原来的保护只写在 spawn 侧、只挡 set。
     于是 `TERMBOARD_HOOK_TOKEN=` 能把那个节点的状态上报/审批/tb 路由全部弄哑。 */
  const r = materializeEnv(
    { TERMBOARD_HOOK_TOKEN: '', TERMBOARD_NODE_ID: 'x', CODEX_HOME: '/a' },
    '/Users/x'
  )
  assert.deepEqual(r.unset, [], 'TERMBOARD_* 不许进 unset')
  assert.deepEqual(Object.keys(r.set), ['CODEX_HOME'], 'TERMBOARD_* 不许进 set')
})

test('PATH / TMUX / HOME 同样是保留键', () => {
  // PATH= 会直接废掉 shell；TMUX= 会破坏防嵌套；HOME= 会让一切认错家目录
  const r = materializeEnv({ PATH: '', TMUX: '', HOME: '/tmp', SHELL: '/bin/x' }, '/Users/x')
  assert.deepEqual(r.unset, [])
  assert.deepEqual(r.set, {})
})

test('正常的凭证键不受影响', () => {
  const r = materializeEnv({ CODEX_HOME: '~/.codex-b', OPENAI_API_KEY: '' }, '/Users/x')
  assert.equal(r.set['CODEX_HOME'], '/Users/x/.codex-b')
  assert.deepEqual(r.unset, ['OPENAI_API_KEY'])
})
