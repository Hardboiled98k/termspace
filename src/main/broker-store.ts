/**
 * 代理连接的**连接串**存储 —— safeStorage（macOS Keychain）加密，单独一个文件。
 *
 * 为什么不塞进 `identities.bin`：那是"注入终端的环境变量"，
 * 而这里的东西**恰恰绝不注入终端** —— 两者的安全语义相反，
 * 混在一起早晚会有人写出一段"顺手把它也注进去"的代码。
 *
 * 为什么不放 settings.json：它是明文的，而 postgres 连接串通常带密码。
 *
 * 渲染层永远只拿得到 `id/name/kind/readOnly`（那些在 settings 里），
 * 连接串**只在主进程内流转**，连 IPC 都不出去。
 */
import { app, safeStorage } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const file = (): string => path.join(app.getPath('userData'), 'brokers.bin')

/** id → 连接串 */
type Targets = Record<string, string>
let cache: Targets | null = null
/**
 * 库存在但读不出来（解密失败 / JSON 坏了）。
 *
 * **必须和"库是空的"分开** —— 这是 `identity-store.ts` 已经修过的同一条判据，
 * 而这里当初原样复制了坏的那一版（注释还写着"返回空比崩掉好，用户重填一次即可"）。
 *
 * 为什么"重填一次"不成立：broker 的**元数据在明文 settings.json 里**，
 * 只有连接串在 `brokers.bin`。所以解密一失败，设置面板照常列出全部连接、
 * `tb db prod` 报「还没配连接串」，用户去重填 —— 而那次保存会
 * `persist({...cache, [id]: 新串})`，**把内存里那份空表当成真库写回去，
 * 其余所有连接串一次性丢光**。换机器、钥匙串变更、磁盘半坏都会触发。
 */
let readError: string | null = null

async function load(): Promise<Targets> {
  if (cache) return cache
  if (!existsSync(file())) return (cache = {})
  try {
    const buf = await readFile(file())
    cache = JSON.parse(safeStorage.decryptString(buf)) as Targets
  } catch (e) {
    /* **绝不 cache = {}** —— 那会让后续任何一次写入把整库抹平（见上面 readError 的注释）。
       返回一份**不缓存**的空表：读的人看到"这个连接没配"，而写的人会被 persist 拒掉。 */
    readError = String((e as Error)?.message ?? e)
    console.error('代理连接库读不出来，已进入只读保护：', readError)
    return {}
  }
  return cache
}

let chain: Promise<unknown> = Promise.resolve()
function persist(next: Targets): Promise<void> {
  const run = chain.then(async () => {
    // 读都读不出来时**拒绝写**，否则就是拿一个残缺的内存视图去覆盖真库
    if (readError) {
      throw new Error(`代理连接库当前读不出来（${readError}），已拒绝写入以免覆盖原文件`)
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法加密保存')
    const tmp = `${file()}.${randomUUID().slice(0, 8)}.tmp`
    // 0600 在创建那一刻就给（见 write-atomic.ts 里那条判据）
    await writeFile(tmp, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 })
    await rename(tmp, file())
    cache = next
  })
  chain = run.catch(() => undefined)
  return run
}

export async function setBrokerTarget(id: string, target: string): Promise<void> {
  const cur = await load()
  await persist({ ...cur, [id]: target })
}

export async function deleteBrokerTarget(id: string): Promise<void> {
  const cur = await load()
  const next = { ...cur }
  delete next[id]
  await persist(next)
}

/** 库是不是处于"读不出来"的只读保护态（设置面板要如实说，不能显示成"还没配"） */
export function brokerStoreError(): string | null {
  return readError
}

/** **只在主进程内调用**。别给它加 IPC —— 那等于把这层设计抹掉 */
export async function getBrokerTarget(id: string): Promise<string | null> {
  return (await load())[id] ?? null
}
