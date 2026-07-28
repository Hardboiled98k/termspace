/**
 * Identity（凭证）存储 — Electron safeStorage（macOS Keychain 加密）
 * 密文落盘 userData/identities.bin；明文只在内存；渲染层只拿元数据（不含 env 值）
 */
import { app, safeStorage } from 'electron'
import { readFile, writeFile, rename, unlink, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import path from 'node:path'
import {
  applyIdentityEnv,
  billingKind,
  isReservedEnvKey,
  materializeEnvOps,
  type ResolvedEnv
} from './identity-env'
import {
  identityMeta,
  migrateIdentity,
  type EnvOp,
  type StoredIdentity
} from './identity-model.ts'
import { parseClaudeAuth, parseCodexLogin, type LoginStatus } from './login-status.ts'

// 展开规则搬到 identity-env.ts（不依赖 electron，才能被 node --test 覆盖）
export { materializeEnv } from './identity-env'
export type { ResolvedEnv } from './identity-env'

export type IdentityProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'copilot'
  | 'cursor'
  | 'antigravity'
  | 'openrouter'
  | 'custom'
export interface Identity extends StoredIdentity {
  provider: IdentityProvider
}

/** 渲染层可见的元数据：绝不含 env 值 */
export interface IdentityMeta {
  id: string
  name: string
  provider: Identity['provider']
  envOps: { key: string; action: EnvOp['action'] }[]
}

export type EnvEditOp =
  | EnvOp
  | { key: string; action: 'retain' | 'delete' }
  | { key: string; action: 'replace'; value: string }

const file = (): string => path.join(app.getPath('userData'), 'identities.bin')

let cache: Identity[] | null = null
/**
 * 库存在但读不出来（解密失败 / JSON 坏了）。
 *
 * **这个状态必须和"库是空的"分开**。原来两者都是 `cache = []`，于是：
 * 解密失败 → 界面显示"还没有凭证" → 用户新建一个 → persist 把只含这一个的列表
 * 写回去 → **原来那份密文被整个覆盖，所有钥匙一次性丢光**。
 * 换机器、Keychain 变更、磁盘半坏都会触发，而且用户毫无察觉。
 */
let readError: string | null = null

async function load(): Promise<Identity[]> {
  if (cache) return cache
  if (!existsSync(file())) {
    // 文件不存在 = 真的还没有凭证，这是合法的空
    cache = []
    return cache
  }
  try {
    const buf = await readFile(file())
    const parsed = JSON.parse(safeStorage.decryptString(buf)) as unknown
    if (!Array.isArray(parsed)) throw new Error('不是数组')
    readError = null
    const needsMigration = parsed.some(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        'env' in item &&
        !Array.isArray((item as { envOps?: unknown }).envOps)
    )
    cache = parsed.map((item) => migrateIdentity(item) as Identity)
    // 不是只在内存里“兼容读取”：成功解密后立刻把旧格式原子重写成 envOps。
    // 这样下一版删掉兼容分支时，空串=unset 的历史语义也不会漂移。
    if (needsMigration) {
      /* **重写前留一份原始密文**。这是对用户真实凭证的**单向**格式转换：
         `""` 的语义（删掉这个变量，防订阅号被 API key 顶走）迁错一次，
         用户不会看到报错，只会在月底账单上看到。
         项目对 workspace.json 已有同一条判据（tmp+rename + .bak + 损坏隔离），
         凭证比画布更值钱，没理由反而没有退路。
         备份失败**不阻断迁移** —— 迁移本身是对的，备份只是保险。 */
      await copyFile(file(), `${file()}.pre-envops.bak`).catch((err) =>
        console.error('凭证迁移前的备份没写成（迁移继续）：', err)
      )
      await persist(cache)
    }
  } catch (e) {
    // **绝不 cache=[]**：那会让后续任何一次写入把整库抹平
    readError = String((e as Error)?.message ?? e)
    console.error('凭证库读不出来，已进入只读保护：', readError)
    return []
  }
  return cache
}

/** 库是不是处于"读不出来"的只读保护态 */
export function identityStoreError(): string | null {
  return readError
}

/* 所有写操作排队。并发的 upsert/delete 会争同一个 tmp 文件，
   可能 rename ENOENT 或磁盘与内存分叉（丢一把钥匙） */
let writeChain: Promise<unknown> = Promise.resolve()
const serializeWrite = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = writeChain.then(fn, fn)
  writeChain = next.catch(() => undefined)
  return next
}

async function persist(list: Identity[]): Promise<void> {
  // 读都读不出来时**拒绝写**，否则就是拿一个残缺的内存视图去覆盖真库
  if (readError) {
    throw new Error(`凭证库当前读不出来（${readError}），已拒绝写入以免覆盖原文件`)
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用，拒绝明文存储凭证')
  }
  const buf = safeStorage.encryptString(JSON.stringify(list))
  // 随机后缀：两次并发写不会撞同一个 tmp
  const tmp = `${file()}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, buf)
    await rename(tmp, file())
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
  cache = list
}

const toMeta = (i: Identity): IdentityMeta => identityMeta(i) as IdentityMeta

export async function listIdentities(): Promise<IdentityMeta[]> {
  return (await load()).map(toMeta)
}

async function upsertIdentityInner(input: {
  id?: string
  name: string
  provider: Identity['provider']
  envOps: EnvEditOp[]
}): Promise<IdentityMeta[]> {
  const list = await load()
  const current = input.id ? list.find((i) => i.id === input.id) : undefined
  const oldByKey = new Map(current?.envOps.map((op) => [op.key, op]) ?? [])
  const envOps: EnvOp[] = []
  for (const op of input.envOps) {
    const key = op.key.trim()
    // 保留键（TERMBOARD_* / PATH / TMUX…）连存都不让存：见 identity-env.ts 的 RESERVED
    if (isReservedEnvKey(key)) throw new Error(`不允许把危险环境变量 ${key} 保存为凭证`)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量名无效：${key}`)
    if (op.action === 'delete') continue
    if (op.action === 'retain') {
      const old = oldByKey.get(key)
      if (old) envOps.push(old)
    } else if (op.action === 'unset') envOps.push({ key, action: 'unset' })
    else if (op.action === 'set' || op.action === 'replace') {
      if (typeof op.value !== 'string' || !op.value) {
        throw new Error(`设置 ${key} 时必须提供新值`)
      }
      envOps.push({ key, action: 'set', value: op.value })
    }
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
  /* 不可变副本：原来是就地改共享 cache，写盘失败时内存已经变了，
     界面显示的是"改成功了"，磁盘上还是旧的 */
  const next = list.map((i) => ({ ...i }))
  const existing = input.id ? next.find((i) => i.id === input.id) : undefined
  if (existing) {
    existing.name = name
    existing.provider = input.provider
    existing.envOps = envOps
  } else {
    next.push({ id: randomUUID(), name, provider: input.provider, envOps })
  }
  await persist(next)
  return next.map(toMeta)
}

/**
 * 只改名，不动 env。
 *
 * 单独一个入口是因为 upsert 会用传进来的 env 整体替换 —— 而渲染层**拿不到 env 值**
 * （只有 envOps 的 key/action），想改名就必须重新输一遍全部密钥，等于不能改名。
 */
async function renameIdentityInner(id: string, name: string): Promise<IdentityMeta[]> {
  const list = (await load()).map((i) => ({ ...i }))
  const found = list.find((i) => i.id === id)
  if (found) {
    const trimmed = name.trim().slice(0, 60)
    if (trimmed) found.name = trimmed
    await persist(list)
  }
  return list.map(toMeta)
}

async function deleteIdentityInner(id: string): Promise<IdentityMeta[]> {
  const list = (await load()).filter((i) => i.id !== id).map((i) => ({ ...i }))
  await persist(list)
  return list.map(toMeta)
}

/* 对外的三个写入口一律串行 —— 见 serializeWrite 的注释 */
export const upsertIdentity = (
  input: Parameters<typeof upsertIdentityInner>[0]
): Promise<IdentityMeta[]> => serializeWrite(() => upsertIdentityInner(input))
export const renameIdentity = (id: string, name: string): Promise<IdentityMeta[]> =>
  serializeWrite(() => renameIdentityInner(id, name))
export const deleteIdentity = (id: string): Promise<IdentityMeta[]> =>
  serializeWrite(() => deleteIdentityInner(id))

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
  const resolved = materializeEnvOps(found.envOps, app.getPath('home'))
  const { set } = resolved
  /* **必须带上 unset**：订阅型凭证配了 `ANTHROPIC_API_KEY=` 时终端里那把 key 是删掉的，
     这里若只合并 set，查出来会是 `api_key` → 界面显示「按量计费」，
     和这个终端实际的计费方式正好相反。 */
  const probeEnv = applyIdentityEnv(process.env, resolved)

  /* **带着 API key 时别去查登录态。** CLI 见到 OPENAI_API_KEY / ANTHROPIC_API_KEY
     就走按量计费，`CODEX_HOME` 里躺着哪个订阅号都不改变这个事实 —— 去查只会把
     那个目录里**另一个订阅号**的"已登录"显示在这个凭证名下，用户以为在烧订阅额度，
     实际每次调用都在出账单。判据和额度面板共用 billingKind，两处不能各写一套。 */
  if (billingKind(probeEnv, found.provider) === 'api-key') {
    return { state: 'unknown', detail: '按量计费（API key），没有订阅登录态' }
  }

  if (found.provider === 'codex') {
    const home = set['CODEX_HOME'] || path.join(app.getPath('home'), '.codex')
    const bin = findBin('codex')
    if (!bin) return { state: 'unknown', detail: '本机没找到 codex', home }
    const out = await new Promise<string>((resolve) => {
      execFile(
        bin,
        ['login', 'status'],
        { timeout: 8000, env: { ...probeEnv, CODEX_HOME: home } },
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
        { timeout: 8000, env: probeEnv },
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
  return found ? materializeEnvOps(found.envOps, app.getPath('home')) : null
}
