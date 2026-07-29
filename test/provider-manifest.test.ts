/**
 * provider 清单的展示合同。
 *
 * 钉的是 codex 自己在交付报告里点出的缺口：
 * 「新终端打开后，用户仍要自己知道每个 CLI 的登录命令」。
 *
 * 这不是能靠一句通用文案糊过去的 —— 各家形状根本不一样：
 * - claude 的登录是**进 TUI 之后的斜杠命令**，不是 shell 命令
 * - gemini / antigravity **没有 login 子命令**，首次运行自己弹 OAuth
 * - codex / cursor / copilot 才是 `<cmd> login`
 *
 * 全部在本机 `--help` 逐个核对过（2026-07-29）。
 * 所以这里的判据不是"字段非空"，而是**内容和该 CLI 的真实形状对得上**。
 *
 * 还钉住 OpenRouter 默认 Base URL 必须经过 API key 表单的保存路径落库；
 * 不能只写在没有消费者的 manifest 字段里，造成看似声明、实际丢失。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDERS, PROVIDER_MANIFEST_VERSION } from '../src/shared/provider-manifest.ts'

const byId = (id: string): (typeof PROVIDERS)[number] => {
  const p = PROVIDERS.find((x) => x.id === id)
  assert.ok(p, `清单里没有 ${id}`)
  return p
}

test('每个 provider 都必须有登录提示，不能留空', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.loginHint && p.loginHint.trim().length > 0, `${p.id} 没写 loginHint`)
  }
})

test('**有 login 子命令的三家，提示里就得是那条命令**', () => {
  assert.match(byId('codex').loginHint, /codex login/)
  assert.match(byId('cursor').loginHint, /cursor-agent login/)
  assert.match(byId('copilot').loginHint, /copilot login/)
})

test('**claude 的登录命令是 `claude auth login`**，不是 `claude login`', () => {
  /* 这条用例的**上一版是错的**：它断言"claude 没有 login 子命令、只能进 TUI 输 /login"，
     把我的错误认识固化成了断言 —— 本机 claude 2.1.220 实测
     `claude auth --help` 明确列出 `login`。codex 对手方审查逮到。
     教训：**manifest 测试只能验自洽，验不了外部 CLI 的真实形状** ——
     所以这里同时保留 `/login` 的老版本退路，且下面那条用例改成真去问 CLI。 */
  const h = byId('claude').loginHint
  assert.match(h, /claude auth login/)
  assert.ok(!/(?<!auth )claude login/.test(h), `claude 没有裸 login 子命令：${h}`)
})

test('**gemini / antigravity 没有 login 子命令**，不能凭样式套一条出来', () => {
  for (const id of ['gemini', 'antigravity']) {
    const p = byId(id)
    /* 判据是「不能出现一条**可执行的** `<命令> login`」——
       不是「不能出现 login 这个词」：文案里正要说明"没有 login 子命令"。 */
    for (const cmd of p.commands) {
      assert.ok(
        !new RegExp(`${cmd}\\s+login`).test(p.loginHint),
        `${id} 没有 login 子命令，提示却给了一条 \`${cmd} login\`：${p.loginHint}`
      )
    }
    assert.match(p.loginHint, /OAuth/, `${id} 该说明首次运行会走 OAuth：${p.loginHint}`)
  }
})

test('声称能目录隔离的，必须真的是订阅隔离那一档', () => {
  /* isolationCapability 和 authModes 是两处独立写的，容易漂。
     `directory` 却不支持 isolated-subscription = 界面会给用户一个
     点了没用的「独立登录空间」开关。 */
  for (const p of PROVIDERS) {
    if (p.isolationCapability === 'directory') {
      assert.ok(
        p.authModes.includes('isolated-subscription'),
        `${p.id} 说能按目录隔离，却不在订阅隔离档里`
      )
    }
  }
})

test('声称 api-key 认证的，必须给得出要填哪个变量', () => {
  for (const p of PROVIDERS) {
    if (p.authModes.includes('api-key')) {
      assert.ok(p.fields.length > 0, `${p.id} 说支持 API key 却没有字段可填`)
      for (const f of p.fields) assert.match(f.envKey, /^[A-Z][A-Z0-9_]*$/, `${p.id}.${f.id}`)
    }
  }
})

test('声称能目录隔离的，必须写了靠哪个变量隔离', () => {
  /* 少了它，`identity:createSubscription` 就只能在主进程里再硬编码一份映射 ——
     而那份硬编码正是 P0-4 的来源（三元表达式只取一个冲突变量）。 */
  for (const p of PROVIDERS) {
    if (p.isolationCapability === 'directory') {
      assert.ok(p.homeEnvKey, `${p.id} 说能按目录隔离却没写 homeEnvKey`)
      assert.match(p.homeEnvKey!, /^[A-Z][A-Z0-9_]*$/)
      assert.ok(p.conflictVariables.length > 0, `${p.id} 建隔离账号时不清任何冲突变量`)
    }
  }
})

test('清单有版本号（将来加字段要靠它做迁移）', () => {
  assert.ok(Number.isInteger(PROVIDER_MANIFEST_VERSION) && PROVIDER_MANIFEST_VERSION >= 1)
})

test('OpenRouter 的默认 Base URL 会随 API key 表单一起落库', () => {
  const spec = byId('openrouter')
  const rows = spec.fields.map((field) => ({
    key: field.envKey,
    action: 'set' as const,
    value: field.default ?? (field.secret ? 'test-api-key' : '')
  }))
  const envOps = spec.fields
    .map((field) => {
      const row = rows.find((candidate) => candidate.key === field.envKey)
      return row?.value ? { key: field.envKey, action: 'set' as const, value: row.value } : null
    })
    .filter((operation): operation is { key: string; action: 'set'; value: string } => !!operation)

  assert.deepEqual(
    envOps.find((operation) => operation.key === 'OPENAI_BASE_URL'),
    { key: 'OPENAI_BASE_URL', action: 'set', value: 'https://openrouter.ai/api/v1' }
  )
})

// ── 真去问 CLI：manifest 只能自洽，外部命令变了它不会知道 ──
test('**真跑 --help 核对登录子命令**（本机没装就跳过）', async () => {
  const { execFile } = await import('node:child_process')
  const has = (bin: string, sub: string): Promise<boolean | null> =>
    new Promise((resolve) => {
      execFile(bin, [...sub.split(' ').slice(0, -1), '--help'], { timeout: 10_000 }, (e, out, errOut) => {
        if (e && !out && !errOut) return resolve(null) // 没装
        resolve(new RegExp(`\\b${sub.split(' ').at(-1)}\\b`).test(`${out}${errOut}`))
      })
    })
  for (const [bin, sub] of [
    ['codex', 'login'],
    ['claude', 'auth login'],
    ['cursor-agent', 'login']
  ] as const) {
    const r = await has(bin, sub)
    if (r === null) continue // 本机没装
    assert.equal(r, true, `${bin} 的 --help 里找不到 ${sub} —— manifest 的 loginHint 该更新了`)
  }
})
