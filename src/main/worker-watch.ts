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

const STATE_DIR = path.join(os.homedir(), '.codex-agents')
const POLL_MS = 3000

/**
 * 怎么跑 cdx。**唯一的解析入口** —— 体检、轮询、卡片动作必须共用它。
 *
 * 以前是两套：体检查 `which cdx`，而轮询写死
 * `python3 ~/.claude/skills/cxcc-subagent/scripts/cdx.py`。
 * 于是用户明明有可用的 `cdx`，却"体检绿但没有卡片"；反过来只装了 skill
 * 没装命令时是"卡片能用但体检红"。两条判据各自都对，合起来是错的。
 *
 * 顺序：PATH 上的 `cdx` 优先（那是这个工具的正式入口），
 * 再退到已知的 skill 脚本路径 —— 后者是作者机器上的位置，不能当默认。
 *
 * ⚠️ Electron 从 Finder 启动**不继承登录 shell 的 PATH**（codex 采集踩过这个坑），
 * 所以不能靠 `which` 这个命令，要自己在常见目录里找。
 */
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
const SKILL_CDX = path.join(os.homedir(), '.claude', 'skills', 'cxcc-subagent', 'scripts', 'cdx.py')

export interface CdxResolution {
  /** 可执行文件 */
  cmd: string
  /** 固定前缀参数（走 python3 时是脚本路径） */
  prefix: string[]
  /** 给体检显示：从哪儿找到的 */
  detail: string
}

export function resolveCdx(): CdxResolution | null {
  for (const d of BIN_DIRS) {
    const p = path.join(d, 'cdx')
    if (existsSync(p)) return { cmd: p, prefix: [], detail: p }
  }
  if (existsSync(SKILL_CDX)) {
    for (const d of BIN_DIRS) {
      const py = path.join(d, 'python3')
      if (existsSync(py)) return { cmd: py, prefix: [SKILL_CDX], detail: `${py} ${SKILL_CDX}` }
    }
    return null // 有脚本但没 python3 —— 这也是"跑不了"，别假装能跑
  }
  return null
}

const TASK_RE = /^[a-zA-Z0-9_-]+$/

/** worker 卡片操作：result / kill / send（回复 worker 提问）*/
export async function workerAction(
  action: 'result' | 'kill' | 'send' | 'clean',
  task: string,
  text?: string
): Promise<{ ok: boolean; output: string }> {
  if (!TASK_RE.test(task)) return { ok: false, output: 'bad task name' }
  const cdx = resolveCdx()
  if (!cdx) return { ok: false, output: '本机找不到 cdx（装 cxcc-subagent skill 或把 cdx 放进 PATH）' }
  // clean 用 --task 传参，其余动词位置参数
  const verb =
    action === 'clean' ? ['clean', '--task', task, '--json'] : [action, task, '--json']
  const args = [...cdx.prefix, ...verb]
  if (action === 'send') {
    if (!text?.trim()) return { ok: false, output: 'empty reply' }
    args.splice(cdx.prefix.length + 2, 0, text) // cdx send <task> <prompt> --json
  }
  return new Promise((resolve) => {
    execFile(cdx.cmd, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
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
    // 从没 spawn 过 worker → 零成本跳过（状态目录都还没建出来）
    if (busy || !existsSync(STATE_DIR)) return
    const cdx = resolveCdx()
    if (!cdx) return
    busy = true
    execFile(
      cdx.cmd,
      [...cdx.prefix, 'list', '--json'],
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
