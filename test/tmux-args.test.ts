/**
 * tmux 启动参数：identity 的变量到底有没有传进会话。
 *
 * 这里守的是「同一台机器上两个订阅账号」那条路 —— 它会静默失败：
 * 界面上凭证配得好好的，开着 tmux 就是不生效，看不出任何异常。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assembleSpawnArgs,
  identityValueIsSecret,
  shellQuote,
  tmuxClientEnv
} from '../src/main/tmux-args.ts'

const TMUX = '/opt/homebrew/bin/tmux'
const base = { session: 'tb-t1', conf: '/u/tmux.conf', shell: '/bin/zsh', cwd: '/proj' }
const build = (
  env: Record<string, string>,
  identity?: { keys: string[]; unset: string[] },
  secretFile?: string
) =>
  assembleSpawnArgs(TMUX, base.session, base.conf, base.shell, base.cwd, env, identity, secretFile)

const pairs = (args: string[]): string[] =>
  args.filter((_, i) => args[i - 1] === '-e')

test('CODEX_HOME 传得进会话 —— 两个订阅号靠它区分', () => {
  const a = build({ CODEX_HOME: '/Users/me/.codex-a' }, { keys: ['CODEX_HOME'], unset: [] })
  const b = build({ CODEX_HOME: '/Users/me/.codex-b' }, { keys: ['CODEX_HOME'], unset: [] })
  assert.ok(pairs(a.args).includes('CODEX_HOME=/Users/me/.codex-a'))
  assert.ok(pairs(b.args).includes('CODEX_HOME=/Users/me/.codex-b'))
})

/* 曾经的静默失败：转发靠前缀白名单猜，OPENAI_* 不在表里，
   于是 identity 里写 OPENAI_API_KEY 在开着 tmux 时根本没传进去。

   现在这类键走的是**密钥文件**那条路（值不进 argv），所以这条用例验的是
   两件事的分工：路径类走 -e，其余走文件；没声明的一个都不许跟出去。 */
test('identity 显式声明的键一律转发，不靠前缀猜', () => {
  const r = build(
    { WEIRD_VENDOR_TOKEN: 'v1', CODEX_HOME: '/x', UNRELATED: 'x' },
    { keys: ['WEIRD_VENDOR_TOKEN', 'CODEX_HOME'], unset: [] },
    '/tmp/env-x.sh'
  )
  assert.ok(pairs(r.args).includes('CODEX_HOME=/x'), '路径类走 -e')
  assert.ok(!r.args.join(' ').includes('v1'), '密钥走文件，值不该出现在 argv')
  assert.ok(r.args.join(' ').includes('/tmp/env-x.sh'), '密钥文件路径要传给 shell 去 source')
  assert.ok(!pairs(r.args).some((p) => p.startsWith('UNRELATED=')), '没声明的不该跟着漏出去')
})

test('落文件的那批和跳过 argv 的那批必须是同一批（判据只能有一个）', () => {
  /* index.ts 决定"哪些键写进密钥文件"、assembleSpawnArgs 决定"哪些键跳过 -e"，
     两处用**同一个** identityValueIsSecret。各写一份的话，判据一漂移就有键
     两边都不在 —— 症状是那个凭证静默不生效，而不是报错。 */
  assert.equal(identityValueIsSecret('OPENAI_API_KEY'), true)
  assert.equal(identityValueIsSecret('DATABASE_URL'), true)
  assert.equal(identityValueIsSecret('CODEX_HOME'), false)
  assert.equal(identityValueIsSecret('CLAUDE_CONFIG_DIR'), false)
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

// ── tmux server 环境泄漏（多钥匙隔离的命根子）─────────────────────────────────

test('tmux 客户端环境里不能带 identity 的密钥', () => {
  /* 实测过的失败路径：第一个客户端的环境会变成**长寿 server 的全局环境**，
     凭证 A 的终端先起 → server 带着 A 的私钥 → 凭证 B 的 pane 从 server 继承到它。
     tmux -L leaktest 里 B 的 new-window 真的打印出了 sk-AAAA。 */
  const env = { PATH: '/usr/bin', A_SECRET: 'sk-AAAA', HOME: '/Users/x' }
  const out = tmuxClientEnv(env, { keys: ['A_SECRET'], unset: [] })
  assert.equal(out['A_SECRET'], undefined, 'identity 的键绝不能进客户端环境')
  assert.equal(out['PATH'], '/usr/bin', '别的环境照常传')
})

test('unset 的键也不能进客户端环境（否则它会被带进 server 变成全局继承）', () => {
  const out = tmuxClientEnv({ ANTHROPIC_API_KEY: 'sk-x', PATH: '/b' }, { keys: [], unset: ['ANTHROPIC_API_KEY'] })
  assert.equal(out['ANTHROPIC_API_KEY'], undefined)
})

test('TERMBOARD_* 走 -e 下发，不留在客户端环境里', () => {
  // 留着的话 server 会记住**第一个节点**的 NODE_ID，用户手开 window 就顶着别人身份上报
  const out = tmuxClientEnv({ TERMBOARD_NODE_ID: 't1', TERMBOARD_HOOK_TOKEN: 'k', PATH: '/b' })
  assert.deepEqual(Object.keys(out), ['PATH'])
})

// ── 密钥不进 argv ────────────────────────────────────────────────────────────

test('有密钥文件时，密钥不出现在 tmux 参数里', () => {
  /* tmux 客户端进程和终端同寿，argv 全程可见（实测 ps -Ao args 能读到，
     macOS 没有 hidepid，同机其他用户也看得到） */
  const { args } = assembleSpawnArgs(
    '/usr/bin/tmux',
    'tb-t1',
    '/c.conf',
    '/bin/zsh',
    '/tmp',
    { OPENAI_API_KEY: 'sk-SECRET', CODEX_HOME: '/home/a', PATH: '/usr/bin' },
    { keys: ['OPENAI_API_KEY', 'CODEX_HOME'], unset: [] },
    '/tmp/env-x.sh'
  )
  const flat = args.join(' ')
  assert.ok(!flat.includes('sk-SECRET'), `密钥泄漏进 argv：${flat}`)
  // 路径类不是秘密，照常走 -e（这样手开 window 也还是同一个账号）
  assert.ok(flat.includes('CODEX_HOME=/home/a'))
  assert.ok(flat.includes('/tmp/env-x.sh'), '密钥文件路径要传给 shell 去 source')
})

test('没有密钥文件时密钥**照样**不进 argv（接回已存在会话走的就是这条路）', () => {
  /* 这条用例原来断言的是相反的事 —— "没有 secretFile 就把密钥塞进 -e"。
     那正是漏洞：接回已存在的会话时不会新建密钥文件（值早就在会话环境里了），
     于是那一次 `ps -Ao args` 里就有完整的 key，而 tmux 客户端进程和终端同寿。
     `-e` 对已存在的会话本来也是被忽略的，塞进去纯粹是白泄漏。 */
  const { args } = assembleSpawnArgs(
    '/usr/bin/tmux',
    'tb-t1',
    '/c.conf',
    '/bin/zsh',
    '/tmp',
    { OPENAI_API_KEY: 'sk-X', CODEX_HOME: '/home/a' },
    { keys: ['OPENAI_API_KEY', 'CODEX_HOME'], unset: [] }
  )
  const flat = args.join(' ')
  assert.ok(!flat.includes('sk-X'), `密钥泄漏进 argv：${flat}`)
  assert.ok(flat.includes('CODEX_HOME=/home/a'), '路径类照常下发')
})

test('identity 里名字不像密钥的值也当密钥（正则猜不到 DATABASE_URL 这类）', () => {
  /* 老判据是 `/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` —— 按名字猜。
     DATABASE_URL / AUTH_HEADER / COOKIE / 带签名的下载 URL 一个都不匹配，
     于是它们原样进 argv。identity 里的值默认就该按密钥处理，
     只有路径类（CODEX_HOME / CLAUDE_CONFIG_DIR）例外。 */
  const { args } = assembleSpawnArgs(
    '/usr/bin/tmux',
    'tb-t1',
    '/c.conf',
    '/bin/zsh',
    '/tmp',
    {
      DATABASE_URL: 'postgres://u:PGPASS@h/db',
      AUTH_HEADER: 'Bearer BEARERLEAK',
      CLAUDE_CONFIG_DIR: '/home/b'
    },
    { keys: ['DATABASE_URL', 'AUTH_HEADER', 'CLAUDE_CONFIG_DIR'], unset: [] },
    '/tmp/env-x.sh'
  )
  const flat = args.join(' ')
  assert.ok(!flat.includes('PGPASS'), `DATABASE_URL 泄漏进 argv：${flat}`)
  assert.ok(!flat.includes('BEARERLEAK'), `AUTH_HEADER 泄漏进 argv：${flat}`)
  assert.ok(flat.includes('CLAUDE_CONFIG_DIR=/home/b'), '路径类照常下发')
})

test('shellQuote 挡得住带引号的值', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
  assert.equal(shellQuote('has space'), `'has space'`)
})

test('TERMBOARD_HOOK_TOKEN 绝不进 argv —— 它能伪造 SessionStart', () => {
  /* 这把 token 能伪造该节点的 SessionStart，而 SessionStart 在 delegate 的状态机里
     **先于墓碑、无条件置活** —— 所以它按 0600 落盘、创建那刻就给权限。
     可它一度整条出现在 `tmux -e` 里，也就是 `ps -Ao args` 里，同机任何用户都读得到。

     上面那条用例的 env 样本只有 provider 密钥，恰好避开了它 ——
     所以它验的是"provider 密钥不进 argv"，不是本文件头声明的那条通用不变量。 */
  for (const secretFile of ['/tmp/env-x.sh', undefined]) {
    const { args } = assembleSpawnArgs(
      '/usr/bin/tmux',
      'tb-t1',
      '/c.conf',
      '/bin/zsh',
      '/tmp',
      {
        TERMBOARD_HOOK_TOKEN: 'HOOKTOK-SECRET',
        TERMBOARD_NODE_ID: 't1',
        TERMBOARD_HOOK_ENDPOINT: '/x/endpoint.env'
      },
      undefined,
      secretFile
    )
    const flat = args.join(' ')
    assert.ok(
      !flat.includes('HOOKTOK-SECRET'),
      `hook token 泄漏进 argv（secretFile=${secretFile}）：${flat}`
    )
    // 其余 TERMBOARD_* 照常下发 —— 状态上报和 tb 命令全靠它们
    assert.ok(flat.includes('TERMBOARD_NODE_ID=t1'), '节点 id 必须下发')
    assert.ok(flat.includes('TERMBOARD_HOOK_ENDPOINT=/x/endpoint.env'), 'endpoint 路径必须下发')
  }
})
