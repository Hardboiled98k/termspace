/**
 * tmux 会话续存（设计参考 ARCHITECTURE-NOTES.md §2）
 * - 专用 socket `termboard` + 自带 conf（不碰用户 ~/.tmux.conf）
 * - session 名 tb-<nodeId>，node id 即持久化键
 * - destroy-unattached off = 无客户端也活；只有显式 kill-session 才真结束
 * - PTY 直接 spawn tmux 客户端，`new-session -A -D`（有就接、没就建、踢旧客户端）
 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const SOCKET = 'termboard'

const CONF = `# TermBoard 托管 tmux 配置（自动生成，勿手改）
set -g status off
set -g mouse on
set -g history-limit 8000
set -g default-terminal "xterm-256color"
set -sg escape-time 10
set -g destroy-unattached off
setw -g aggressive-resize on
set -g set-clipboard on
set -as terminal-features ",*:clipboard"
`

let tmuxPath: string | null | undefined // undefined=未探测 null=没有
let confReady = false

function confPath(): string {
  return path.join(app.getPath('userData'), 'tmux.conf')
}

export async function ensureTmux(): Promise<string | null> {
  if (tmuxPath === undefined) {
    tmuxPath = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(existsSync) ?? null
  }
  if (tmuxPath && !confReady) {
    await writeFile(confPath(), CONF)
    confReady = true
  }
  return tmuxPath
}

export function sessionName(nodeId: string): string {
  return `tb-${nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function run(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    if (!tmuxPath) return resolve(false)
    execFile(tmuxPath, ['-L', SOCKET, ...args], { timeout: 5000 }, (err) => resolve(!err))
  })
}

export function hasSession(nodeId: string): Promise<boolean> {
  return run(['has-session', '-t', sessionName(nodeId)])
}

export function killSession(nodeId: string): Promise<boolean> {
  return run(['kill-session', '-t', sessionName(nodeId)])
}

/** 组装 PTY 程序与参数：tmux 可用 → tmux 客户端；否则纯 shell */
export function buildSpawnArgs(
  tmux: string | null,
  nodeId: string,
  shell: string,
  cwd: string,
  env: Record<string, string>
): { file: string; args: string[] } {
  if (!tmux) return { file: shell, args: ['-l'] }
  const args = ['-L', SOCKET, '-f', confPath(), 'new-session', '-A', '-D']
  // tmux server 长寿共享，env 不能靠继承（首个 session 的值会泄漏给后续）→ -e 显式注入。
  // 已存在的 session attach 时 -e 被忽略 = 会话保持自己的身份，语义正确。
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('TERMBOARD_') || k === 'TERM' || k === 'COLORTERM') continue // TERM 由 tmux 管
    if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_') || k.startsWith('CODEX_') || k.startsWith('GEMINI_')) {
      args.push('-e', `${k}=${v}`)
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('TERMBOARD_')) args.push('-e', `${k}=${v}`)
  }
  args.push('-c', cwd, '-s', sessionName(nodeId), shell, '-l')
  return { file: tmux, args }
}
