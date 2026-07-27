/**
 * Claude 订阅额度采集器。
 *
 * 主路径是官方的 `/api/oauth/usage`，OAuth token 从钥匙串取。
 *
 * 两条硬规矩：
 * 1. **拿不到 token 就绝不发请求。** 匿名请求返回的是 429 + `retry-after: 1460`
 *    （IP 级封 24 分钟），不是 401 —— 试一下的代价是接下来 24 分钟全查不了。
 * 2. **用 `execFile('/usr/bin/security')`，不要用 keytar 之类的原生绑定。**
 *    那条钥匙串记录的 ACL 信任的是 `security` 这个二进制本身（Claude Code 自己就是
 *    shell out 过去的），走原生 Security framework 会弹授权框。
 *
 * 也**不做 refresh_token** —— 会和 Claude Code 抢写钥匙串。401 就如实报"登录过期"。
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { now, type AccountQuota, type QuotaWindow } from './types.ts'

const KEYCHAIN_SERVICE = 'Claude Code-credentials'

function keychainToken(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', process.env['USER'] ?? '', '-w'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve('')
        try {
          const j = JSON.parse(stdout) as { claudeAiOauth?: { accessToken?: string } }
          resolve(j.claudeAiOauth?.accessToken ?? '')
        } catch {
          resolve('')
        }
      }
    )
  })
}

interface UsageLimit {
  kind?: string
  group?: string
  percent?: number
  severity?: string
  resets_at?: string | null
  scope?: { model?: { display_name?: string } | null } | null
}

/** limits[] 的 kind → 人能读的标签。认不出的 kind **整条跳过**，不猜也不崩 */
const KIND_LABEL: Record<string, string> = {
  session: '5h',
  weekly_all: '周',
  weekly_scoped: '周·按模型'
}

async function fetchUsage(token: string): Promise<{ ok: boolean; body?: unknown; err?: string }> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status === 401) return { ok: false, err: '登录已过期 —— 在任一终端跑一下 claude 即可刷新' }
    if (res.status === 429) return { ok: false, err: '被限流了，稍后自动重试' }
    if (!res.ok) return { ok: false, err: `HTTP ${res.status}` }
    return { ok: true, body: await res.json() }
  } catch (e) {
    return { ok: false, err: `拿不到：${(e as Error).message}` }
  }
}

export async function collectClaude(args: {
  accountId: string
  name: string
  /** 非默认的 CLAUDE_CONFIG_DIR。有值 = 这是个隔离账号，钥匙串里那把 token 不是它的 */
  configDir?: string
  homeDir: string
}): Promise<AccountQuota> {
  const base = {
    accountId: args.accountId,
    provider: 'claude',
    name: args.name,
    capturedAt: now(),
    windows: [] as QuotaWindow[]
  }

  /* 隔离账号查不了：钥匙串里只有默认登录态那一把 token，
     拿它去查会得到**另一个账号**的额度 —— 那比查不到糟得多。 */
  if (args.configDir) {
    return {
      ...base,
      state: 'unavailable',
      source: '-',
      hint: '隔离的 Claude 账号查不到额度（钥匙串里只有默认登录态那把 token）'
    }
  }

  const token = await keychainToken()
  if (!token) {
    // 见文件头：没 token 绝不发请求
    return { ...base, state: 'unconfigured', source: '-', hint: '钥匙串里没有 Claude 登录态' }
  }

  const r = await fetchUsage(token)
  if (r.ok) {
    const b = (r.body ?? {}) as { limits?: UsageLimit[]; spend?: Record<string, unknown> }
    const windows: QuotaWindow[] = []
    for (const [i, l] of (b.limits ?? []).entries()) {
      const label = l.kind ? KIND_LABEL[l.kind] : undefined
      if (!label || typeof l.percent !== 'number') continue // 认不出就跳过，不猜
      windows.push({
        id: `${args.accountId}:${l.kind}:${i}`,
        label,
        usedPercent: l.percent,
        windowMinutes: l.kind === 'session' ? 300 : 10080,
        resetsAt: l.resets_at ? Math.floor(Date.parse(l.resets_at) / 1000) : undefined,
        severity: (l.severity as QuotaWindow['severity']) ?? undefined,
        scopeModel: l.scope?.model?.display_name ?? undefined
      })
    }
    const sp = b.spend as
      | {
          used?: { amount_minor?: number; currency?: string }
          limit?: { amount_minor?: number }
          enabled?: boolean
        }
      | undefined
    return {
      ...base,
      state: windows.length ? 'ok' : 'unknown-shape',
      /* 如实标注：这是 Claude Code 客户端自己用的内部 OAuth 端点（`/usage` 背后就是它），
         **不是公开文档化的 API**。写"官方 API"会让人以为有稳定性承诺。 */
      source: 'Claude Code 内部 OAuth 端点（未文档化）',
      windows,
      hint: windows.length ? undefined : '返回里没有认识的限额字段',
      spend: sp
        ? [
            {
              label: '超额信用',
              usedMinor: sp.used?.amount_minor,
              limitMinor: sp.limit?.amount_minor,
              // 币种跟上游走，别硬编码 USD（这个账号在哪个区结算不由我们决定）
              currency: sp.used?.currency ?? 'USD',
              // false 要显示成「未开启」，不是 0
              enabled: sp.enabled ?? false
            }
          ]
        : undefined
    }
  }

  /* 兜底：本机那份快照。**只在主路径失败时用**，且一定标成 stale ——
     它由 Claude Code 渲染状态栏时写入，没有 Claude 在跑就会冻住，
     实测同一时刻能和真值差 30 多个百分点。 */
  try {
    const raw = JSON.parse(
      await readFile(path.join(args.homeDir, '.claude', 'claude-usage.json'), 'utf8')
    ) as {
      five_hour?: { used_percentage: number; resets_at: number }
      seven_day?: { used_percentage: number; resets_at: number }
      _captured_at?: number
    }
    const windows: QuotaWindow[] = []
    if (raw.five_hour) {
      windows.push({
        id: `${args.accountId}:fallback:5h`,
        label: '5h',
        usedPercent: raw.five_hour.used_percentage,
        windowMinutes: 300,
        resetsAt: raw.five_hour.resets_at
      })
    }
    if (raw.seven_day) {
      windows.push({
        id: `${args.accountId}:fallback:7d`,
        label: '周',
        usedPercent: raw.seven_day.used_percentage,
        windowMinutes: 10080,
        resetsAt: raw.seven_day.resets_at
      })
    }
    if (windows.length) {
      return {
        ...base,
        state: 'stale',
        capturedAt: raw._captured_at ? Math.floor(raw._captured_at) : now(),
        source: '本机快照（非官方，可能很旧）',
        windows,
        hint: r.err
      }
    }
  } catch {
    // 没有兜底文件
  }
  return { ...base, state: 'unavailable', source: '-', hint: r.err }
}
