/**
 * 额度采集调度。
 *
 * **一个账号一个采集器，全局单例拉一次广播给所有节点** —— 额度是账号级的，
 * 绝不每个节点各拉一遍（同一个号会被查 N 次，还可能撞限流）。
 */
import { collectClaude } from './claude.ts'
import { collectCodex } from './codex.ts'
import { collectCopilot } from './copilot.ts'
import { now, type AccountQuota } from './types.ts'

export type { AccountQuota, QuotaWindow, QuotaSpend, QuotaState } from './types.ts'

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
  /**
   * 计费方式。**`api-key` 的账号绝不能走订阅采集器** ——
   * 没有隔离目录时采集器会回退到默认目录/默认钥匙串，把**系统默认订阅号的额度**
   * 标在这个 API key 名下，用户看到的百分比属于另一个账号，
   * 而这个终端实际是按量计费。显示反了比不显示糟得多。
   */
  kind?: 'subscription' | 'api-key'
}

export interface QuotaHub {
  /** 当前全部账号的额度快照 */
  snapshot: () => AccountQuota[]
  /** 账号列表变了（新增/删除凭证）时重建 */
  setAccounts: (list: QuotaAccount[]) => void
  refresh: (force?: boolean) => void
  dispose: () => void
}

/** 账号列表的稳定指纹。任一影响采集结果的字段变了就该重采 */
export function fingerprint(list: QuotaAccount[]): string {
  return list
    .map((a) => {
      const env = Object.entries(a.env)
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      return `${a.accountId}|${a.provider}|${a.name}|${a.kind ?? ''}|${env}`
    })
    .sort()
    .join('\n')
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
    /* 按量计费的账号如实说"查不到订阅额度"，而不是从 HUD 里消失 ——
       凭证明明在画布上，额度面板里却没有它，用户只会以为坏了。
       各家的按量用量 API 见 docs/QUOTA.md「明确不做」那节（多数要 org admin key）。 */
    if (a.kind === 'api-key') {
      return {
        accountId: a.accountId,
        provider: a.provider,
        name: a.name,
        state: 'unavailable',
        capturedAt: now(),
        source: '-',
        windows: [],
        hint: 'API key 按量计费，没有订阅额度可查'
      }
    }
    try {
      if (a.provider === 'codex') {
        return await collectCodex({
          accountId: a.accountId,
          name: a.name,
          codexHome: a.env['CODEX_HOME'] || `${homeDir}/.codex`,
          homeDir
        })
      }
      if (a.provider === 'copilot') {
        return await collectCopilot({ accountId: a.accountId, name: a.name })
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
      /* 指纹要含 provider / 名字 / 隔离目录 —— 只比 accountId 的话，
         把凭证的 CODEX_HOME 改到另一个订阅号上，界面会继续显示旧号的额度，
         而 accountId 一个字都没变。改名同理（名字就画在 HUD 上）。 */
      const changed = fingerprint(list) !== fingerprint(accounts)
      accounts = list
      if (changed) void run(true)
    },
    refresh: (force) => void run(force),
    dispose: () => clearInterval(timer)
  }
}
