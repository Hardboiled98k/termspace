/**
 * F8 派活：tb ask <节点> <任务> —— 上游 agent 把任务交给下游终端里的 agent，等结果回传。
 * 复用现有基建：pty.write 注入任务、hooks 状态判完成、transcript 尾取回答。
 * 无新协议、无新连接。
 */
import { readFile, stat } from 'node:fs/promises'

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
  /** 当前活跃会话 id（有些事件不带，故可空） */
  sessionId?: string
  /**
   * 单调递增的会话代号。任何"这个终端换人了"的时刻都 +1：
   * SessionStart / SessionEnd / 节点销毁。授权弹窗前后比对它，比对可空的 sessionId 可靠。
   */
  epoch: number
  /** 已判死，只有 SessionStart 能复活 —— 别的事件（含迟到的）一律不复活 */
  deadUntilStart: boolean
  /**
   * 进入过多少次 working。**不能靠轮询采样 `status === 'working'` 来判"它动过"** ——
   * 循环每 1.5s 看一眼，一个 1 秒内跑完的任务会整段错过，于是 12s 后被判成
   * "不像活跃 agent"，而它其实早就做完了。计数器是持久的，采样漏了也还在。
   */
  workingSeq: number
  /**
   * 结束过多少轮。**不能用 `lastStopAt` 时间戳判"有没有新的一轮"** ——
   * Date.now() 只有毫秒精度，一轮若在同一毫秒内跑完（秒回的任务、本地 mock），
   * `lastStopAt > startStop` 永远不成立，派活就一路挂到超时。
   * 计数器是精确的，和时钟精度无关。
   */
  stopSeq: number
}

/** 可以接单的状态白名单 —— fail-closed：不在名单里一律拒，别用黑名单 */
const ACCEPTING = new Set(['idle', 'done', 'session'])

/* 已结束的会话 id。必须独立于 NodeRuntime 存在：节点被删（dropNode）时 runtime 会被重置，
   若墓碑跟着没了，旧会话的迟到事件就能把同 id 的新终端（可能只是个普通 shell）判成活 agent。 */
const endedSessions = new Set<string>()
const ENDED_MAX = 500
function rememberEnded(sid: string): void {
  endedSessions.add(sid)
  if (endedSessions.size > ENDED_MAX) {
    // Set 保序，删最早的一批
    for (const s of endedSessions) {
      endedSessions.delete(s)
      if (endedSessions.size <= ENDED_MAX * 0.8) break
    }
  }
}

const runtime = new Map<string, NodeRuntime>()

function rt(id: string): NodeRuntime {
  let r = runtime.get(id)
  if (!r) {
    r = {
      status: 'idle',
      lastStopAt: 0,
      live: false,
      lastEventAt: 0,
      epoch: 0,
      deadUntilStart: false,
      workingSeq: 0,
      stopSeq: 0
    }
    runtime.set(id, r)
  }
  return r
}

export function noteTranscript(id: string, path: string): void {
  rt(id).transcriptPath = path
}

/**
 * 会话存活判定 —— 这是整个派活链路的地基，判错就是往普通 shell 里执行任意命令。
 *
 * 难点在于 hook 是并行且乱序的：SessionEnd 之后仍会收到同会话的 PostToolUse，
 * 新会话开始后也可能收到旧会话的 Stop。规则因此是 fail-closed 的：
 * - 已知已结束的会话（endedSessions），其事件整条丢弃
 * - 只有 SessionStart 能把判死的节点复活
 * - 其余事件必须属于当前活跃会话，否则忽略
 */
export function noteStatus(id: string, state: string, event?: string, sessionId?: string): void {
  const r = rt(id)
  r.lastEventAt = Date.now()

  /* SessionStart 要先于墓碑判定处理：`claude --resume` 会用**同一个 session_id**
     重开会话，若被墓碑挡掉，这个节点就永远不可派活了。SessionStart 是明确的
     "现在开始"信号，迟到的旧 SessionStart 实际不存在，所以放它复活是安全的。 */
  if (event === 'SessionStart') {
    if (sessionId) endedSessions.delete(sessionId)
    r.sessionId = sessionId
    r.deadUntilStart = false
    r.live = true
    r.epoch++
    r.status = state
    r.lastStopAt = Date.now()
    r.stopSeq++
    return
  }

  // 已结束会话的迟到事件：连状态都不许改
  if (sessionId && endedSessions.has(sessionId)) return

  if (event === 'SessionEnd') {
    if (sessionId) rememberEnded(sessionId)
    r.live = false
    r.deadUntilStart = true
    r.epoch++
    r.sessionId = undefined
    r.status = state
    return
  }

  // 别的会话的事件（新旧都算），不碰本节点状态
  if (sessionId && r.sessionId && sessionId !== r.sessionId) return
  // 判死后只认 SessionStart，其余一律不复活
  if (r.deadUntilStart) return
  // 还没见过 SessionStart（app 后启动、接回已经在跑的会话）→ 采纳它
  if (sessionId && !r.sessionId) {
    r.sessionId = sessionId
    r.epoch++
  }

  r.live = true
  if (state === 'working' && r.status !== 'working') r.workingSeq++
  r.status = state
  if (state === 'done' || state === 'session') {
    r.lastStopAt = Date.now()
    r.stopSeq++
  }
}

/** 该节点当前是否是活着的 agent 会话 */
export function isAgentSession(id: string): boolean {
  return runtime.get(id)?.live === true
}

/**
 * 节点销毁 / PTY 结束。**不能直接 delete** —— 那会把"已判死"的墓碑一起抹掉，
 * 旧会话的迟到事件就能把同 id 的新终端重新判成活 agent（codex 复现过真实注入）。
 */
export function dropNode(id: string): void {
  const r = runtime.get(id)
  if (!r) return
  if (r.sessionId) rememberEnded(r.sessionId)
  r.live = false
  r.deadUntilStart = true
  r.epoch++
  r.sessionId = undefined
  r.transcriptPath = undefined
  r.status = 'idle'
}

/**
 * 从一行 transcript JSON 里取 assistant 正文。**两家格式完全不同，都要认**：
 *
 *   Claude Code  `{type:"assistant",     message:{content:[{type:"text",        text}]}}`
 *   codex        `{type:"response_item", payload:{type:"message", role:"assistant",
 *                                                 content:[{type:"output_text", text}]}}`
 *
 * 只认 Claude 那套的话，claude → codex 的派活会「注入成功、完成检测成功、但取不回答案」——
 * 半通的链路比不通更难查，因为界面上一切正常，只有回话是一句"未取到文本回答"。
 */
export function assistantText(line: string): string {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return '' // 撕裂行（transcript 正在被写）
  }
  const o = obj as {
    type?: string
    message?: { content?: unknown }
    payload?: { type?: string; role?: string; content?: unknown }
  }
  let content: unknown
  if (o.type === 'assistant') content = o.message?.content
  else if (o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'assistant') {
    content = o.payload.content
  } else return ''

  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  // text（Claude）和 output_text（codex）都收；工具调用等其他块跳过
  return content
    .filter((b): b is { type: string; text: string } => {
      const t = (b as { type?: string })?.type
      return (t === 'text' || t === 'output_text') && typeof (b as { text?: unknown }).text === 'string'
    })
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** transcript 当前字节数。取不到返回 0（当作"从头都是新的"） */
async function fileSize(path: string): Promise<number> {
  return stat(path)
    .then((st) => st.size)
    .catch(() => 0)
}

/**
 * 取**本轮**的最后一条 assistant 正文。
 *
 * `sinceBytes` 是发起派活那一刻的文件长度，只认这之后写进去的内容。
 * **不钉这个偏移的话，最危险的失败是"拿上一轮的回答当本轮结果返回"** ——
 * 目标其实没回答（或回答里全是工具调用没有正文），却把几分钟前的旧答案
 * 一本正经地交回给发起方，看不出任何异常。
 *
 * 文件比 sinceBytes 短 = 被轮转或换了会话 → 整份都算新的。
 */
async function lastAssistantSince(path: string, sinceBytes: number): Promise<string> {
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return ''
  }
  const buf = Buffer.from(text, 'utf8')
  const fresh = buf.length >= sinceBytes ? buf.subarray(sinceBytes).toString('utf8') : text
  const lines = fresh.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = assistantText(lines[i] ?? '')
    if (t) return t
  }
  return ''
}

/**
 * 目标 pane 此刻的前台进程名。空串 = 查不到（没开 tmux / 查询失败）。
 * 见 isShellForeground 的注释：这是防"任务被当成 shell 命令执行"的最后一道闸。
 */
export type ForegroundProbe = (id: string) => Promise<string>

/**
 * 这个前台进程是不是一个**光秃秃的 shell**。
 *
 * hook 上报是 fail-open 的：agent 退出时 SessionEnd 那条 curl 失败，主进程就永远
 * 以为它还活着（live=true, status=done），下一次派活直接把任务文本写进 pty ——
 * 而此刻 pane 里是 zsh，那一行就是**被执行的命令**。已实测复现。
 *
 * 判据用白名单式的"已知 shell"而不是"已知 agent"：agent 的进程名五花八门
 * （claude / codex / node / python / bun…），列不全；而 shell 就那么几个。
 * 认不出的进程名一律当成"不是 shell"放行 —— 否则任何新 CLI 都会被误拦。
 */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'xonsh'])
export function isShellForeground(cmd: string): boolean {
  const name = cmd.trim().replace(/^-/, '').split('/').pop() ?? ''
  return SHELLS.has(name.toLowerCase())
}

export interface DelegateDeps {
  hasNode: (id: string) => boolean
  writeToPty: (id: string, data: string) => void
  /** 可选：没提供就退回只靠 hook 状态（老行为） */
  foreground?: ForegroundProbe
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
 * 有派活正在飞。画布上那条线据此点亮流光。
 *
 * **常驻动画是噪声**：这个产品的招牌交互是"缩到全景看颜色分布即知谁在等你"，
 * 而全景里唯一在动的东西应该是"此刻真有事发生"，不是"这里存在一条线"。
 */
let onFlight: ((e: { source: string; target: string; active: boolean }) => void) | null = null
export function setDelegateFlightListener(fn: typeof onFlight): void {
  onFlight = fn
}

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

  // 比对 epoch 而不是可空的 sessionId：没带 session_id 的 End→Start 序列同样会推进 epoch
  const epoch = r.epoch
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
  if (!now.live || !ACCEPTING.has(now.status) || now.epoch !== epoch) {
    return `派活被拒：${targetId} 在你批准期间${
      now.epoch !== epoch ? '换了会话' : now.live ? `状态变成了 ${now.status}` : '会话已结束'
    }，未注入。`
  }
  if (busy.has(targetId)) return `派活被拒：${targetId} 上已有一次派活在进行中。`
  busy.add(targetId)
  onFlight?.({ source: sourceId, target: targetId, active: true })
  try {
    return await runDelegation(deps, now, targetId, task, timeoutMs)
  } finally {
    busy.delete(targetId)
    onFlight?.({ source: sourceId, target: targetId, active: false })
  }
}

async function runDelegation(
  deps: DelegateDeps,
  r: NodeRuntime,
  targetId: string,
  task: string,
  timeoutMs: number
): Promise<string> {
  /* 注入前最后一道闸：pane 里此刻跑的要是个光秃秃的 shell，说明 agent 早退了、
     只是 SessionEnd 丢了。**这时注入 = 直接执行任意命令**，必须拒。
     查不到（没开 tmux）就沿用 hook 状态那套判断，不把功能一刀切死。 */
  if (deps.foreground) {
    const cmd = await deps.foreground(targetId)
    if (cmd && isShellForeground(cmd)) {
      return `派活被拒：${targetId} 此刻前台是 ${cmd}（一个普通 shell），agent 已经退出了。
状态里还标着"活着"是因为它退出时的上报丢了。往 shell 注入文本等于直接执行命令，所以拦下。
在那个终端里重新起 agent 再试。`
    }
  }

  const startStop = r.stopSeq
  const startSeq = r.workingSeq
  const startAt = Date.now()
  /* 钉住发起那一刻的 transcript 位置和路径。**不钉的话最危险的失败是
     "把上一轮的回答当成本轮结果返回"** —— 目标其实没答（或只有工具调用没有正文），
     却把几分钟前的旧答案一本正经交回去，从外面看不出任何异常。 */
  const startPath = r.transcriptPath
  const startBytes = startPath ? await fileSize(startPath) : 0

  // 注入任务（等同用户在目标终端敲一行回车）
  deps.writeToPty(targetId, `${task}\r`)

  /** 这一轮到底动过没有。计数器 + 采样双保险，见 workingSeq 的注释 */
  const moved = (): boolean => r.status === 'working' || r.workingSeq > startSeq

  while (Date.now() - startAt < timeoutMs) {
    await new Promise((res) => setTimeout(res, 1500))
    // 注入后 12s 仍没动过、也没新 Stop → 目标不是活跃 agent（普通 shell 命令已瞬间跑完）
    if (!moved() && r.stopSeq <= startStop && Date.now() - startAt > 12_000) {
      return `[${targetId} 不像活跃 agent 会话（可能是普通终端）。命令已注入，请直接查看该终端输出。]`
    }
    if (r.stopSeq > startStop && moved()) {
      await new Promise((res) => setTimeout(res, 1200)) // 等 transcript 落盘完整
      // 路径中途变了 = 换了会话文件，那整份都是新的，偏移归零
      const same = r.transcriptPath === startPath
      const ans = r.transcriptPath
        ? await lastAssistantSince(r.transcriptPath, same ? startBytes : 0)
        : ''
      return ans || `[${targetId} 已完成，但本轮没有新的文本回答，直接看该终端输出]`
    }
  }
  return `[派活超时：${targetId} 在 ${Math.round(timeoutMs / 1000)}s 内未完成，任务可能仍在跑，去该终端查看]`
}
