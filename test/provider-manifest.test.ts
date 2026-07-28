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

test('**claude 的登录是 TUI 内的斜杠命令**，写成 `claude login` 就是错的', () => {
  const h = byId('claude').loginHint
  assert.match(h, /\/login/, '要指明是 /login')
  assert.ok(!/claude login/.test(h), `claude 没有 login 子命令，别写成 shell 命令：${h}`)
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

test('清单有版本号（将来加字段要靠它做迁移）', () => {
  assert.ok(Number.isInteger(PROVIDER_MANIFEST_VERSION) && PROVIDER_MANIFEST_VERSION >= 1)
})
