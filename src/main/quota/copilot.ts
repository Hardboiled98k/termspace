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
import { now, type AccountQuota, type QuotaWindow } from './types'

interface Snapshot {
  quota_id?: string
  percent_remaining?: number
  quota_remaining?: number
  entitlement?: number
  unlimited?: boolean
  overage_count?: number
}

const BUCKET_LABEL: Record<string, string> = {
  chat: '对话',
  completions: '补全',
  premium_interactions: '高级请求'
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
    quota_snapshots?: Record<string, Snapshot>
  }
  try {
    const res = await fetch('https://api.github.com/copilot_internal/user', {
      headers: { authorization: `token ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    // 没订阅 Copilot 的账号会 403/404 —— 那是"没有"，不是"出错"
    if (res.status === 403 || res.status === 404) {
      return { ...base, state: 'unconfigured', source: '-', hint: '这个 GitHub 账号没有 Copilot' }
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

  const resetsAt = body.quota_reset_date
    ? Math.floor(Date.parse(`${body.quota_reset_date}T00:00:00Z`) / 1000)
    : undefined

  const windows: QuotaWindow[] = []
  for (const [key, s] of Object.entries(snaps)) {
    /* entitlement 为 0 = **这个套餐根本不含这项**，不是"用完了"。
       本机实测 free_limited_copilot 的 premium_interactions 就是
       entitlement:0 + percent_remaining:0 —— 照直画出来是个假的"额度耗尽"警报。 */
    if (!s.unlimited && !s.entitlement) continue
    if (typeof s.percent_remaining !== 'number') continue
    windows.push({
      id: `${args.accountId}:${key}`,
      label: BUCKET_LABEL[key] ?? key,
      usedPercent: 100 - s.percent_remaining,
      resetsAt,
      // Copilot 是月配额，给个月长度让窗口语义有据可依
      windowMinutes: 43_200,
      unlimited: s.unlimited === true
    })
  }

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
