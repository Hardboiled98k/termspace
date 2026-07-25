/**
 * F8 派活：tb ask <节点> <任务> —— 上游 agent 把任务交给下游终端里的 agent，等结果回传。
 * 复用现有基建：pty.write 注入任务、hooks 状态判完成、transcript 尾取回答。
 * 无新协议、无新连接。
 */
import { readFile } from 'node:fs/promises'

interface NodeRuntime {
  transcriptPath?: string
  status: string // working | idle | attention...
  lastStopAt: number
  /**
   * agent 会话此刻是否还活着。
   * 注意不能只记"曾经收到过 hook 上报"——那是粘性的：Claude 退出回到 shell 后仍为真，
   * 于是派活又会往普通 shell 里注入文本。必须靠 SessionEnd / 节点销毁把它翻回 false。
   */
  live: boolean
  lastEventAt: number
  /** 当前会话 id；已收到 SessionEnd 的那个 id 记在 endedSession，用来挡迟到事件 */
  sessionId?: string
  endedSession?: string
}

/** 可以接单的状态白名单 —— fail-closed：不在名单里一律拒，别用黑名单 */
const ACCEPTING = new Set(['idle', 'done', 'session'])

const runtime = new Map<string, NodeRuntime>()

function rt(id: string): NodeRuntime {
  let r = runtime.get(id)
  if (!r) {
    r = { status: 'idle', lastStopAt: 0, live: false, lastEventAt: 0 }
    runtime.set(id, r)
  }
  return r
}

export function noteTranscript(id: string, path: string): void {
  rt(id).transcriptPath = path
}

export function noteStatus(id: string, state: string, event?: string, sessionId?: string): void {
  const r = rt(id)
  // 归一化后的 state：working=运行；done/session=一轮结束
  if (state === 'done' || state === 'session') r.lastStopAt = Date.now()
  r.status = state
  r.lastEventAt = Date.now()

  /* 会话存活判定。并行 hook 会晚到：SessionEnd 之后仍可能收到同一会话的
     PostToolUse/Notification，若无条件置活，派活就会把任务直接执行进普通 shell。
     所以按 session_id 记住"已结束的那个会话"，它的迟到事件一律不复活。 */
  if (event === 'SessionEnd') {
    r.live = false
    r.endedSession = sessionId ?? r.sessionId ?? 'unknown'
    return
  }
  if (sessionId) {
    if (sessionId === r.endedSession) return // 已结束会话的迟到事件，忽略
    r.sessionId = sessionId
    r.endedSession = undefined
    r.live = true
    return
  }
  // 没有 session_id 可依据时保守处理：只有 SessionStart 能把死会话拉回活
  if (r.endedSession && event !== 'SessionStart') return
  if (event === 'SessionStart') r.endedSession = undefined
  r.live = true
}

/** 该节点当前是否是活着的 agent 会话 */
export function isAgentSession(id: string): boolean {
  return runtime.get(id)?.live === true
}

export function dropNode(id: string): void {
  runtime.delete(id)
}

/** 读 transcript 最后一条 assistant 文本消息 */
async function lastAssistant(path: string): Promise<string> {
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return ''
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"assistant"')) continue
    try {
      const obj = JSON.parse(line) as {
        type?: string
        message?: { content?: unknown }
      }
      if (obj.type !== 'assistant') continue
      const c = obj.message?.content
      if (typeof c === 'string' && c.trim()) return c.trim()
      if (Array.isArray(c)) {
        const t = c
          .filter((b): b is { type: string; text: string } => (b as { type?: string })?.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim()
        if (t) return t
      }
    } catch {
      // 撕裂行，继续往前
    }
  }
  return ''
}

export interface DelegateDeps {
  hasNode: (id: string) => boolean
  writeToPty: (id: string, data: string) => void
  /**
   * 授权判定：画布上有没有 source→target 的派活连线，没有就问用户。
   * 说明白：source 是调用方自报的（同 UID 进程本来就能直接 tmux send-keys 绕过这里），
   * 所以这是**产品护栏**——防 agent 自己乱派、让画布连线成为真语义——不是安全边界。
   */
  authorize: (source: string, target: string, task: string) => Promise<boolean>
}

/** 同一目标同时只允许一次派活：两个请求都看到 idle 然后一起注入 = 输入流互相踩 */
const busy = new Set<string>()

/**
 * 注入任务 → 轮询等这一轮的 Stop（相对发起时刻的新 Stop）→ 取 transcript 尾。
 * 超时/无 transcript 有明确回话，绝不无限挂起。
 */
export async function delegate(
  deps: DelegateDeps,
  sourceId: string,
  targetId: string,
  task: string,
  timeoutMs = 240_000
): Promise<string> {
  if (!deps.hasNode(targetId)) {
    return `派活失败：找不到终端 ${targetId}（tb agents 看可用节点）。`
  }
  if (!task.trim()) return '派活失败：任务为空。'
  if (sourceId === targetId) return '派活失败：不能派给自己。'

  const r = rt(targetId)

  // 注入 = 等同替用户在目标终端敲一行回车。目标若是普通 shell，这行就是被直接执行的命令。
  // 所以要求"当前是活着的 agent 会话"，不能靠注入后再看反应（那时已经执行了）。
  if (!r.live) {
    return `派活被拒：${targetId} 当前不是活着的 agent 会话（没有 agent 状态上报，或已收到 SessionEnd）。
tb ask 只能派给正在跑 agent 的终端 —— 往普通 shell 注入文本等于直接执行任意命令。
用 tb agents 看哪些节点在跑 agent。`
  }
  // fail-closed：只有明确在接单状态才放行。working / blocked（正在等审批）/ waiting
  // 都意味着有别的输入正在被处理，这时注入就是往输入流里插字。
  if (!ACCEPTING.has(r.status)) {
    return `派活被拒：${targetId} 当前状态是 ${r.status}，不接受注入（正在运行、或在等你回应）。等它空闲再试。`
  }
  if (busy.has(targetId)) {
    return `派活被拒：${targetId} 上已有一次派活在进行中，等它结束再来。`
  }

  const epoch = r.sessionId
  if (!(await deps.authorize(sourceId, targetId, task))) {
    return `派活被拒：${sourceId} → ${targetId} 未获授权。
在画布上从你的节点拉一条线到目标终端（终端→终端 = 派活通道），或在弹窗里批准本次调用。`
  }

  /* 弹窗期间目标可能已退出、开始干活、或被同 id 重建 —— 全部复查一遍再占位。
     只查 busy 是不够的（授权那一刻的判断已经过时了）。 */
  const now = rt(targetId)
  if (now !== r || !deps.hasNode(targetId)) {
    return `派活被拒：${targetId} 在你批准期间已经变了（节点被重建或移除），未注入。`
  }
  if (!now.live || !ACCEPTING.has(now.status) || now.sessionId !== epoch) {
    return `派活被拒：${targetId} 在你批准期间状态变成了 ${now.live ? now.status : '会话已结束'}，未注入。`
  }
  if (busy.has(targetId)) return `派活被拒：${targetId} 上已有一次派活在进行中。`
  busy.add(targetId)
  try {
    return await runDelegation(deps, now, targetId, task, timeoutMs)
  } finally {
    busy.delete(targetId)
  }
}

async function runDelegation(
  deps: DelegateDeps,
  r: NodeRuntime,
  targetId: string,
  task: string,
  timeoutMs: number
): Promise<string> {
  const startStop = r.lastStopAt
  const startAt = Date.now()

  // 注入任务（等同用户在目标终端敲一行回车）
  deps.writeToPty(targetId, `${task}\r`)

  // 等这一轮结束：出现比发起时刻更新的 Stop，且已进入过 working（避免注入还没被处理就误判）
  let sawWorking = false
  while (Date.now() - startAt < timeoutMs) {
    await new Promise((res) => setTimeout(res, 1500))
    if (r.status === 'working') sawWorking = true
    // 注入后 12s 仍没进入 working、也没新 Stop → 目标不是活跃 agent（普通 shell 命令已瞬间跑完）
    if (!sawWorking && r.lastStopAt <= startStop && Date.now() - startAt > 12_000) {
      return `[${targetId} 不像活跃 agent 会话（可能是普通终端）。命令已注入，请直接查看该终端输出。]`
    }
    if (r.lastStopAt > startStop && sawWorking) {
      await new Promise((res) => setTimeout(res, 1200)) // 等 transcript 落盘完整
      const ans = r.transcriptPath ? await lastAssistant(r.transcriptPath) : ''
      return ans || `[${targetId} 已完成，但未取到文本回答，直接看该终端输出]`
    }
  }
  return `[派活超时：${targetId} 在 ${Math.round(timeoutMs / 1000)}s 内未完成，任务可能仍在跑，去该终端查看]`
}
