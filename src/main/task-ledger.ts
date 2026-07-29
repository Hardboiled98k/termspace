/**
 * 任务账本 —— 「谁在什么时候让哪个 agent 干了什么、结果能不能信」。
 *
 * 为什么需要它：现在派活状态、worker 卡片、发光边框**全是运行时投影**，
 * app 一重启就没了。多 agent 的真实痛点不是"开不出更多终端"，
 * 而是**人离开一小时回来，不知道哪些结果可信、哪些要接管**。
 *
 * 明确不做的事（别把它做成聊天记录）：
 * - 不存完整对话，只存**摘要 + transcript 路径**。完整对话在 agent 自己的
 *   transcript 里，我们存一份等于同一份数据两个真相源，而且体积失控
 * - 不做重放/续聊 UI。要接着聊就跳到那个终端 —— 那才是真正的上下文所在地
 *
 * 落盘判据（都踩过）：
 * - **JSONL 追加写**，不是整份 JSON 重写：任务是只增的流水，
 *   整份重写意味着每条新记录都要先读全量、再写全量，写到一半被杀就全丢
 * - **单条损坏不能带走整份**：解析逐行 try/catch，坏行跳过
 * - 有上限（`MAX_RECORDS`）：这是流水不是归档，无限增长会让启动读盘变慢
 */
import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { classifyDelegateResult } from './delegate.ts'

export type TaskState = 'running' | 'done' | 'failed' | 'timeout' | 'rejected'

export interface TaskRecord {
  id: string
  /** 谁派的：节点 id，或 'user'（用户在界面上直接发起） */
  source: string
  /** 派给谁：本机节点 id，或 `<ssh别名>:<节点id>` */
  target: string
  /** 任务正文的摘要（**不存全文**，长任务只留开头） */
  brief: string
  startedAt: number
  endedAt?: number
  state: TaskState
  /** 结果摘要（同样是截断的） */
  result?: string
  /** 失败原因 */
  error?: string
  /** 目标当时所在的 worktree 分支（有的话）—— 结果可信度的关键上下文 */
  branch?: string
  /** 目标 agent 的 transcript 路径。**要接着看全文就去这儿**，我们不复制一份 */
  transcript?: string
}

/** 摘要上限。够在卡片上认出"这是哪一件事"，又不至于让账本变成对话存档 */
const BRIEF_MAX = 280
const MAX_RECORDS = 500

export const briefly = (s: string, max = BRIEF_MAX): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 解析 JSONL。**坏行跳过而不是整份放弃** ——
 * 追加写在断电/被杀时最后一行可能是半条，那不该让前面几百条一起消失。
 */
export function parseLedger(text: string): TaskRecord[] {
  const out: TaskRecord[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as TaskRecord
      /* 只要求有 id。**不能要求 startedAt** —— 结束时写的那条是个补丁
         （只有 id / state / endedAt / result），要求它带 startedAt
         等于把所有"结束"记录全丢掉，任务永远停在运行中。
         真正的孤儿补丁在 mergeLedger 里剔除（那里才知道有没有配对的开始记录）。 */
      if (r && typeof r.id === 'string') out.push(r)
    } catch {
      // 半条 / 损坏 → 跳过
    }
  }
  return out
}

/**
 * 同一个任务的多条记录合并成最终态：**后写的覆盖先写的**。
 *
 * 追加写意味着一个任务会写两次（开始一条、结束一条）。合并放在读取侧，
 * 写入侧就永远只是 append —— 这是选 JSONL 的全部理由。
 */
export function mergeLedger(records: TaskRecord[]): TaskRecord[] {
  const byId = new Map<string, TaskRecord>()
  for (const r of records) byId.set(r.id, { ...(byId.get(r.id) ?? {}), ...r })
  return (
    [...byId.values()]
      /* 没有开始记录的补丁 = 孤儿（账本被压实过、而结束记录晚到）。
         留着它界面上会出现一条没有来源、没有任务正文的空卡。 */
      .filter((r) => typeof r.startedAt === 'number')
      // 新的在前：账本的用法是"我离开这段时间发生了什么"
      .toSorted((a, b) => b.startedAt - a.startedAt)
  )
}

/**
 * 卡片排序：**需要处理的在前**。
 * 失败/超时 > 还在跑 > 刚完成 > 更早完成。
 * 和消息中心、画布颜色是同一套优先级语义。
 */
const STATE_RANK: Record<TaskState, number> = {
  failed: 0,
  timeout: 0,
  rejected: 1,
  running: 2,
  done: 3
}
export function sortForReview(records: TaskRecord[]): TaskRecord[] {
  return records.toSorted(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.startedAt - a.startedAt
  )
}

export interface Ledger {
  start: (r: Omit<TaskRecord, 'id' | 'startedAt' | 'state'>) => Promise<string>
  finish: (id: string, patch: Partial<TaskRecord> & { state: TaskState }) => Promise<void>
  list: () => Promise<TaskRecord[]>
}

type LedgerState = 'done' | 'failed' | 'timeout' | 'rejected'

export interface LedgerMeta {
  source: string
  target: string
  task: string
  branch?: string
  classify?: (text: string) => LedgerState
}

/**
 * 包一层记账。run 抛异常时必须记为 failed，并把原异常继续抛给调用方；
 * 账本只是观测层，不能把崩溃伪装成成功或改变控制流。
 */
export async function withLedger(
  ledger: Ledger | null,
  meta: LedgerMeta,
  run: () => Promise<string>
): Promise<string> {
  const id = await ledger
    ?.start({ source: meta.source, target: meta.target, brief: meta.task, branch: meta.branch })
    .catch(() => undefined)
  let text = ''
  let crashed = false
  try {
    text = await run()
    return text
  } catch (e) {
    crashed = true
    text = String((e as Error)?.message ?? e).slice(0, 500)
    throw e
  } finally {
    if (id) {
      const state = crashed ? 'failed' : (meta.classify ?? classifyDelegateResult)(text)
      void ledger
        ?.finish(id, {
          state,
          ...(state === 'done' ? { result: text } : { error: text })
        })
        .catch(() => undefined)
    }
  }
}

export function createLedger(file: string, now: () => number = Date.now): Ledger {
  /* 写入串行化。两个派活可以同时结束，而 appendFile 本身不保证多次调用之间
     不交错（大 payload 时会分块写）。记录都很小，但"很小"不是判据。 */
  let chain: Promise<unknown> = Promise.resolve()
  /** **所有**碰这个文件的操作都要过这里，不只是 append —— 见下面压实那段的注释 */
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }
  const append = (rec: Partial<TaskRecord>): Promise<void> =>
    serialize(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(rec)}\n`)
    })

  return {
    start: async (r) => {
      const id = randomUUID()
      await append({ ...r, id, startedAt: now(), state: 'running', brief: briefly(r.brief) })
      return id
    },
    finish: async (id, patch) => {
      await append({
        ...patch,
        id,
        endedAt: now(),
        ...(patch.result ? { result: briefly(patch.result) } : {}),
        ...(patch.error ? { error: briefly(patch.error, 200) } : {})
      })
      /* 顺手压实：条数超上限时重写一份合并后的。
         **压实必须原子**（tmp+rename）—— 直接截断重写时被杀就是整份账本没了。

         ⚠️ **而且必须和 append 走同一条串行链。** 老实现把这整段放在链外，
         于是「读全量 → 写 tmp → rename」中间任何一次 append 都会被 rename 整份盖掉。
         而账本一旦满 MAX_RECORDS，**之后每一次 finish 都会触发压实**
         （压实后正好等于上限，下一条 finish 就是上限+1），窗口一直开着。
         实测复现：finish(A) 不 await → 一个 setImmediate → start(B)，
         **B 的开始记录直接消失**；B 完成时那条 finish 补丁成了孤儿，
         被 `mergeLedger` 的 "没有 startedAt 就丢" 过滤掉 ——
         **整次派活在账本里从未存在过**。丢的若是 finish 补丁，则症状变成
         任务永远停在「运行中」。全程不报错、typecheck 和测试全绿。 */
      await serialize(async () => {
        const all = mergeLedger(parseLedger(existsSync(file) ? await readFile(file, 'utf8') : ''))
        if (all.length > MAX_RECORDS) {
          const keep = all.slice(0, MAX_RECORDS)
          const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
          await writeFile(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + '\n')
          await rename(tmp, file)
        }
      })
    },
    list: async () => {
      if (!existsSync(file)) return []
      return mergeLedger(parseLedger(await readFile(file, 'utf8').catch(() => '')))
    }
  }
}
