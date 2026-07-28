/**
 * 在编辑器/Finder 里打开一个路径。
 *
 * **这是一条把用户可控字符串交给子进程的路**，所以判据先行：
 *
 * - 编辑器只认**白名单里的命令**，不接受任意字符串。用户填 `code`、`cursor`、
 *   `zed`… 我们查表拿到真实二进制；填别的就退回 `open -R`（Finder 里定位）。
 *   不这么做的话，"编辑器命令"这个设置项就是一个任意命令执行入口。
 * - 一律 `execFile` + 参数数组，**永不拼 shell 串**。
 * - 路径必须绝对、不含 NUL，且必须真实存在 —— 相对路径会按主进程的 cwd 解析，
 *   那是 app 自己的目录，跟用户想开的东西毫无关系。
 *
 * 为什么不用 `shell.openPath`：那个只会用系统默认程序打开，
 * 而"用我的编辑器打开这个仓库"正是这个功能的全部意义。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 命令名 → 可执行文件的候选位置。Finder 启动不继承登录 shell 的 PATH，所以要绝对路径 */
const EDITORS: Record<string, string[]> = {
  code: ['/opt/homebrew/bin/code', '/usr/local/bin/code'],
  cursor: ['/opt/homebrew/bin/cursor', '/usr/local/bin/cursor'],
  zed: ['/opt/homebrew/bin/zed', '/usr/local/bin/zed'],
  subl: ['/opt/homebrew/bin/subl', '/usr/local/bin/subl'],
  webstorm: ['/opt/homebrew/bin/webstorm', '/usr/local/bin/webstorm'],
  idea: ['/opt/homebrew/bin/idea', '/usr/local/bin/idea'],
  nvim: ['/opt/homebrew/bin/nvim', '/usr/local/bin/nvim', '/usr/bin/nvim']
}

/** 白名单里的编辑器名 → 真实二进制路径；不认识或没装返回 null */
export function resolveEditor(name: string): string | null {
  const key = name.trim().toLowerCase()
  const cands = EDITORS[key]
  if (!cands) return null
  return cands.find(existsSync) ?? null
}

export function editorNames(): string[] {
  return Object.keys(EDITORS)
}

export interface OpenResult {
  ok: boolean
  /** 实际用了什么打开的，界面上如实显示（回退到 Finder 时用户要知道） */
  via?: string
  error?: string
}

export async function openInEditor(target: string, editor: string): Promise<OpenResult> {
  if (!target || !path.isAbsolute(target) || target.includes('\0')) {
    return { ok: false, error: '路径不合法（必须是绝对路径）' }
  }
  if (!existsSync(target)) return { ok: false, error: `路径不存在：${target}` }

  const bin = resolveEditor(editor)
  const run = (cmd: string, args: string[], via: string): Promise<OpenResult> =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 10_000 }, (err) =>
        resolve(err ? { ok: false, via, error: String(err.message ?? err) } : { ok: true, via })
      )
    })

  if (bin) return run(bin, [target], editor)
  /* 没配 / 没装 / 不在白名单 → 在 Finder 里定位。
     **不静默失败**：via 会如实回报是走了 Finder，界面据此提示"没找到那个编辑器"。 */
  return run('/usr/bin/open', ['-R', target], 'finder')
}
