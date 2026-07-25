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
  /**
   * 是否把托管 hook 写进用户全局的 ~/.claude/settings.json。
   * 'ask' = 还没问过（首启会弹窗征得同意）。改用户全局配置这种事不能默默做。
   */
  claudeHooks: 'ask' | 'on' | 'off'
  /** 远程 API（手机/其他电脑当客户端）。默认关闭，只绑 127.0.0.1 */
  remoteEnabled: boolean
  /** 远程端能否往终端写入。默认只读 —— 写入是把 shell 交出去，必须显式开 */
  remoteAllowInput: boolean
  /** 远程端能否批准工具调用。默认关 —— 批一次 rm -rf 比敲一行字危险得多 */
  remoteAllowApprove: boolean
  remotePort: number
}

export const DEFAULTS: Settings = {
  defaultFontSize: 13,
  defaultShell: '',
  tmuxEnabled: true,
  scrollback: 8000,
  skillDirs: [],
  claudeHooks: 'ask',
  remoteEnabled: false,
  remoteAllowInput: false,
  remoteAllowApprove: false,
  remotePort: 7333
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
  next.remotePort = Math.min(65535, Math.max(1024, Math.round(next.remotePort || 7333)))
  const tmp = `${file()}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2))
  await rename(tmp, file())
  cache = next
  return next
}
