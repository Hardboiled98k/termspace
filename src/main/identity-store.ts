/**
 * Identity（凭证）存储 — Electron safeStorage（macOS Keychain 加密）
 * 密文落盘 userData/identities.bin；明文只在内存；渲染层只拿元数据（不含 env 值）
 */
import { app, safeStorage } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { isReservedEnvKey, materializeEnv, type ResolvedEnv } from './identity-env'
import { parseClaudeAuth, parseCodexLogin, type LoginStatus } from './login-status.ts'

// 展开规则搬到 identity-env.ts（不依赖 electron，才能被 node --test 覆盖）
export { materializeEnv } from './identity-env'
export type { ResolvedEnv } from './identity-env'

export interface Identity {
  id: string
  name: string
  provider: 'claude' | 'codex' | 'gemini' | 'custom'
  env: Record<string, string>
}

/** 渲染层可见的元数据：绝不含 env 值 */
export interface IdentityMeta {
  id: string
  name: string
  provider: Identity['provider']
  envKeys: string[]
}

const file = (): string => path.join(app.getPath('userData'), 'identities.bin')

let cache: Identity[] | null = null

async function load(): Promise<Identity[]> {
  if (cache) return cache
  if (!existsSync(file())) {
    cache = []
    return cache
  }
  try {
    const buf = await readFile(file())
    cache = JSON.parse(safeStorage.decryptString(buf)) as Identity[]
  } catch {
    // 解密失败（换机器/Keychain 变更）→ 视为空，不崩
    cache = []
  }
  return cache
}

async function persist(list: Identity[]): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用，拒绝明文存储凭证')
  }
  const buf = safeStorage.encryptString(JSON.stringify(list))
  const tmp = `${file()}.tmp`
  await writeFile(tmp, buf)
  await rename(tmp, file())
  cache = list
}

const toMeta = (i: Identity): IdentityMeta => ({
  id: i.id,
  name: i.name,
  provider: i.provider,
  envKeys: Object.keys(i.env)
})

export async function listIdentities(): Promise<IdentityMeta[]> {
  return (await load()).map(toMeta)
}

export async function upsertIdentity(input: {
  id?: string
  name: string
  provider: Identity['provider']
  env: Record<string, string>
}): Promise<IdentityMeta[]> {
  const list = await load()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.env)) {
    const key = k.trim()
    // 保留键（TERMBOARD_* / PATH / TMUX…）连存都不让存：见 identity-env.ts 的 RESERVED
    if (isReservedEnvKey(key)) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof v === 'string') env[key] = v
  }
  /* 没起名就按 provider 自动编号：codex1 / codex2…
     「未命名」在有多个订阅号时完全没法区分，等于逼用户每次都想名字。 */
  let name = input.name.trim().slice(0, 60)
  if (!name) {
    const used = new Set(list.filter((i) => i.provider === input.provider).map((i) => i.name))
    let n = 1
    while (used.has(`${input.provider}${n}`)) n++
    name = `${input.provider}${n}`
  }
  const existing = input.id ? list.find((i) => i.id === input.id) : undefined
  if (existing) {
    existing.name = name
    existing.provider = input.provider
    existing.env = env
  } else {
    list.push({ id: randomUUID(), name, provider: input.provider, env })
  }
  await persist(list)
  return list.map(toMeta)
}

/**
 * 只改名，不动 env。
 *
 * 单独一个入口是因为 upsert 会用传进来的 env 整体替换 —— 而渲染层**拿不到 env 值**
 * （只有 envKeys），想改名就必须重新输一遍全部密钥，等于不能改名。
 */
export async function renameIdentity(id: string, name: string): Promise<IdentityMeta[]> {
  const list = await load()
  const found = list.find((i) => i.id === id)
  if (found) {
    const next = name.trim().slice(0, 60)
    if (next) found.name = next
    await persist(list)
  }
  return list.map(toMeta)
}

export async function deleteIdentity(id: string): Promise<IdentityMeta[]> {
  const list = (await load()).filter((i) => i.id !== id)
  await persist(list)
  return list.map(toMeta)
}

export type { LoginStatus } from './login-status.ts'

const findBin = (name: string): string | null =>
  ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', `${process.env['HOME']}/.npm-global/bin`, `${process.env['HOME']}/.local/bin`]
    .map((d) => path.join(d, name))
    .find(existsSync) ?? null

/**
 * 这个凭证到底登没登录。**两家都能真查**，都是只读、不花额度：
 *   codex   `codex login status`
 *   claude  `claude auth status --json` → loggedIn / authMethod / email / subscriptionType
 *
 * ⚠️ 项目里一度写着"Claude 没有等价命令（穷举过 --help）"，**那是错的**
 * （codex 审查指出后实测通过，claude 2.1.220）。别再照抄那句话。
 *
 * 为什么这条必须有：`CODEX_HOME` / `CLAUDE_CONFIG_DIR` 只负责**隔离**，
 * 指向一个新目录时那个号是空的，第一次仍要登录一次。不显示登录态的话，
 * 用户拉完线会以为"连上了就是登录了"，然后对着一个永远不动的终端发呆。
 */
export async function identityLoginStatus(id: string): Promise<LoginStatus> {
  const found = (await load()).find((i) => i.id === id)
  if (!found) return { state: 'unknown', detail: '凭证不存在' }
  const { set } = materializeEnv(found.env, app.getPath('home'))

  if (found.provider === 'codex') {
    const home = set['CODEX_HOME'] || path.join(app.getPath('home'), '.codex')
    const bin = findBin('codex')
    if (!bin) return { state: 'unknown', detail: '本机没找到 codex', home }
    const out = await new Promise<string>((resolve) => {
      execFile(
        bin,
        ['login', 'status'],
        // 同上：整个 identity env 都传，凭证里配了 OPENAI_API_KEY 时认证来源就不是订阅
        { timeout: 8000, env: { ...process.env, ...set, CODEX_HOME: home } },
        (err, stdout, stderr) => resolve(err ? `${stdout}${stderr}` : stdout)
      )
    })
    /* **否定要先判**：`/Logged in/i` 会命中 "Not logged in"（子串就在里面），
       顺序反了的话未登录的号一律显示成"已登录" —— 而这个功能存在的唯一意义
       就是防止用户以为"连上线了就是登录了"。 */
    return parseCodexLogin(out, home)
  }

  if (found.provider === 'claude') {
    const home = set['CLAUDE_CONFIG_DIR']
    const bin = findBin('claude')
    if (!bin) return { state: 'unknown', detail: '本机没找到 claude', home }
    /* `claude auth status --json` 是只读的、不花额度。
       **整个 identity env 都要传**，不能只传 CLAUDE_CONFIG_DIR ——
       凭证里若配了 ANTHROPIC_API_KEY，认证来源就是 api_key 而不是订阅，
       只传目录会把这种情况报成"未登录"。 */
    const out = await new Promise<string>((resolve) => {
      execFile(
        bin,
        ['auth', 'status', '--json'],
        { timeout: 8000, env: { ...process.env, ...set } },
        (err, stdout, stderr) => resolve(err ? `${stdout}${stderr}` : stdout)
      )
    })
    return parseClaudeAuth(out, home)
  }
  return { state: 'unknown', detail: '该 provider 无法从外部查询登录态' }
}

/** pty spawn 时按 id 取 env 包（仅主进程内部使用） */
export async function resolveIdentityEnv(id: string | undefined): Promise<ResolvedEnv | null> {
  if (!id) return null
  const found = (await load()).find((i) => i.id === id)
  return found ? materializeEnv(found.env, app.getPath('home')) : null
}
