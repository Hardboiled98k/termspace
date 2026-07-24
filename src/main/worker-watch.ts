/**
 * F7 worker 可视化：轮询 cxcc-subagent (franke_skills, MIT) 的 cdx list --json，
 * 把 detached worker 状态推给画布渲染成卡片。
 * 执行引擎归 cdx（spawn/send/result 由 agent 在终端里自己调 skill），我们只负责看得见。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface WorkerRow {
  task: string
  backend: string
  model?: string
  state: string // working | awaiting_reply | stalled | failed | killed | done
  repo?: string
  age_s?: number
  question?: string | null
  last_activity?: string | null
}

const CDX = path.join(os.homedir(), '.claude', 'skills', 'cxcc-subagent', 'scripts', 'cdx.py')
const STATE_DIR = path.join(os.homedir(), '.codex-agents')
const POLL_MS = 3000

const TASK_RE = /^[a-zA-Z0-9_-]+$/

/** worker 卡片操作：result / kill / send（回复 worker 提问）*/
export async function workerAction(
  action: 'result' | 'kill' | 'send',
  task: string,
  text?: string
): Promise<{ ok: boolean; output: string }> {
  if (!TASK_RE.test(task)) return { ok: false, output: 'bad task name' }
  const args = [CDX, action, task, '--json']
  if (action === 'send') {
    if (!text?.trim()) return { ok: false, output: 'empty reply' }
    args.splice(3, 0, text) // cdx send <task> <prompt> --json
  }
  return new Promise((resolve) => {
    execFile('python3', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // cdx 用非零退出码表状态（10/11/12/13），stdout JSON 仍有效 → 一律回传
      resolve({ ok: !err || stdout.length > 0, output: stdout.trim() || String(err ?? '') })
    })
  })
}

export interface WorkerWatch {
  refresh: () => void
  dispose: () => void
}

export function startWorkerWatch(onRows: (rows: WorkerRow[]) => void): WorkerWatch {
  let busy = false
  let lastJson = ''

  const poll = (): void => {
    // 没装 skill / 从没 spawn 过 worker → 零成本跳过
    if (busy || !existsSync(CDX) || !existsSync(STATE_DIR)) return
    busy = true
    execFile(
      'python3',
      [CDX, 'list', '--json'],
      { timeout: 10_000 },
      (err, stdout) => {
        busy = false
        if (err) return // python 缺失/超时 → 静默，下轮再试
        try {
          const rows = JSON.parse(stdout) as WorkerRow[]
          const key = JSON.stringify(rows.map((r) => [r.task, r.state, r.question, r.age_s && 0]))
          // age_s 每秒都变，去掉后比对，避免无意义推送
          if (key !== lastJson) {
            lastJson = key
            onRows(rows)
          }
        } catch {
          // 输出损坏 → 忽略
        }
      }
    )
  }

  const timer = setInterval(poll, POLL_MS)
  poll()
  return {
    // renderer 就绪/reload 后强制重推（清掉去重缓存）
    refresh: () => {
      lastJson = ''
      poll()
    },
    dispose: () => clearInterval(timer)
  }
}
