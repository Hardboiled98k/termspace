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

async function load(): Promise<Targets> {
  if (cache) return cache
  if (!existsSync(file())) return (cache = {})
  try {
    const buf = await readFile(file())
    cache = JSON.parse(safeStorage.decryptString(buf)) as Targets
  } catch {
    /* 解密失败 = 换了机器/钥匙串变了。**返回空而不是抛** ——
       调用方看到"这个连接没配"，比整个功能崩掉好；用户重填一次即可。 */
    cache = {}
  }
  return cache
}

let chain: Promise<unknown> = Promise.resolve()
function persist(next: Targets): Promise<void> {
  const run = chain.then(async () => {
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

/** **只在主进程内调用**。别给它加 IPC —— 那等于把这层设计抹掉 */
export async function getBrokerTarget(id: string): Promise<string | null> {
  return (await load())[id] ?? null
}
