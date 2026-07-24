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
  binDir: string // 注入 PATH 的目录（内含 tb 命令）
  dispose: () => void
}

/** F8：tb 命令 —— agent 在终端里直接调，零常驻 token */
function buildTbScript(): string {
  return `#!/bin/sh
# TermBoard 工具中枢客户端（自动生成）
[ -n "$TERMBOARD_HOOK_ENDPOINT" ] && [ -f "$TERMBOARD_HOOK_ENDPOINT" ] && . "$TERMBOARD_HOOK_ENDPOINT"
if [ -z "$TERMBOARD_HOOK_PORT" ]; then echo "tb: TermBoard 服务不可用（请在 TermBoard 终端内使用）" >&2; exit 1; fi
BASE="http://127.0.0.1:$TERMBOARD_HOOK_PORT"
H="X-Termboard-Token: $TERMBOARD_HOOK_TOKEN"
cmd="$1"; shift 2>/dev/null
case "$cmd" in
  skills|search)
    curl -s -H "$H" --get --data-urlencode "q=$*" "$BASE/tb/skills" ;;
  load|skill)
    curl -s -H "$H" --get --data-urlencode "name=$*" "$BASE/tb/load" ;;
  agents|ls)
    curl -s -H "$H" "$BASE/tb/agents" ;;
  ask|delegate)
    target="$1"; shift 2>/dev/null
    if [ -z "$target" ] || [ -z "$*" ]; then echo "用法: tb ask <节点id> <任务>" >&2; exit 2; fi
    # 派活是同步等待（可能几分钟），拉长超时
    curl -s -m 300 -H "$H" --get \
      --data-urlencode "target=$target" --data-urlencode "task=$*" "$BASE/tb/ask" ;;
  ""|help|-h|--help)
    cat <<'EOF'
tb — TermBoard 工具中枢

  tb skills <关键词>       搜索可用 skill（返回名称 + 一行说明）
  tb load <名称>           取出该 skill 全文，按其指示执行
  tb agents                列出本画布上的其他 agent 终端
  tb ask <节点id> <任务>   把任务派给另一个终端里的 agent，等它做完返回结果

用法：先 skills 找、load 取全文，不要凭记忆猜 skill。
派活前先 tb agents 看有哪些节点，再 tb ask <id> "任务描述"。
EOF
    ;;
  *) echo "tb: 未知命令 '$cmd'（tb help 查看用法）" >&2; exit 2 ;;
esac
`
}

export interface TbHandlers {
  skills: (q: string) => Promise<string>
  load: (name: string) => Promise<string>
  agents: () => Promise<string>
  ask: (target: string, task: string) => Promise<string>
}

export async function startHookSystem(
  onStatus: (e: AgentStatusEvent) => void,
  onTranscript?: (nodeId: string, transcriptPath: string) => void,
  tb?: TbHandlers
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
    const given = Buffer.from(String(req.headers['x-termboard-token'] ?? ''))
    const authed = given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf)

    // ── tb 工具中枢路由（GET，纯文本返回，给 agent 直接读）──
    if (req.url?.startsWith('/tb/')) {
      // ask 是同步派活可能等几分钟，其余 tb 命令给 30s；hook 上报仍是 5s（下面）
      req.setTimeout(req.url.startsWith('/tb/ask') ? 310_000 : 30_000, () => req.destroy())
      if (!authed || !tb) {
        res.statusCode = 403
        return res.end('forbidden')
      }
      const u = new URL(req.url, 'http://127.0.0.1')
      const reply = (text: string): void => {
        res.statusCode = 200
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(text)
      }
      const route = u.pathname.slice(4)
      const run =
        route === 'skills'
          ? tb.skills(u.searchParams.get('q') ?? '')
          : route === 'load'
            ? tb.load(u.searchParams.get('name') ?? '')
            : route === 'agents'
              ? tb.agents()
              : route === 'ask'
                ? tb.ask(u.searchParams.get('target') ?? '', u.searchParams.get('task') ?? '')
                : Promise.resolve('unknown route')
      void run.then(reply).catch(() => reply('内部错误'))
      return
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/hook/')) return done()
    req.setTimeout(5000, () => req.destroy())

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
        const tp = (payload as { transcript_path?: unknown } | null)?.transcript_path
        if (typeof tp === 'string' && tp) onTranscript?.(nodeId, tp)
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

  // tb 命令写进 bin 目录，spawn 时把它挂到 PATH 最前面
  const binDir = path.join(dir, 'bin')
  await mkdir(binDir, { recursive: true })
  const tbPath = path.join(binDir, 'tb')
  await writeAtomic(tbPath, buildTbScript())
  await chmod(tbPath, 0o755)

  const endpointFile = path.join(dir, 'hook-endpoint.env')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await writeAtomic(endpointFile, `TERMBOARD_HOOK_PORT=${port}\nTERMBOARD_HOOK_TOKEN=${token}\n`)
  await chmod(endpointFile, 0o600)

  return {
    endpointFile,
    binDir,
    dispose: () => server.close()
  }
}
