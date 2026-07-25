/**
 * Agent 状态 hook 系统（设计参考 ARCHITECTURE-NOTES.md §3）
 *
 * Claude Code hook → 托管脚本 → POST 127.0.0.1:<随机port> → 归一化 → 回调
 * - 端口/token 写 endpoint 文件（0600），脚本每次调用时 source（app 重启端口会变）
 * - 脚本用 TERMBOARD_NODE_ID 门控：非 Termscape 终端瞬间 exit 0
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
  /** 原始 hook 事件名。SessionStart/SessionEnd 用来判会话是否还活着（派活要用） */
  event?: string
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
# Termscape managed hook — 非 Termscape 终端瞬间退出，可安全常驻
[ -n "$TERMBOARD_NODE_ID" ] || exit 0
[ -n "$TERMBOARD_HOOK_ENDPOINT" ] || exit 0
[ -f "$TERMBOARD_HOOK_ENDPOINT" ] || exit 0
. "$TERMBOARD_HOOK_ENDPOINT" 2>/dev/null || exit 0
[ -n "$TERMBOARD_HOOK_PORT" ] || exit 0
payload=$(cat 2>/dev/null || true)
if [ "$1" = "PermissionRequest" ]; then
  # 审批走真通道：请求挂在这里等用户在画布上决定，主进程回的结构化 JSON 原样吐给 Claude。
  # 超时或任何失败都吐空 → Claude 回落到它自己的交互提示（fail-open，绝不卡死 agent）。
  curl -s -m ${PERMISSION_HOLD_SEC + 15} \\
    -H "X-Termboard-Token: $TERMBOARD_HOOK_TOKEN" \\
    --data-urlencode "nodeId=$TERMBOARD_NODE_ID" \\
    --data-urlencode "event=$1" \\
    --data-urlencode "payload=$payload" \\
    "http://127.0.0.1:$TERMBOARD_HOOK_PORT/hook/permission" 2>/dev/null || true
  exit 0
fi
curl -s -m 2 -o /dev/null \\
  -H "X-Termboard-Token: $TERMBOARD_HOOK_TOKEN" \\
  --data-urlencode "nodeId=$TERMBOARD_NODE_ID" \\
  --data-urlencode "event=$1" \\
  --data-urlencode "payload=$payload" \\
  "http://127.0.0.1:$TERMBOARD_HOOK_PORT/hook/claude" 2>/dev/null || true
exit 0
`
}

/** 审批请求最多挂多久（秒）。到点回空 = Claude 回落到自己的原生提示，不会永远卡着。 */
const PERMISSION_HOLD_SEC = 120

export interface PendingApproval {
  id: string
  nodeId: string
  toolName: string
  /** tool_input 的单行摘要，够用户判断该不该批 */
  summary: string
  toolUseId: string
  createdAt: number
}

/** 把 tool_input 压成一行给人看：命令/路径/URL 这类关键信息优先 */
function summarizeToolInput(toolName: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const pick = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const main =
    pick('command') ||
    pick('file_path') ||
    pick('path') ||
    pick('url') ||
    pick('pattern') ||
    pick('prompt')
  const text = main || JSON.stringify(o)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat || toolName
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
  /** 用户在画布上批准/拒绝一次工具调用；返回是否命中一个仍然挂着的请求 */
  decideApproval: (id: string, allow: boolean) => boolean
  /** 节点没了/会话结束 → 丢弃它挂着的审批（放行为空 = Claude 回落原生提示） */
  dropApprovals: (nodeId: string) => void
  dispose: () => void
}

/** F8：tb 命令 —— agent 在终端里直接调，零常驻 token */
function buildTbScript(): string {
  return `#!/bin/sh
# Termscape 工具中枢客户端（自动生成）
[ -n "$TERMBOARD_HOOK_ENDPOINT" ] && [ -f "$TERMBOARD_HOOK_ENDPOINT" ] && . "$TERMBOARD_HOOK_ENDPOINT"
if [ -z "$TERMBOARD_HOOK_PORT" ]; then echo "tb: Termscape 服务不可用（请在 Termscape 终端内使用）" >&2; exit 1; fi
BASE="http://127.0.0.1:$TERMBOARD_HOOK_PORT"
H="X-Termboard-Token: $TERMBOARD_HOOK_TOKEN"
# 调用方节点 id：让主进程知道"是谁在调"，用于连线授权与提示（自报，属产品护栏非安全边界）
N="X-Termscape-Node: $TERMBOARD_NODE_ID"
cmd="$1"; shift 2>/dev/null
case "$cmd" in
  skills|search)
    curl -s -H "$H" -H "$N" --get --data-urlencode "q=$*" "$BASE/tb/skills" ;;
  load|skill)
    curl -s -H "$H" -H "$N" --get --data-urlencode "name=$*" "$BASE/tb/load" ;;
  agents|ls)
    curl -s -H "$H" -H "$N" "$BASE/tb/agents" ;;
  ask|delegate)
    target="$1"; shift 2>/dev/null
    if [ -z "$target" ] || [ -z "$*" ]; then echo "用法: tb ask <节点id> <任务>" >&2; exit 2; fi
    # 派活是同步等待（可能几分钟），拉长超时
    curl -s -m 300 -H "$H" -H "$N" --get \
      --data-urlencode "target=$target" --data-urlencode "task=$*" "$BASE/tb/ask" ;;
  browser|web)
    action="$1"; shift 2>/dev/null
    node=""
    # 可选 --node <id> 指定目标浏览器节点
    if [ "$1" = "--node" ]; then node="$2"; shift 2; fi
    curl -s -m 40 -H "$H" -H "$N" --get \
      --data-urlencode "action=$action" --data-urlencode "arg=$*" \
      --data-urlencode "node=$node" "$BASE/tb/browser" ;;
  ""|help|-h|--help)
    cat <<'EOF'
tb — Termscape 工具中枢

  tb skills <关键词>       搜索可用 skill（返回名称 + 一行说明）
  tb load <名称>           取出该 skill 全文，按其指示执行
  tb agents                列出本画布上的其他 agent 终端
  tb ask <节点id> <任务>   把任务派给另一个终端里的 agent，等它做完返回结果
  tb browser open <url>    在画布上打开浏览器测试目标网页
  tb browser goto <url>    让画布浏览器导航到某地址
  tb browser text          抓取当前页面可见文本
  tb browser js <代码>     在页面里执行 JS 并返回结果（如 document.title）
  tb browser shot          截图当前页面，返回图片路径（可用读图能力查看）
  tb browser list          列出画布上的浏览器节点

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
  agents: (source: string) => Promise<string>
  ask: (source: string, target: string, task: string) => Promise<string>
  browser: (source: string, action: string, arg: string, nodeId: string) => Promise<string>
}

export async function startHookSystem(
  onStatus: (e: AgentStatusEvent) => void,
  onTranscript?: (nodeId: string, transcriptPath: string) => void,
  tb?: TbHandlers,
  onApprovals?: (list: PendingApproval[]) => void
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

  /* 挂起中的审批：HTTP 响应一直不结束，Claude 就一直等；用户在画布上点了才回。
     回空 body = 不做决策 → Claude 回落到它自己的交互提示，绝不把 agent 卡死。 */
  interface Held {
    rec: PendingApproval
    res: http.ServerResponse
    timer: NodeJS.Timeout
  }
  const pending = new Map<string, Held>()
  const publish = (): void => onApprovals?.([...pending.values()].map((h) => h.rec))

  function settle(id: string, body: string): boolean {
    const h = pending.get(id)
    if (!h) return false
    pending.delete(id)
    clearTimeout(h.timer)
    try {
      h.res.statusCode = 200
      h.res.setHeader('content-type', 'application/json')
      h.res.end(body)
    } catch {
      // 客户端可能已经断开（agent 被 Ctrl-C 等）
    }
    publish()
    return true
  }

  const ALLOW = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
  })
  const DENY = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } }
  })

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
      // 调用方节点：脚本自报（同 UID 下无法强制），用于连线授权与提示
      const source = String(req.headers['x-termscape-node'] ?? '').slice(0, 64)
      const run =
        route === 'skills'
          ? tb.skills(u.searchParams.get('q') ?? '')
          : route === 'load'
            ? tb.load(u.searchParams.get('name') ?? '')
            : route === 'agents'
              ? tb.agents(source)
              : route === 'ask'
                ? tb.ask(
                    source,
                    u.searchParams.get('target') ?? '',
                    u.searchParams.get('task') ?? ''
                  )
                : route === 'browser'
                  ? tb.browser(
                      source,
                      u.searchParams.get('action') ?? '',
                      u.searchParams.get('arg') ?? '',
                      u.searchParams.get('node') ?? ''
                    )
                  : Promise.resolve('unknown route')
      void run.then(reply).catch(() => reply('内部错误'))
      return
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/hook/')) return done()
    const isPermission = req.url.startsWith('/hook/permission')
    // 审批请求要挂住等人，不能按普通 hook 的 5s 超时掐断
    req.setTimeout(isPermission ? (PERMISSION_HOLD_SEC + 30) * 1000 : 5000, () => req.destroy())

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

        if (isPermission) {
          // 状态先照常推（节点变橙），再把这次请求挂起等用户决定
          onStatus({ nodeId, agentId: 'claude', state: 'blocked', newTurn: false, event })
          const p = (payload ?? {}) as Record<string, unknown>
          const id = randomUUID()
          const rec: PendingApproval = {
            id,
            nodeId,
            toolName: String(p['tool_name'] ?? '未知工具'),
            summary: summarizeToolInput(String(p['tool_name'] ?? ''), p['tool_input']),
            toolUseId: String(p['tool_use_id'] ?? ''),
            createdAt: Date.now()
          }
          const timer = setTimeout(() => settle(id, ''), PERMISSION_HOLD_SEC * 1000)
          pending.set(id, { rec, res, timer })
          // agent 那头断了（Ctrl-C / 退出）就别留着僵尸卡片
          req.on('close', () => {
            if (pending.delete(id)) {
              clearTimeout(timer)
              publish()
            }
          })
          publish()
          return // 不调 done()：响应故意挂着
        }

        const state = normalizeClaude(event, payload)
        if (state) {
          onStatus({
            nodeId,
            agentId: 'claude',
            state,
            newTurn: event === 'UserPromptSubmit',
            event
          })
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
    decideApproval: (id, allow) => settle(id, allow ? ALLOW : DENY),
    dropApprovals: (nodeId) => {
      for (const [id, h] of [...pending]) {
        if (h.rec.nodeId === nodeId) settle(id, '') // 空 = 不决策，Claude 回落原生提示
      }
    },
    dispose: () => {
      for (const id of [...pending.keys()]) settle(id, '')
      server.close()
    }
  }
}
