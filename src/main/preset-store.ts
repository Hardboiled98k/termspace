/**
 * Agent 节点预设（F6）— 明文 JSON（不含密钥，密钥走 identity 引用）
 */
import { app } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export interface Preset {
  id: string
  name: string
  provider: 'claude' | 'codex' | 'gemini' | 'custom'
  command: string // spawn 后写入 shell 的启动命令，空 = 纯终端
  identityId?: string
}

const DEFAULTS: Preset[] = [
  { id: 'p-claude', name: 'Claude Code', provider: 'claude', command: 'claude' },
  {
    id: 'p-claude-ctx',
    name: 'Claude ＋共享上下文',
    provider: 'claude',
    // F2：启动时把 Hub 文件注入 system prompt（文件为空则无害）
    command: 'claude --append-system-prompt "$(cat "$TERMBOARD_CONTEXT_FILE" 2>/dev/null)"'
  },
  { id: 'p-codex', name: 'Codex', provider: 'codex', command: 'codex' },
  { id: 'p-gemini', name: 'Gemini', provider: 'gemini', command: 'gemini' }
]

const file = (): string => path.join(app.getPath('userData'), 'presets.json')
let cache: Preset[] | null = null

async function load(): Promise<Preset[]> {
  if (cache) return cache
  if (!existsSync(file())) {
    cache = [...DEFAULTS]
    return cache
  }
  try {
    cache = JSON.parse(await readFile(file(), 'utf8')) as Preset[]
    // 补齐新增的内置预设（老 presets.json 里没有的）
    for (const d of DEFAULTS) {
      if (!cache.some((p) => p.id === d.id)) cache.push({ ...d })
    }
  } catch {
    cache = [...DEFAULTS]
  }
  return cache
}

async function persist(list: Preset[]): Promise<void> {
  const tmp = `${file()}.tmp`
  await writeFile(tmp, JSON.stringify(list, null, 2))
  await rename(tmp, file())
  cache = list
}

export async function listPresets(): Promise<Preset[]> {
  return load()
}

export async function upsertPreset(input: Omit<Preset, 'id'> & { id?: string }): Promise<Preset[]> {
  const list = await load()
  const existing = input.id ? list.find((p) => p.id === input.id) : undefined
  const clean = {
    name: input.name.trim().slice(0, 40) || '未命名',
    provider: input.provider,
    command: input.command.trim().slice(0, 500),
    identityId: input.identityId || undefined
  }
  if (existing) Object.assign(existing, clean)
  else list.push({ id: randomUUID(), ...clean })
  await persist(list)
  return list
}

export async function deletePreset(id: string): Promise<Preset[]> {
  const list = (await load()).filter((p) => p.id !== id)
  await persist(list)
  return list
}
