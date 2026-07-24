/**
 * Identity（凭证）存储 — Electron safeStorage（macOS Keychain 加密）
 * 密文落盘 userData/identities.bin；明文只在内存；渲染层只拿元数据（不含 env 值）
 */
import { app, safeStorage } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

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
  const name = input.name.trim().slice(0, 60) || '未命名'
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

export async function deleteIdentity(id: string): Promise<IdentityMeta[]> {
  const list = (await load()).filter((i) => i.id !== id)
  await persist(list)
  return list.map(toMeta)
}

/** pty spawn 时按 id 取 env 包（仅主进程内部使用） */
export async function resolveIdentityEnv(
  id: string | undefined
): Promise<Record<string, string> | null> {
  if (!id) return null
  const found = (await load()).find((i) => i.id === id)
  return found ? { ...found.env } : null
}
