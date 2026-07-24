/**
 * Agent 状态 hook 系统（设计参考 ARCHITECTURE-NOTES.md §3）
 *
 * Claude Code hook → 托管脚本 → POST 127.0.0.1:<随机port> → 归一化 → 回调
 * - 端口/token 写 endpoint 文件（0600），脚本每次调用时 source（app 重启端口会变）
 * - 脚本用 TERMBOARD_NODE_ID 门控：非 TermBoard 终端瞬间 exit 0
 * - 全链路 fail-open：任何错误 204，永不阻塞 agent
 */
import { app } from 'electron'
import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export type AgentState = 'working' | 'waiting' | 'blocked' | 'done' | 'session'

export interface AgentStatusEvent {
  nodeId: string
  agentId: string
  state: AgentState
  newTurn: boolean
}

const CLAUDE_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'PermissionRequest',
  'Notification',
  'SessionStart',
  'SessionEnd'
] as const

const MARKER = 'termboard' // settings.json 里识别我方 hook 条目的标记（含于脚本路径）
const BODY_LIMIT = 1024 * 1024

function normalizeClaude(event: string, payload: unknown): AgentState | null {
  const p = payload as { message?: unknown } | null
  switch (event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Stop':
    case 'StopFailure': // API 错误时没有正常 Stop，不订会永卡 RUNNING
      return 'done'
    case 'PermissionRequest':
      return 'blocked'
    case 'Notification': {
      const msg = String(p?.message ?? '')
      // idle_prompt 在正常 Stop 后才发，映射会让 done 节点卡在 NEEDS YOU
      if (/waiting for your input/i.test(msg)) return null
      if (/permission/i.test(msg)) return 'blocked'
      return 'waiting'
    }
    case 'SessionStart':
    case 'SessionEnd':
      return 'session'
    default:
      return null
  }
}

function buildScript(): string {
  // POSIX sh；$1 = hook 事件名；stdin = hook JSON payload
  return `#!/bin/sh
# TermBoard managed hook — 非 TermBoard 终端瞬间退出，可安全常驻
[ -n "$TERMBOARD_NODE_ID" ] || exit 0
[ -n "$TERMBOARD_HOOK_ENDPOINT" ] || exit 0
[ -f "$TERMBOARD_HOOK_ENDPOINT" ] || exit 0
. "$TERMBOARD_HOOK_ENDPOINT" 2>/dev/null || exit 0
[ -n "$TERMBOARD_HOOK_PORT" ] || exit 0
payload=$(cat 2>/dev/null || true)
curl -s -m 2 -o /dev/null \\
  -H "X-Termboard-Token: $TERMBOARD_HOOK_TOKEN" \\
  --data-urlencode "nodeId=$TERMBOARD_NODE_ID" \\
  --data-urlencode "event=$1" \\
  --data-urlencode "payload=$payload" \\
  "http://127.0.0.1:$TERMBOARD_HOOK_PORT/hook/claude" 2>/dev/null || true
exit 0
`
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, file)
}

interface HookGroup {
  matcher?: string
  hooks?: { type?: string; command?: string }[]
}

/** 把托管 hook 合并进 ~/.claude/settings.json（幂等，marker 识别，保留用户条目，首次备份） */
async function installClaudeHooks(scriptPath: string): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    } catch {
      return // 用户 settings 损坏时绝不覆写
    }
    const backup = `${settingsPath}.termboard-backup`
    if (!existsSync(backup)) await copyFile(settingsPath, backup)
  }

  const hooks = (settings['hooks'] ??= {}) as Record<string, HookGroup[]>
  let changed = false
  for (const ev of CLAUDE_EVENTS) {
    const cmd = `sh "${scriptPath}" ${ev}`
    const arr = Array.isArray(hooks[ev]) ? hooks[ev] : []
    // 去掉旧版本我方条目（路径变更时），保留用户条目
    const kept = arr.filter(
      (g) => !g.hooks?.some((h) => typeof h.command === 'string' && h.command.includes(MARKER))
    )
    const already =
      arr.length === kept.length + 1 &&
      arr.some((g) => g.hooks?.some((h) => h.command === cmd))
    if (!already) {
      kept.push({ hooks: [{ type: 'command', command: cmd }] })
      hooks[ev] = kept
      changed = true
    }
  }
  if (changed) {
    await writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  }
}

export interface HookSystem {
  endpointFile: string
  dispose: () => void
}

export async function startHookSystem(
  onStatus: (e: AgentStatusEvent) => void
): Promise<HookSystem> {
  const dir = app.getPath('userData')
  const hooksDir = path.join(dir, 'hooks')
  await mkdir(hooksDir, { recursive: true })

  const scriptPath = path.join(hooksDir, 'claude-status.sh')
  await writeAtomic(scriptPath, buildScript())
  await chmod(scriptPath, 0o755)
  await installClaudeHooks(scriptPath)

  const token = randomUUID()
  const tokenBuf = Buffer.from(token)

  const server = http.createServer((req, res) => {
    // fail-open：一切异常 204 收尾，绝不让 hook 卡住 agent
    const done = (): void => {
      res.statusCode = 204
      res.end()
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/hook/')) return done()
    req.setTimeout(2000, () => req.destroy())

    const given = Buffer.from(String(req.headers['x-termboard-token'] ?? ''))
    const authed = given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf)

    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_LIMIT) req.destroy()
      else chunks.push(c)
    })
    req.on('error', done)
    req.on('end', () => {
      try {
        if (!authed) return done()
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        const nodeId = body.get('nodeId') ?? ''
        const event = body.get('event') ?? ''
        if (!nodeId || !event) return done()
        let payload: unknown = null
        try {
          payload = JSON.parse(body.get('payload') ?? 'null')
        } catch {
          // payload 解析失败不影响状态事件本身
        }
        const state = normalizeClaude(event, payload)
        if (state) {
          onStatus({ nodeId, agentId: 'claude', state, newTurn: event === 'UserPromptSubmit' })
        }
      } catch {
        // fail-open
      }
      done()
    })
  })

  const endpointFile = path.join(dir, 'hook-endpoint.env')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await writeAtomic(endpointFile, `TERMBOARD_HOOK_PORT=${port}\nTERMBOARD_HOOK_TOKEN=${token}\n`)
  await chmod(endpointFile, 0o600)

  return {
    endpointFile,
    dispose: () => server.close()
  }
}
