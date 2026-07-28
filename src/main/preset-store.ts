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

/* 写盘串行化 + 随机 tmp。设置面板里两次点击可以并发进 IPC，而共用一个固定
   `.tmp` 时后一次 rename 会撞上 ENOENT（前一次已经改名走了），或者两个写者
   交错把半份内容 rename 成正式文件。identity/settings 早就这么做了，
   这里一直低一档 —— 这类问题只在慢盘或手快的用户身上出现，测试撞不到。 */
let writeChain: Promise<unknown> = Promise.resolve()

function persist(list: Preset[]): Promise<void> {
  const run = writeChain.then(async () => {
    const tmp = `${file()}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(list, null, 2))
    await rename(tmp, file())
    // **落盘成功才更新缓存**：写失败时内存和磁盘不能分叉
    cache = list
  })
  writeChain = run.catch(() => undefined) // 一环失败不卡死后续写入
  return run
}

export async function listPresets(): Promise<Preset[]> {
  return load()
}

export async function upsertPreset(input: Omit<Preset, 'id'> & { id?: string }): Promise<Preset[]> {
  const cur = await load()
  const clean = {
    name: input.name.trim().slice(0, 40) || '未命名',
    provider: input.provider,
    command: input.command.trim().slice(0, 500),
    identityId: input.identityId || undefined
  }
  /* **在副本上改**，不原地 Object.assign 那个 cache 里的对象 ——
     落盘失败时内存里已经是新值了，而磁盘还是旧的，两边就此分叉 */
  const hit = input.id ? cur.some((p) => p.id === input.id) : false
  const list = hit
    ? cur.map((p) => (p.id === input.id ? { ...p, ...clean } : p))
    : [...cur, { id: randomUUID(), ...clean }]
  await persist(list)
  return list
}

export async function deletePreset(id: string): Promise<Preset[]> {
  const list = (await load()).filter((p) => p.id !== id)
  await persist(list)
  return list
}
