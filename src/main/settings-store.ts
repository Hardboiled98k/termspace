/** 系统级设置（明文 JSON，无敏感信息） */
import { app } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface Settings {
  defaultFontSize: number
  defaultShell: string // '' = 跟随 $SHELL
  tmuxEnabled: boolean
  scrollback: number
  skillDirs: string[] // F8 工具中枢的 skill 库来源
}

export const DEFAULTS: Settings = {
  defaultFontSize: 13,
  defaultShell: '',
  tmuxEnabled: true,
  scrollback: 8000,
  skillDirs: []
}

const file = (): string => path.join(app.getPath('userData'), 'settings.json')
let cache: Settings | null = null

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  if (!existsSync(file())) {
    cache = { ...DEFAULTS }
    return cache
  }
  try {
    cache = { ...DEFAULTS, ...(JSON.parse(await readFile(file(), 'utf8')) as Partial<Settings>) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings()
  const next: Settings = { ...cur, ...patch }
  // 收敛到合法范围，防手改文件把 app 搞崩
  next.defaultFontSize = Math.min(24, Math.max(8, Math.round(next.defaultFontSize)))
  next.scrollback = Math.min(100000, Math.max(500, Math.round(next.scrollback)))
  const tmp = `${file()}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2))
  await rename(tmp, file())
  cache = next
  return next
}
