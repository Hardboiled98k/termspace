/**
 * Context-window meter：tail Claude transcript .jsonl 取最新 assistant usage
 * （设计参考 ARCHITECTURE-NOTES.md §3 — usage 不来自 hook，来自 transcript 增量读）
 */
import { open } from 'node:fs/promises'

export interface ContextUsage {
  nodeId: string
  usedTokens: number
  windowTokens: number
  usedPercent: number
  model: string
}

const POLL_MS = 1000
const TAIL_CAP = 256 * 1024 // 首读只看尾部，避免大 transcript 全量扫

function windowFor(model: string): number {
  if (/\[1m\]|-1m/i.test(model)) return 1_000_000
  return 200_000
}

interface Entry {
  path: string
  offset: number
  carry: string
  lastEmit: string
}

export interface ContextTail {
  track: (nodeId: string, path: string) => void
  untrack: (nodeId: string) => void
  dispose: () => void
}

export function createContextTail(onUsage: (u: ContextUsage) => void): ContextTail {
  const entries = new Map<string, Entry>()

  async function pollOne(nodeId: string, e: Entry): Promise<void> {
    const fh = await open(e.path, 'r')
    try {
      const stat = await fh.stat()
      if (stat.size < e.offset) {
        // 文件被轮转/截断，从头再来
        e.offset = 0
        e.carry = ''
      }
      let start = e.offset
      if (start === 0 && stat.size > TAIL_CAP) {
        start = stat.size - TAIL_CAP
        e.carry = '' // 掉进行中间没关系，撕裂行会 JSON.parse 失败被跳过
      }
      if (stat.size === start) return
      const len = stat.size - start
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, start)
      e.offset = stat.size

      const text = e.carry + buf.toString('utf8')
      const lines = text.split('\n')
      e.carry = lines.pop() ?? '' // 撕裂尾行 carry 到下次

      // 从后往前找最新一条 assistant usage
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
        try {
          const obj = JSON.parse(line) as {
            type?: string
            message?: {
              model?: string
              usage?: {
                input_tokens?: number
                cache_read_input_tokens?: number
                cache_creation_input_tokens?: number
              }
            }
          }
          if (obj.type !== 'assistant') continue
          const usage = obj.message?.usage
          if (!usage) continue
          const used =
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0)
          const model = String(obj.message?.model ?? '')
          const win = windowFor(model)
          const key = `${used}:${model}`
          if (key !== e.lastEmit) {
            e.lastEmit = key
            onUsage({
              nodeId,
              usedTokens: used,
              windowTokens: win,
              usedPercent: Math.min(100, Math.round((used / win) * 100)),
              model
            })
          }
          return
        } catch {
          // 撕裂/坏行，继续往前找
        }
      }
    } finally {
      await fh.close()
    }
  }

  const timer = setInterval(() => {
    for (const [nodeId, e] of entries) {
      pollOne(nodeId, e).catch(() => {
        // transcript 暂不可读（刚创建/被删），下轮再试
      })
    }
  }, POLL_MS)

  return {
    track(nodeId, path) {
      const cur = entries.get(nodeId)
      if (cur?.path === path) return
      entries.set(nodeId, { path, offset: 0, carry: '', lastEmit: '' })
    },
    untrack(nodeId) {
      entries.delete(nodeId)
    },
    dispose() {
      clearInterval(timer)
    }
  }
}
