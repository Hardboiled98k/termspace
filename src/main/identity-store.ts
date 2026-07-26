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
import { materializeEnv, type ResolvedEnv } from './identity-env'

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

export interface LoginStatus {
  state: 'in' | 'out' | 'unknown'
  detail: string
  /** 这个号的隔离目录，给界面显示"它存在哪" */
  home?: string
}

const findBin = (name: string): string | null =>
  ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', `${process.env['HOME']}/.npm-global/bin`, `${process.env['HOME']}/.local/bin`]
    .map((d) => path.join(d, name))
    .find(existsSync) ?? null

/**
 * 这个凭证到底登没登录。
 *
 * **只有 codex 能真查**：`codex login status` 是只读的、~1s、不花任何额度。
 * Claude 没有等价命令（穷举过 `claude --help`），凭证又在 Keychain 里按 config dir 分区，
 * 从外面看不出来 —— 那就如实报 unknown，别猜。猜错了比不说更糟：
 * 用户会以为已登录，然后对着一个永远不动的终端发呆。
 *
 * 为什么这条必须有：`CODEX_HOME` 只负责**隔离**，指向一个新目录时那个号是空的，
 * 第一次仍然要在终端里跑一次 `codex login`。不显示登录态的话，
 * 用户拉完线会以为"连上了就是登录了"。
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
        { timeout: 8000, env: { ...process.env, CODEX_HOME: home } },
        (err, stdout, stderr) => resolve(err ? `${stdout}${stderr}` : stdout)
      )
    })
    if (/Logged in/i.test(out)) return { state: 'in', detail: out.trim().slice(0, 80), home }
    if (/Not logged in/i.test(out)) {
      return { state: 'out', detail: '未登录 —— 在连着的终端里跑一次 codex login', home }
    }
    return { state: 'unknown', detail: out.trim().slice(0, 80) || '查不出来', home }
  }

  if (found.provider === 'claude') {
    const home = set['CLAUDE_CONFIG_DIR']
    return {
      state: 'unknown',
      detail: home
        ? 'Claude 没有只读的查询命令，登录态只能进终端看'
        : '用系统默认的 Claude 登录态',
      home
    }
  }
  return { state: 'unknown', detail: '该 provider 无法从外部查询登录态' }
}

/** pty spawn 时按 id 取 env 包（仅主进程内部使用） */
export async function resolveIdentityEnv(id: string | undefined): Promise<ResolvedEnv | null> {
  if (!id) return null
  const found = (await load()).find((i) => i.id === id)
  return found ? materializeEnv(found.env, app.getPath('home')) : null
}
