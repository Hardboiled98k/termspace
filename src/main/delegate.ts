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
}

const runtime = new Map<string, NodeRuntime>()

function rt(id: string): NodeRuntime {
  let r = runtime.get(id)
  if (!r) {
    r = { status: 'idle', lastStopAt: 0 }
    runtime.set(id, r)
  }
  return r
}

export function noteTranscript(id: string, path: string): void {
  rt(id).transcriptPath = path
}

export function noteStatus(id: string, state: string): void {
  const r = rt(id)
  // 归一化后的 state：working=运行；done/session=一轮结束
  if (state === 'done' || state === 'session') r.lastStopAt = Date.now()
  r.status = state
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
}

/**
 * 注入任务 → 轮询等这一轮的 Stop（相对发起时刻的新 Stop）→ 取 transcript 尾。
 * 超时/无 transcript 有明确回话，绝不无限挂起。
 */
export async function delegate(
  deps: DelegateDeps,
  targetId: string,
  task: string,
  timeoutMs = 240_000
): Promise<string> {
  if (!deps.hasNode(targetId)) {
    return `派活失败：找不到终端 ${targetId}（tb agents 看可用节点）。`
  }
  if (!task.trim()) return '派活失败：任务为空。'

  const r = rt(targetId)
  const startStop = r.lastStopAt
  const startAt = Date.now()

  // 注入任务（等同用户在目标终端敲一行回车）。前置换行确保落在干净提示符。
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
