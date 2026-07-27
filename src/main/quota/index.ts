/**
 * 额度采集调度。
 *
 * **一个账号一个采集器，全局单例拉一次广播给所有节点** —— 额度是账号级的，
 * 绝不每个节点各拉一遍（同一个号会被查 N 次，还可能撞限流）。
 */
import { collectClaude } from './claude'
import { collectCodex } from './codex'
import { now, type AccountQuota } from './types'

export type { AccountQuota, QuotaWindow, QuotaSpend, QuotaState } from './types'

/** 5 分钟。Claude Code 自己的写节流就是 5min，比这更密没有信息增量，只是白打后端 */
const INTERVAL_MS = 5 * 60_000
/** 手动触发（HUD 展开、turn 结束）的最小间隔，防连点 */
const MIN_GAP_MS = 60_000

export interface QuotaAccount {
  accountId: string
  provider: string
  name: string
  /** identity 展开后的 env（只需要 CODEX_HOME / CLAUDE_CONFIG_DIR 两个键） */
  env: Record<string, string>
}

export interface QuotaHub {
  /** 当前全部账号的额度快照 */
  snapshot: () => AccountQuota[]
  /** 账号列表变了（新增/删除凭证）时重建 */
  setAccounts: (list: QuotaAccount[]) => void
  refresh: (force?: boolean) => void
  dispose: () => void
}

export function startQuotaHub(
  homeDir: string,
  onUpdate: (list: AccountQuota[]) => void
): QuotaHub {
  let accounts: QuotaAccount[] = []
  const results = new Map<string, AccountQuota>()
  let lastRun = 0
  let running = false

  const collectOne = async (a: QuotaAccount): Promise<AccountQuota> => {
    try {
      if (a.provider === 'codex') {
        return await collectCodex({
          accountId: a.accountId,
          name: a.name,
          codexHome: a.env['CODEX_HOME'] || `${homeDir}/.codex`,
          homeDir
        })
      }
      if (a.provider === 'claude') {
        return await collectClaude({
          accountId: a.accountId,
          name: a.name,
          configDir: a.env['CLAUDE_CONFIG_DIR'],
          homeDir
        })
      }
    } catch (e) {
      // 采集器不该抛，但真抛了也不能让整轮挂掉
      return {
        accountId: a.accountId,
        provider: a.provider,
        name: a.name,
        state: 'unavailable',
        capturedAt: now(),
        source: '-',
        windows: [],
        hint: `采集器出错：${(e as Error).message}`
      }
    }
    return {
      accountId: a.accountId,
      provider: a.provider,
      name: a.name,
      state: 'unconfigured',
      capturedAt: now(),
      source: '-',
      windows: [],
      hint: `暂不支持 ${a.provider} 的额度查询`
    }
  }

  const run = async (force = false): Promise<void> => {
    if (running) return
    if (!force && Date.now() - lastRun < MIN_GAP_MS) return
    running = true
    lastRun = Date.now()
    try {
      // 各账号并行；一个挂了不影响别的
      const list = await Promise.all(accounts.map(collectOne))
      results.clear()
      for (const r of list) results.set(r.accountId, r)
      onUpdate(list)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void run(), INTERVAL_MS)

  return {
    snapshot: () => [...results.values()],
    setAccounts: (list) => {
      const changed =
        list.length !== accounts.length ||
        list.some((a, i) => a.accountId !== accounts[i]?.accountId)
      accounts = list
      if (changed) void run(true)
    },
    refresh: (force) => void run(force),
    dispose: () => clearInterval(timer)
  }
}
