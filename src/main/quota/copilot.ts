/**
 * GitHub Copilot 额度采集器。
 *
 * `GET https://api.github.com/copilot_internal/user` 的 `quota_snapshots`。
 * token 优先用 `gh auth token`（用户多半已经登录过 gh），其次环境变量。
 *
 * ⚠️ 这是**未文档化**的内部路径。所以字段一旦不认识就报 unknown-shape，
 * 绝不猜、绝不拿 0 顶上。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { now, type AccountQuota, type QuotaWindow } from './types.ts'

export interface Snapshot {
  quota_id?: string
  percent_remaining?: number
  quota_remaining?: number
  entitlement?: number
  unlimited?: boolean
  overage_count?: number
  /** 上游的显式信号：这个套餐**含不含**这项配额。比按 entitlement 猜可靠 */
  has_quota?: boolean
}

const BUCKET_LABEL: Record<string, string> = {
  chat: '对话',
  completions: '补全',
  premium_interactions: '高级请求'
}

/**
 * 重置时刻 → unix 秒。
 * 优先用上游给的完整时间戳；`quota_reset_date` 是个裸日期（`2026-08-01`），
 * 自己补 `T00:00:00Z` 是在替上游猜时区。解析不出来就 undefined，**不返回 0**
 * （0 会被下游当成 1970 年，画成"早就该重置了"）。
 */
export function resetSeconds(body: { quota_reset_date?: string; quota_reset_date_utc?: string }): number | undefined {
  const raw = body.quota_reset_date_utc ?? (body.quota_reset_date ? `${body.quota_reset_date}T00:00:00Z` : '')
  const t = raw ? Date.parse(raw) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}

/** 配额桶 → 窗口。**认不出的桶整条跳过，绝不拿 0 顶上** */
export function toWindows(
  snaps: Record<string, Snapshot>,
  resetsAt: number | undefined,
  accountId: string
): QuotaWindow[] {
  const out: QuotaWindow[] = []
  for (const [key, s] of Object.entries(snaps)) {
    /* `has_quota:false` = **这个套餐根本不含这项**，不是"用完了"。
       本机实测 free_limited_copilot 的 premium_interactions 就是
       has_quota:false + entitlement:0 + percent_remaining:0 ——
       照直画出来是个假的"额度耗尽"警报。
       has_quota 是上游的显式信号，entitlement 只是没有它时的兜底猜测。 */
    if (s.has_quota === false) continue
    if (s.has_quota === undefined && !s.unlimited && !s.entitlement) continue
    if (typeof s.percent_remaining !== 'number') continue
    out.push({
      id: `${accountId}:${key}`,
      label: BUCKET_LABEL[key] ?? key,
      usedPercent: 100 - s.percent_remaining,
      resetsAt,
      // Copilot 是月配额，给个月长度让窗口语义有据可依
      windowMinutes: 43_200,
      unlimited: s.unlimited === true
    })
  }
  return out
}

function ghToken(): Promise<string> {
  const env = process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN']
  if (env) return Promise.resolve(env)
  const bin = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'].find(existsSync)
  if (!bin) return Promise.resolve('')
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'token'], { timeout: 5000 }, (err, stdout) =>
      resolve(err ? '' : stdout.trim())
    )
  })
}

export async function collectCopilot(args: {
  accountId: string
  name: string
}): Promise<AccountQuota> {
  const base = {
    accountId: args.accountId,
    provider: 'copilot',
    name: args.name,
    capturedAt: now(),
    windows: [] as QuotaWindow[]
  }
  const token = await ghToken()
  if (!token) {
    return { ...base, state: 'unconfigured', source: '-', hint: '没有 GitHub token（跑一下 gh auth login）' }
  }
  let body: {
    copilot_plan?: string
    login?: string
    quota_reset_date?: string
    quota_reset_date_utc?: string
    quota_snapshots?: Record<string, Snapshot>
  }
  try {
    const res = await fetch('https://api.github.com/copilot_internal/user', {
      headers: { authorization: `token ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    // 404 = 这个账号确实没有 Copilot。**403 不是**：token scope 不够、
    // 组织策略挡了、被限流都会 403 —— 一律说成"没订阅"就把可修的问题说成了没有的东西
    if (res.status === 404) {
      return { ...base, state: 'unconfigured', source: '-', hint: '这个 GitHub 账号没有 Copilot' }
    }
    if (res.status === 403) {
      const msg = await res.text().catch(() => '')
      const noSeat = /no (copilot )?(seat|subscription|access)|not.*(entitled|subscribed)/i.test(msg)
      return noSeat
        ? { ...base, state: 'unconfigured', source: '-', hint: '这个 GitHub 账号没有 Copilot' }
        : {
            ...base,
            state: 'unavailable',
            source: 'GitHub API',
            hint: `403 —— 多半是 token 权限不够或组织策略挡了（试 gh auth refresh）`
          }
    }
    if (!res.ok) {
      return { ...base, state: 'unavailable', source: 'GitHub API', hint: `HTTP ${res.status}` }
    }
    body = await res.json()
  } catch (e) {
    return { ...base, state: 'unavailable', source: 'GitHub API', hint: (e as Error).message }
  }

  const snaps = body.quota_snapshots
  if (!snaps || typeof snaps !== 'object') {
    return {
      ...base,
      state: 'unknown-shape',
      source: 'GitHub API（未文档化路径）',
      hint: '返回里没有 quota_snapshots（接口变了？）'
    }
  }

  const windows = toWindows(snaps, resetSeconds(body), args.accountId)

  return {
    ...base,
    state: windows.length ? 'ok' : 'unknown-shape',
    source: 'GitHub API（未文档化路径）',
    plan: body.copilot_plan,
    email: body.login,
    windows,
    hint: windows.length ? undefined : '所有配额桶都不可用（套餐不含？）'
  }
}
