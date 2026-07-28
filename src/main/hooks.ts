/**
 * Agent 状态 hook 系统（设计参考 ARCHITECTURE-NOTES.md §3）
 *
 * Claude Code hook → 托管脚本 → POST 127.0.0.1:<随机port> → 归一化 → 回调
 * - 端口/token 写 endpoint 文件（0600），脚本每次调用时 source（app 重启端口会变）
 * - 脚本用 TERMBOARD_NODE_ID 门控：非 Termspace 终端瞬间 exit 0
 * - 全链路 fail-open：任何错误 204，永不阻塞 agent
 */
import { app } from 'electron'
import http from 'node:http'
import {
  buildPeerHelper,
  createRequestLog,
  decodePeerReq,
  peerRequestId,
  PEER_TIMEOUTS,
  TASK_MAX_BYTES
} from './peer'
import { toPublicApproval, type PendingApproval, type PendingApprovalFull } from './approval-dto'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { writeAtomic } from './write-atomic.ts'
import { isOurs, stripOurHandlers, type HookGroup } from './hook-merge.ts'
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
  /** Claude 的 session_id：并行 hook 会晚到，靠它区分"迟到的旧会话事件"与"新会话" */
  sessionId?: string
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

/**
 * codex 的 hook 事件（0.145 实测）。
 *
 * 惊喜：**codex 的 hooks 与 Claude Code 同构** —— 配置文件是 `$CODEX_HOME/hooks.json`，
 * schema 就是 Claude settings.json 里 `hooks` 那一段；payload 的键也一样
 * （session_id / transcript_path / cwd / hook_event_name / permission_mode /
 * tool_name / tool_input / tool_use_id），还多给了 model 和 turn_id。
 * 实测触发顺序：SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop → SessionEnd。
 * 所以下面的 normalize 一套通吃，不需要为 codex 另写一份状态机。
 *
 * codex 没有 Notification / StopFailure，多一个 SubagentStop。
 */
const CODEX_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PermissionRequest'
] as const

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
    case 'SubagentStop': // codex 的子 agent 结束；主 agent 仍在跑
      return 'working'
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
# Termspace managed hook — 非 Termspace 终端瞬间退出，可安全常驻
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
    --data-urlencode "agent=$TERMBOARD_AGENT_ID" \\
    --data-urlencode "event=$1" \\
    --data-urlencode "payload=$payload" \\
    "http://127.0.0.1:$TERMBOARD_HOOK_PORT/hook/permission" 2>/dev/null || true
  exit 0
fi
curl -s -m 2 -o /dev/null \\
  -H "X-Termboard-Token: $TERMBOARD_HOOK_TOKEN" \\
  --data-urlencode "nodeId=$TERMBOARD_NODE_ID" \\
  --data-urlencode "agent=$TERMBOARD_AGENT_ID" \\
  --data-urlencode "event=$1" \\
  --data-urlencode "payload=$payload" \\
  "http://127.0.0.1:$TERMBOARD_HOOK_PORT/hook/claude" 2>/dev/null || true
exit 0
`
}

/** 审批请求最多挂多久（秒）。到点回空 = Claude 回落到自己的原生提示，不会永远卡着。 */
const PERMISSION_HOLD_SEC = 120

/* 审批记录的形态与脱敏出口搬到了 approval-dto.ts —— 那边不依赖 electron，
   才能被 `node --test` 覆盖到（"完整 tool_input 不出主进程"这条必须有回归网）。 */
export { toPublicApproval } from './approval-dto'
export type { PendingApproval, PendingApprovalFull } from './approval-dto'

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

/**
 * Claude 的 settings.json。
 *
 * **参数是配置目录，不是写死的 `~/.claude`** —— `CLAUDE_CONFIG_DIR` 会整个覆盖
 * 默认目录（settings / hooks / 会话历史 / 插件全在里面），而多账号隔离正是靠它。
 * 写死的话：用户切到隔离账号，凭证生效了、登录也成功了，
 * 但那个节点的状态灯和 `tb ask` 接单能力**静默失效** —— 因为 hook 装在另一个目录里。
 */
const claudeConfigDir = (dir?: string): string => dir || path.join(os.homedir(), '.claude')
const claudeSettingsPath = (dir?: string): string =>
  path.join(claudeConfigDir(dir), 'settings.json')

/** 覆写别人的配置文件时**沿用它原来的权限**。settings.json 里可能有 env/API 配置，
    默认 0644 覆盖一个 0600 的文件 = 悄悄放宽权限 */
async function keepMode(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mode & 0o777
  } catch {
    return undefined
  }
}

/**
 * transcript 是"agent 说了什么"的真相源，payload 由 hook 脚本发来、同 UID 可构造，
 * 所以必须限定它只能指向已知的两种位置：
 *   Claude → `~/.claude/projects` 下的 .jsonl
 *   codex  → `<CODEX_HOME>/sessions/…/rollout-*.jsonl`（CODEX_HOME 随订阅账号变，
 *            写不死路径，改为按形状匹配并要求落在用户家目录内）
 */
function isSafeTranscript(p: string): boolean {
  if (!p.endsWith('.jsonl')) return false
  const resolved = path.resolve(p)
  if (resolved.includes('..')) return false
  const home = os.homedir()
  if (resolved.startsWith(path.join(home, '.claude', 'projects') + path.sep)) return true
  // codex：必须在用户目录下、走 sessions/ 且文件名是 rollout-
  return (
    resolved.startsWith(home + path.sep) &&
    resolved.includes(`${path.sep}sessions${path.sep}`) &&
    path.basename(resolved).startsWith('rollout-')
  )
}


/**
 * 托管 hook 是否**完整**装在用户 settings.json 里（体检要报实情）。
 * 用「全部事件都在」而不是「有一个就算」：少装几个事件时状态系统是残的，
 * 报「正常」比不报更误导人。
 */
export async function claudeHooksPresent(configDir?: string): Promise<boolean> {
  const p = claudeSettingsPath(configDir)
  if (!existsSync(p)) return false
  try {
    const settings = JSON.parse(await readFile(p, 'utf8')) as {
      hooks?: Record<string, HookGroup[]>
    }
    const hooks = settings.hooks ?? {}
    return CLAUDE_EVENTS.every((ev) =>
      (Array.isArray(hooks[ev]) ? hooks[ev] : []).some((g) => g.hooks?.some((h) => isOurs(h.command)))
    )
  } catch {
    return false
  }
}

/** 把托管 hook 从用户 settings.json 里摘掉（设置面板「卸载」用），返回是否有改动 */
export async function uninstallClaudeHooks(configDir?: string): Promise<boolean> {
  const p = claudeSettingsPath(configDir)
  if (!existsSync(p)) return false
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return false // 损坏时绝不覆写
  }
  const hooks = settings['hooks'] as Record<string, HookGroup[]> | undefined
  if (!hooks) return false
  let changed = false
  for (const ev of Object.keys(hooks)) {
    const arr = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const kept: HookGroup[] = []
    let touched = false
    for (const g of arr) {
      if (!g.hooks?.some((h) => isOurs(h.command))) {
        kept.push(g)
        continue
      }
      // 逐条摘，不能整组删 —— 用户自己的 hook 可能和我们在同一个 group 里
      const rest = g.hooks.filter((h) => !isOurs(h.command))
      touched = true
      if (rest.length) kept.push({ ...g, hooks: rest })
    }
    if (!touched) continue
    changed = true
    if (kept.length) hooks[ev] = kept
    else delete hooks[ev]
  }
  if (changed) await writeAtomic(p, JSON.stringify(settings, null, 2) + '\n', await keepMode(p))
  return changed
}

/** 把托管 hook 合并进 ~/.claude/settings.json（幂等，marker 识别，保留用户条目，首次备份） */
async function installClaudeHooks(scriptPath: string, configDir?: string): Promise<void> {
  const settingsPath = claudeSettingsPath(configDir)
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    } catch {
      return // 用户 settings 损坏时绝不覆写
    }
    const backup = `${settingsPath}.termboard-backup`
    if (!existsSync(backup)) await copyFile(settingsPath, backup)
  } else {
    // 隔离账号的目录可能还不存在（用户刚建凭证、还没跑过 claude）
    await mkdir(path.dirname(settingsPath), { recursive: true })
  }

  const hooks = (settings['hooks'] ??= {}) as Record<string, HookGroup[]>
  let changed = false
  for (const ev of CLAUDE_EVENTS) {
    const cmd = `sh "${scriptPath}" ${ev}`
    const arr = Array.isArray(hooks[ev]) ? hooks[ev] : []
    // 去掉旧版本我方条目（路径变更时），**逐 handler 摘**，保留同组里用户自己的
    const kept = stripOurHandlers(arr)
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
    await writeAtomic(
      settingsPath,
      JSON.stringify(settings, null, 2) + '\n',
      await keepMode(settingsPath)
    )
  }
}

/** `$CODEX_HOME/hooks.json` —— codex 的 hook 配置（与 Claude 的 settings.json.hooks 同构） */
const codexHooksPath = (codexHome: string): string => path.join(codexHome, 'hooks.json')

/** 托管 hook 是否**完整**装在该 CODEX_HOME 里（体检要报实情） */
export async function codexHooksPresent(codexHome: string): Promise<boolean> {
  const p = codexHooksPath(codexHome)
  if (!existsSync(p)) return false
  try {
    const j = JSON.parse(await readFile(p, 'utf8')) as { hooks?: Record<string, HookGroup[]> }
    const hooks = j.hooks ?? {}
    return CODEX_EVENTS.every((ev) =>
      (Array.isArray(hooks[ev]) ? hooks[ev] : []).some((g) => g.hooks?.some((h) => isOurs(h.command)))
    )
  } catch {
    return false
  }
}

/**
 * 把托管 hook 合并进 `$CODEX_HOME/hooks.json`（幂等、保留用户条目、首次备份）。
 *
 * ⚠️ **写进去不等于会生效**：codex 对 hook 有「授信」机制（config 里存 trusted_hash），
 * 没授信时 `codex exec` 会**静默跳过**所有 hook —— 不报错、不提示。实测确认。
 * 所以体检里必须有一条探针去验它真的在跑，别让用户对着一个"已安装"的绿灯干等状态灯不亮。
 */
async function installCodexHooks(scriptPath: string, codexHome: string): Promise<void> {
  const p = codexHooksPath(codexHome)
  let doc: Record<string, unknown> = {}
  if (existsSync(p)) {
    try {
      doc = JSON.parse(await readFile(p, 'utf8'))
    } catch {
      return // 用户配置损坏时绝不覆写
    }
    const backup = `${p}.termboard-backup`
    if (!existsSync(backup)) await copyFile(p, backup)
  } else {
    await mkdir(codexHome, { recursive: true })
  }

  const hooks = (doc['hooks'] ??= {}) as Record<string, HookGroup[]>
  let changed = false
  for (const ev of CODEX_EVENTS) {
    const cmd = `sh "${scriptPath}" ${ev}`
    const arr = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const kept = stripOurHandlers(arr)
    const already = arr.length === kept.length + 1 && arr.some((g) => g.hooks?.some((h) => h.command === cmd))
    if (already) continue
    // matcher 必填（空串 = 全匹配），codex 与 Claude 在这点上一致
    kept.push({ matcher: '', hooks: [{ type: 'command', command: cmd }] })
    hooks[ev] = kept
    changed = true
  }
  if (changed) await writeAtomic(p, JSON.stringify(doc, null, 2) + '\n', await keepMode(p))
}

export interface HookSystem {
  endpointFile: string
  /** 为该节点签发 token（spawn 时调）。返回值注入 env，同时落盘供老会话现查 */
  issueNodeToken: (nodeId: string) => Promise<string>
  /** 节点销毁时吊销 */
  revokeNodeToken: (nodeId: string) => Promise<void>
  binDir: string // 注入 PATH 的目录（内含 tb 命令）
  /** 跨机入口脚本的绝对路径。对端 ssh 过来跑的就是它 —— 要显示在设置里让用户抄走 */
  peerHelperPath: string
  /** 用户在画布上批准/拒绝一次工具调用；返回是否命中一个仍然挂着的请求 */
  decideApproval: (id: string, allow: boolean) => boolean
  /** 当前挂起的审批快照（renderer reload 后要重放，否则既有审批一直不可见直到超时） */
  listApprovals: () => PendingApproval[]
  /** 完整记录（含未截断的 rawInput），**只在主进程内使用**：安全判定必须看它 */
  getApprovalFull: (id: string) => PendingApprovalFull | undefined
  /** 节点没了/会话结束 → 丢弃它挂着的审批（放行为空 = Claude 回落原生提示） */
  dropApprovals: (nodeId: string) => void
  /** 用户事后同意写入时调用（首启询问不阻塞启动，同意了再装） */
  enableHooks: () => Promise<void>
  /** 把托管 hook 装进某个 CODEX_HOME（每个 codex 订阅账号一个目录，spawn 时按需装） */
  enableCodexHooks: (codexHome: string) => Promise<void>
  /** 同理，装进某个 CLAUDE_CONFIG_DIR。隔离账号不会读 ~/.claude/settings.json ——
      不按目录装，那个节点的状态灯和 tb ask 接单能力就**静默失效** */
  enableClaudeHooksIn: (configDir: string) => Promise<void>
  dispose: () => void
}

/** F8：tb 命令 —— agent 在终端里直接调，零常驻 token */
function buildTbScript(): string {
  return `#!/bin/sh
# Termspace 工具中枢客户端（自动生成）
[ -n "$TERMBOARD_HOOK_ENDPOINT" ] && [ -f "$TERMBOARD_HOOK_ENDPOINT" ] && . "$TERMBOARD_HOOK_ENDPOINT"
if [ -z "$TERMBOARD_HOOK_PORT" ]; then echo "tb: Termspace 服务不可用（请在 Termspace 终端内使用）" >&2; exit 1; fi
BASE="http://127.0.0.1:$TERMBOARD_HOOK_PORT"
H="X-Termboard-Token: $TERMBOARD_HOOK_TOKEN"
# 调用方身份由 token 反查，不再自报节点 id
cmd="$1"; shift 2>/dev/null
case "$cmd" in
  skills|search)
    curl -s -H "$H" --get --data-urlencode "q=$*" "$BASE/tb/skills" ;;
  load|skill)
    curl -s -H "$H" --get --data-urlencode "name=$*" "$BASE/tb/load" ;;
  agents|ls)
    # 带参数 = 问那台机器要清单（要几秒，所以不做成默认行为）
    curl -s -m 40 -H "$H" --get --data-urlencode "peer=$1" "$BASE/tb/agents" ;;
  context|ctx)
    curl -s -H "$H" "$BASE/tb/context" ;;
  ask|delegate)
    target="$1"; shift 2>/dev/null
    if [ -z "$target" ] || [ -z "$*" ]; then echo "用法: tb ask <节点id> <任务>" >&2; exit 2; fi
    # 派活是同步等待（可能几分钟），拉长超时。
    # target 含冒号 = 跨机（<ssh别名>:<节点>），主进程那边分流；
    # **ssh 由主进程跑，不在这个脚本里跑** —— 别名白名单在主进程设置里，
    # 脚本自己 ssh 就等于绕过白名单。跨机多一跳，所以超时比远端 delegate 更长。
    # **整个请求走 POST body，不进 URL**：派活最常带长需求、路径、验收条件，
    # 而中文一个字三字节 —— 塞在 query 里会先撞上 Node 的 request target 上限
    # （在 TASK_MAX_BYTES 那道业务闸**之前**），curl 只吐一个空结果，
    # agent 会把它当成"没人回答"。
    # body 第一行是目标、其余是任务正文：目标 id 和 ssh 别名都不含换行（服务端校验过），
    # 这样连 URL 编码都不需要，也不会有人往 query 里塞 & 拼参数。
    # -f 让 HTTP 错误有非零退出码，-sS 保留错误正文。
    { printf '%s\n' "$target"; printf '%s' "$*"; } |
      curl -sS -f -m ${Math.round(PEER_TIMEOUTS.tbMs / 1000)} -H "$H" \
        -X POST --data-binary @- "$BASE/tb/ask" ;;
  db|sql)
    # 代理连接：**连接串在主进程里，这个终端拿不到** —— 只把 SQL 送过去。
    # 正文走 stdin（同 ask），名字在第一行。
    name="$1"; shift 2>/dev/null
    if [ -z "$name" ] || [ -z "$*" ]; then echo "用法: tb db <连接名> <SQL>" >&2; exit 2; fi
    { printf '%s\n' "$name"; printf '%s' "$*"; } |
      curl -sS -f -m 60 -H "$H" -X POST --data-binary @- "$BASE/tb/broker?kind=postgres" ;;
  ssh)
    name="$1"; shift 2>/dev/null
    if [ -z "$name" ] || [ -z "$*" ]; then echo "用法: tb ssh <连接名> <命令>" >&2; exit 2; fi
    { printf '%s\n' "$name"; printf '%s' "$*"; } |
      curl -sS -f -m 60 -H "$H" -X POST --data-binary @- "$BASE/tb/broker?kind=ssh" ;;
  browser|web)
    action="$1"; shift 2>/dev/null
    node=""
    # 可选 --node <id> 指定目标浏览器节点
    if [ "$1" = "--node" ]; then node="$2"; shift 2; fi
    curl -s -m 40 -H "$H" --get \
      --data-urlencode "action=$action" --data-urlencode "arg=$*" \
      --data-urlencode "node=$node" "$BASE/tb/browser" ;;
  ""|help|-h|--help)
    cat <<'EOF'
tb — Termspace 工具中枢

  tb skills <关键词>       搜索可用 skill（返回名称 + 一行说明）
  tb load <名称>           取出该 skill 全文，按其指示执行
  tb agents                列出本画布上的其他 agent 终端
  tb agents <机器>         列出那台机器上的 agent 终端（派活前用它找节点 id）
  tb context               读取连到本终端的共享上下文（实时，改了立刻能看到）
  tb ask <节点id> <任务>   把任务派给另一个终端里的 agent，等它做完返回结果
  tb ask <机器>:<节点id> <任务>  派到另一台机器上的 Termspace（机器名在设置里配）
  tb browser open <url>    在画布上打开浏览器测试目标网页
  tb browser goto <url>    让画布浏览器导航到某地址
  tb browser text          抓取当前页面可见文本
  tb browser js <代码>     在页面里执行 JS 并返回结果（如 document.title）
  tb browser shot          截图当前页面，返回图片路径（可用读图能力查看）
  tb browser list          列出画布上的浏览器节点
  tb db <连接名> <SQL>     在代理数据库连接上跑一条 SQL（只读连接会拒写语句）
  tb ssh <连接名> <命令>   在代理 ssh 连接上跑一条命令
                           —— 这两个的凭证在主进程里，**你拿不到，也不需要**

用法：先 skills 找、load 取全文，不要凭记忆猜 skill。
派活前先 tb agents 看有哪些节点，再 tb ask <id> "任务描述"。
上下文节点的内容随时会被人改；需要时用 tb context 现取，别依赖会话开始时的那份。
EOF
    ;;
  *) echo "tb: 未知命令 '$cmd'（tb help 查看用法）" >&2; exit 2 ;;
esac
`
}

export interface TbHandlers {
  skills: (q: string) => Promise<string>
  load: (name: string) => Promise<string>
  /** `peer` 非空 = 问那台机器要清单（`tb agents <机器>`） */
  agents: (source: string, peer?: string) => Promise<string>
  /** 连到该终端的上下文节点，**现读现返**（会话启动时注入的那份可能已经过期） */
  context: (source: string) => Promise<string>
  ask: (source: string, target: string, task: string) => Promise<string>
  /**
   * 别的机器 ssh 过来派的活。`source` 是对方自报的，**只用于显示**，
   * 不参与授权 —— 授权靠本机设置里的「接受跨机派活」开关（见 /tb/peer 路由）。
   */
  peerAsk?: (source: string, target: string, task: string) => Promise<string>
  /** 别的机器问「你这儿有哪些 agent 终端」。只读，但同样受跨机开关门控 */
  peerAgents?: (source: string) => Promise<string>
  /**
   * 代理连接（`tb db` / `tb ssh`）：agent 只给**名字和正文**，
   * 连接串在主进程里取用，一个字节都不回给终端（见 broker.ts）。
   */
  broker?: (source: string, kind: string, name: string, payload: string) => Promise<string>
  browser: (source: string, action: string, arg: string, nodeId: string) => Promise<string>
}

export async function startHookSystem(
  onStatus: (e: AgentStatusEvent) => void,
  onTranscript?: (nodeId: string, transcriptPath: string) => void,
  tb?: TbHandlers,
  onApprovals?: (list: PendingApproval[]) => void,
  /** 是否把托管 hook 写进用户的 ~/.claude/settings.json。false 时服务照常起（tb 仍可用），
      只是不碰用户全局配置 —— 改别人的全局配置这件事必须先问过。 */
  installHooks = true
): Promise<HookSystem> {
  const dir = app.getPath('userData')
  const hooksDir = path.join(dir, 'hooks')
  await mkdir(hooksDir, { recursive: true })

  const scriptPath = path.join(hooksDir, 'claude-status.sh')
  await writeAtomic(scriptPath, buildScript(), 0o755)
  if (installHooks) await installClaudeHooks(scriptPath)

  /* ── per-node token ──
     此前是一个全局 token，请求里的 nodeId 完全自报：任何终端里的进程都能伪造
     别的节点的 SessionStart / 审批卡片，而 SessionStart 在 delegate 的状态机里
     先于墓碑、无条件置活 —— 于是那套 fail-closed 判定判的是一组可被写入的状态。

     现在每个节点一个 token，服务端**按 token 反查节点，忽略请求体里的 nodeId**。
     诚实说明：token 文件同 UID 可读，所以这仍是产品护栏（挡住误用与顺手伪造），
     不是安全边界 —— 真隔离要不同 UID / 容器。 */
  const tokenDir = path.join(dir, 'nodetokens')
  await mkdir(tokenDir, { recursive: true })
  const tokenToNode = new Map<string, string>()
  const nodeToToken = new Map<string, string>()
  const tokenFile = (nodeId: string): string =>
    path.join(tokenDir, nodeId.replace(/[^A-Za-z0-9_-]/g, '_'))

  /* 挂起中的审批：HTTP 响应一直不结束，Claude 就一直等；用户在画布上点了才回。
     回空 body = 不做决策 → Claude 回落到它自己的交互提示，绝不把 agent 卡死。 */
  interface Held {
    rec: PendingApprovalFull
    res: http.ServerResponse
    timer: NodeJS.Timeout
  }
  const pending = new Map<string, Held>()
  // 必须过 toPublicApproval：这条是实时推送路径，直接吐 rec 等于把完整
  // tool_input 送进 renderer 并从 /api/events 出网
  const publish = (): void => onApprovals?.([...pending.values()].map((h) => toPublicApproval(h.rec)))

  function settle(id: string, body: string): boolean {
    const h = pending.get(id)
    if (!h) return false
    pending.delete(id) // 先出表再 end：res 的 close 回调看到表里没有就不会重复清理
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
    /* 按 token 反查是哪个节点在调。请求体/请求头里自报的 nodeId 一律不信。
       token 是 128 位随机值且只走回环，这里用 Map 直查（同 UID 下 token 文件本就可读，
       再做恒时比较没有实际收益）。 */
    const given = String(req.headers['x-termboard-token'] ?? '')
    const callerNode = given ? (tokenToNode.get(given) ?? '') : ''
    const authed = !!callerNode

    /* ── 跨机派活入口 ──
       只有本机的 tb-peer helper 会打这里（它由对端 ssh 过来执行）。
       和 /tb/* 分开是因为身份来源完全不同：那边按 per-node token 反查
       "哪个节点在调"，这里根本没有本机节点 —— 调用方是另一台机器。

       授权**不走 authorizeLink**：那个函数比对的是画布连线 `boardLinks`，
       而 peer 不是画布上的节点，比对永远不成立，只会弹一个远端没人看的窗
       并留下匹配不上的幽灵 grant。这里的判据是本机设置里的「接受跨机派活」开关。 */
    if (req.url === '/tb/peer' && req.method === 'POST') {
      req.setTimeout(PEER_TIMEOUTS.remoteDelegateMs + 30_000, () => req.destroy())
      const tok = String(req.headers['x-termboard-peer'] ?? '')
      const reply = (code: number, text: string): void => {
        res.statusCode = code
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(text)
      }
      if (!tb?.peerAsk || !peerToken || tok !== peerToken) return reply(403, 'forbidden')
      const peerAsk = tb.peerAsk // 钉住：下面在异步回调里用，TS 那边也认这个形状
      let size = 0
      const bodyChunks: Buffer[] = []
      let tooBig = false
      req.on('data', (c: Buffer) => {
        size += c.length
        /* 超限要**说出来**。直接 destroy 的话对面只拿到一个连接重置，
           ssh 那头显示的是"curl: (56) Recv failure"，没人猜得到是任务太长。
           不再收数据但让请求正常收尾，end 里回 413。 */
        if (size > BODY_LIMIT) tooBig = true
        else bodyChunks.push(c)
      })
      req.on('end', () => {
        if (tooBig) return reply(413, `任务太长（上限 ${TASK_MAX_BYTES} 字节）`)
        const p = decodePeerReq(Buffer.concat(bodyChunks).toString('utf8'))
        if (!p) return reply(400, `请求格式不对（任务为空、节点 id 非法，或任务超过 ${TASK_MAX_BYTES} 字节）`)

        /* 列节点是**只读**的，不注入任何东西 —— 所以不走幂等表也不受
           「接受跨机派活」开关门控？不，还是要门控：节点标题和 cwd 里有项目名，
           不想让对面派活的人，多半也不想让他看见自己在做什么。 */
        if (p.op === 'agents') {
          if (!tb?.peerAgents) return reply(400, '这台机器的版本不支持列节点')
          return void tb
            .peerAgents(p.source)
            .then((t) => reply(200, t))
            .catch(() => reply(500, '内部错误'))
        }

        /* ── 幂等 ──
           派活超时或 ssh 断掉之后，任务**其实已经注入进那个 agent 了**（断线是
           detach 不是 cancel）。人或 agent 这时再发一次同样的任务，就是往同一个
           会话里注入两遍。所以按内容登记：同一个人把同一个任务派给同一个终端，
           十分钟内就是同一次派活，第二次直接把上次的状态/结果告诉他。 */
        const rid = peerRequestId(p.source, p.target, p.task)
        const prior = peerLog.begin(rid, Date.now())
        if (prior) {
          return reply(
            200,
            prior.state === 'running'
              ? `[这个任务已经派过了，正在 ${p.target} 上跑（${Math.round(
                  (Date.now() - prior.at) / 1000
                )}s 前发起）。没有重复注入 —— 去那个终端看进度，或等它跑完再问。]`
              : `[这个任务几分钟前派过并已完成，没有重复注入。上次的回答：]\n${
                  prior.result ?? '(空)'
                }`
          )
        }
        void peerAsk(p.source, p.target, p.task)
          .then((t) => {
            /* 只有**真派出去了**才记结果。被拒（开关关着、目标不是 agent…）要撤销登记，
               否则用户按提示把开关打开之后，同一个任务十分钟内都派不出去。 */
            if (t.startsWith('派活被拒') || t.startsWith('派活失败')) peerLog.abandon(rid)
            else peerLog.finish(rid, t, Date.now())
            reply(200, t)
          })
          .catch(() => {
            peerLog.abandon(rid)
            reply(500, '内部错误')
          })
      })
      return
    }

    // ── tb 工具中枢路由（GET，纯文本返回，给 agent 直接读）──
    if (req.url?.startsWith('/tb/')) {
      // ask 是同步派活可能等几分钟，其余 tb 命令给 30s；hook 上报仍是 5s（下面）
      req.setTimeout(req.url.startsWith('/tb/ask') ? PEER_TIMEOUTS.tbMs + 10_000 : 30_000, () => req.destroy())
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
      // 调用方节点：由 token 反查得到，不再采信脚本自报的 X-Termspace-Node
      const source = callerNode

      /**
       * `tb ask` 的入参从 **POST body** 读：第一行是目标，其余是任务正文。
       *
       * 之所以不走 query：派活最常带长需求，中文一个字三字节 ——
       * 塞在 URL 里会先撞上 Node 的 request target 上限，而那是在 `TASK_MAX_BYTES`
       * 这道业务闸**之前**，调用方只拿到一个空结果，agent 会当成"没人回答"。
       *
       * 兼容老脚本：body 为空时回落到 query（用户可能还开着旧会话，
       * 而 tb 脚本是 app 启动时才重写的）。
       */
      /** 读 body：第一行是名字，其余是正文。和 ask 同一个形状 */
      const readNamedBody = (): Promise<{ name: string; body: string } | null> =>
        new Promise((resolve) => {
          let size = 0
          const parts: Buffer[] = []
          let tooBig = false
          req.on('data', (c: Buffer) => {
            size += c.length
            if (size > BODY_LIMIT) tooBig = true
            else parts.push(c)
          })
          req.on('end', () => {
            if (tooBig) return resolve(null)
            const text = Buffer.concat(parts).toString('utf8')
            const nl = text.indexOf('\n')
            if (nl < 0) return resolve(null)
            resolve({ name: text.slice(0, nl).trim(), body: text.slice(nl + 1) })
          })
          req.on('error', () => resolve(null))
        })

      const brokerFromBody = async (kind: string): Promise<string> => {
        if (!tb?.broker) return '这台机器不支持代理连接'
        const p = await readNamedBody()
        if (!p) return '请求格式不对'
        return tb.broker(source, kind, p.name, p.body)
      }

      const askFromBody = (): Promise<string> =>
        new Promise((resolve) => {
          let size = 0
          const parts: Buffer[] = []
          let tooBig = false
          req.on('data', (c: Buffer) => {
            size += c.length
            if (size > BODY_LIMIT) tooBig = true
            else parts.push(c)
          })
          req.on('end', () => {
            if (tooBig) return resolve(`任务太长（上限 ${TASK_MAX_BYTES} 字节）`)
            const body = Buffer.concat(parts).toString('utf8')
            const nl = body.indexOf('\n')
            const target = nl < 0 ? body.trim() : body.slice(0, nl).trim()
            const task = nl < 0 ? '' : body.slice(nl + 1)
            resolve(
              tb
                ? tb.ask(
                    source,
                    target || (u.searchParams.get('target') ?? ''),
                    task || (u.searchParams.get('task') ?? '')
                  )
                : Promise.resolve('内部错误')
            )
          })
          req.on('error', () => resolve('读请求失败'))
        })
      const run =
        route === 'skills'
          ? tb.skills(u.searchParams.get('q') ?? '')
          : route === 'load'
            ? tb.load(u.searchParams.get('name') ?? '')
            : route === 'agents'
              ? tb.agents(source, u.searchParams.get('peer') ?? '')
            : route === 'context'
              ? tb.context(source)
              : route === 'broker'
                ? brokerFromBody(u.searchParams.get('kind') ?? '')
              : route === 'ask'
                ? askFromBody()
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
        // nodeId 一律取 token 反查的结果，**不看请求体** ——
        // 否则任一终端都能伪造别的节点的 SessionStart 把它判成活 agent
        const nodeId = callerNode
        const event = body.get('event') ?? ''
        /* 哪家 agent 发来的。脚本从 TERMBOARD_AGENT_ID 带上来，spawn 时按预设写死，
           所以它跟 nodeId 一样是我们自己注入的、不是 agent 自报的。
           收窄到已知取值，防止脏值污染下游的 provider 判断。 */
        const rawAgent = body.get('agent') ?? ''
        const agentId = /^[a-z][a-z0-9-]{0,15}$/.test(rawAgent) ? rawAgent : 'claude'
        if (!nodeId || !event) return done()
        let payload: unknown = null
        try {
          payload = JSON.parse(body.get('payload') ?? 'null')
        } catch {
          // payload 解析失败不影响状态事件本身
        }
        /* transcript_path 直接决定我们去读哪个文件当"agent 说了什么"的真相源。
           payload 是 hook 脚本发来的，同 UID 下可被构造 —— 不校验就等于让人指定
           任意文件当 transcript（派活取结果、上下文占用、未来的管家都吃这个）。
           限定必须落在已知位置（Claude 的 projects/ 或 codex 的 sessions/rollout-*）。 */
        const tp = (payload as { transcript_path?: unknown } | null)?.transcript_path
        if (typeof tp === 'string' && tp && isSafeTranscript(tp)) onTranscript?.(nodeId, tp)
        const sidRaw = (payload as { session_id?: unknown } | null)?.session_id
        const sid = typeof sidRaw === 'string' ? sidRaw : undefined

        if (isPermission) {
          // 状态先照常推（节点变橙），再把这次请求挂起等用户决定
          onStatus({
            nodeId,
            agentId,
            state: 'blocked',
            newTurn: false,
            event,
            sessionId: sid
          })
          const p = (payload ?? {}) as Record<string, unknown>
          const id = randomUUID()
          const rawInput = p['tool_input']
          const rec: PendingApprovalFull = {
            id,
            nodeId,
            toolName: String(p['tool_name'] ?? '未知工具'),
            summary: summarizeToolInput(String(p['tool_name'] ?? ''), rawInput),
            // 官方不保证 PermissionRequest 一定带 tool_use_id，别把它当唯一绑定键
            toolUseId: String(p['tool_use_id'] ?? ''),
            createdAt: Date.now(),
            sessionId: sid ?? '',
            cwd: String(p['cwd'] ?? ''),
            inputHash: createHash('sha256')
              .update(JSON.stringify(rawInput ?? null))
              .digest('hex'),
            // 完整输入只留在主进程：摘要是截断的，拿它做安全判定会被"藏在后面"的内容绕过
            rawInput,
            permissionMode: String(p['permission_mode'] ?? 'default')
          }
          const timer = setTimeout(() => settle(id, ''), PERMISSION_HOLD_SEC * 1000)
          pending.set(id, { rec, res, timer })
          // agent 那头断了（Ctrl-C / 退出）就别留着僵尸卡片。
          // 必须监听 res 而不是 req：req 的 'close' 在请求体正常读完时就会触发，
          // 挂在它上面等于审批刚进 pending 就被自己删掉（整个功能失效）。
          res.once('close', () => {
            if (res.writableEnded) return // 我们自己 end 的，settle 里已清理
            const h = pending.get(id)
            if (!h) return
            pending.delete(id)
            clearTimeout(h.timer)
            publish()
          })
          publish()
          return // 不调 done()：响应故意挂着
        }

        const state = normalizeClaude(event, payload)
        if (state) {
          onStatus({
            nodeId,
            agentId,
            state,
            newTurn: event === 'UserPromptSubmit',
            event,
            sessionId: sid
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
  await writeAtomic(tbPath, buildTbScript(), 0o755)

  /* ── 跨机入口 ──
     别的机器通过 ssh 跑 `tb-peer`，它在**本机**读端口和 token 再打回环。
     为什么不让对面直接 curl：hook 端口每次启动都变、token 也在本机文件里，
     对面既拿不到也不该拿。helper 留在被派活这一侧，跨机链路上只传任务本身。 */
  /* 跨机派活的幂等表。**进程内即可**：它防的是"超时后重试"这种分钟级的重复，
     而 app 一重启，所有 tmux 会话里的 agent 也早不在原来那一轮了。 */
  const peerLog = createRequestLog()

  /* **每次启动换一把**。原来想着"保持不变，否则要重新分发 helper" —— 那是想错了：
     helper 是**被派活这一侧自己生成**的（对面 ssh 过来直接执行它），
     从来不需要分发。既然如此就没有任何理由让 token 长寿，轮换只缩短泄漏窗口。
     落盘只为让用户能看到/手动吊销，链路本身不读它。 */
  const peerTokenFile = path.join(dir, 'peer-token')
  const peerToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  await writeAtomic(peerTokenFile, peerToken, 0o600)
  const peerHelperPath = path.join(binDir, 'tb-peer')

  const endpointFile = path.join(dir, 'hook-endpoint.env')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  /* 这个文件被 hook 脚本和 tb 每次调用时 source。token 必须在这里**按节点现查**：
     tmux 会话跨 app 重启存活，而 `new-session -A` 接回已有会话时会忽略 -e，
     所以 spawn 时注入的 env 对老会话是过期的，只有每次读文件才拿得到当前 token。 */
  await writeAtomic(
    endpointFile,
    `TERMBOARD_HOOK_PORT=${port}\n` +
      `TERMBOARD_TOKEN_DIR='${tokenDir}'\n` +
      `if [ -n "$TERMBOARD_NODE_ID" ] && [ -f "$TERMBOARD_TOKEN_DIR/$TERMBOARD_NODE_ID" ]; then\n` +
      `  TERMBOARD_HOOK_TOKEN=$(cat "$TERMBOARD_TOKEN_DIR/$TERMBOARD_NODE_ID")\n` +
      `fi\n`,
    0o600
  )

  /* helper 里写死端口和 token —— 每次启动重写。ssh 过来的进程不继承任何 env，
     所以这两样只能落在文件里。**0700 要在创建那一刻就生效**（见 writeAtomic）：
     脚本正文里带着完整 token，晚一步 chmod 就有一个全局可读的窗口。
     同 UID 仍然读得到（整个 hook 体系都是这样，见文件头的诚实说明），挡的是别的用户。 */
  await writeAtomic(peerHelperPath, buildPeerHelper(port, peerToken), 0o700)

  return {
    endpointFile,
    peerHelperPath,
    issueNodeToken: async (nodeId) => {
      // 每次 spawn 换新 token：老 token 立即失效，节点重建不会继承旧身份
      const prev = nodeToToken.get(nodeId)
      if (prev) tokenToNode.delete(prev)
      const t = randomUUID().replace(/-/g, '')
      nodeToToken.set(nodeId, t)
      tokenToNode.set(t, nodeId)
      /* 0600 同样要在创建那一刻生效 —— 这把 token 能伪造该节点的 SessionStart，
         而 SessionStart 在 delegate 的状态机里先于墓碑、无条件置活。 */
      const f = tokenFile(nodeId)
      await writeAtomic(f, t, 0o600)
      return t
    },
    revokeNodeToken: async (nodeId) => {
      const prev = nodeToToken.get(nodeId)
      if (prev) tokenToNode.delete(prev)
      nodeToToken.delete(nodeId)
      await unlink(tokenFile(nodeId)).catch(() => undefined)
    },
    binDir,
    decideApproval: (id, allow) => settle(id, allow ? ALLOW : DENY),
    // 脱敏：rawInput 只留在主进程，不进 renderer 也不过网络
    listApprovals: () => [...pending.values()].map(({ rec }) => toPublicApproval(rec)),
    /** 完整记录，只给主进程内的规则引擎用（未来的低档管家） */
    getApprovalFull: (id) => pending.get(id)?.rec,
    enableHooks: () => installClaudeHooks(scriptPath),
    enableCodexHooks: (codexHome) => installCodexHooks(scriptPath, codexHome),
    enableClaudeHooksIn: (configDir) => installClaudeHooks(scriptPath, configDir),
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
