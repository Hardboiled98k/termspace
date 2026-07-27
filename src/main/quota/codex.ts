/**
 * Codex 订阅额度采集器。
 *
 * 走官方的 app-server（JSON-RPC over stdio），不碰 chatgpt.com 的私有 backend-api ——
 * 那些端点没有公开文档、随 codex 更新变、且 token 过期后变成静默 401，
 * 正是这个项目最怕的失败形态。app-server 就是官方封装，用它。
 *
 * 实测（本机 codex 0.145）：
 *   initialize 632ms（纯本地握手）→ account/rateLimits/read 约 3.4s（走网络）
 *   **不消耗任何推理额度**，就是一次账号查询
 *   未登录时明确返回 -32600，不静默
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { now, windowLabel, type AccountQuota, type QuotaWindow } from './types'

/**
 * 找 codex 可执行文件。
 *
 * **这是最大的落地坑**：codex 装在 `~/.npm-global/bin`，而 Electron 从 Finder 启动时
 * 不继承登录 shell 的 PATH —— 直接 `spawn('codex')` 必 ENOENT，
 * 会把"装了 codex 的用户"显示成"未安装"。所以只走绝对路径。
 */
export function findCodexBin(home: string): string | null {
  const vendor = path.join(
    home,
    '.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
  )
  return (
    [
      vendor, // 直指真二进制，省一层 node 启动
      path.join(home, '.npm-global/bin/codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(home, '.local/bin/codex')
    ].find(existsSync) ?? null
  )
}

interface RateSnapshot {
  limitId?: string
  limitName?: string | null
  primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null
  secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string } | null
  planType?: string | null
}

/** 一次性起 app-server、问一句、关掉。常驻进程 RSS 60MB，5 分钟一次不值当常驻 */
function askRateLimits(
  bin: string,
  codexHome: string
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, CODEX_HOME: codexHome }
    })
    let buf = ''
    let settled = false
    const finish = (r: { ok: true; data: Record<string, unknown> } | { ok: false; error: string }): void => {
      if (settled) return
      settled = true
      try {
        p.kill()
      } catch {
        // 已退出
      }
      resolve(r)
    }
    /* 硬超时：实测未登录时 rateLimits/read 会**静默挂 25s 不返回**。
       没有这道闸，采集器会把自己吊死在那儿。 */
    const timer = setTimeout(() => finish({ ok: false, error: '查询超时' }), 15_000)

    p.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, error: `起不来：${e.message}` })
    })
    p.on('exit', () => {
      clearTimeout(timer)
      // 服务端对畸形请求会**静默退出**（一行错都不报），所以 exit 本身就是一种错误信号
      finish({ ok: false, error: 'app-server 提前退出' })
    })

    p.stdout.on('data', (d) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let m: { id?: number; result?: unknown; error?: { message?: string } }
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        // 按 id 派发，**不能按到达顺序配对**（实测后发的会先回）
        if (m.id === 1) {
          p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`)
          p.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null })}\n`
          )
        } else if (m.id === 2) {
          clearTimeout(timer)
          if (m.error) finish({ ok: false, error: m.error.message ?? 'unknown' })
          else finish({ ok: true, data: (m.result ?? {}) as Record<string, unknown> })
        }
      }
    })

    p.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        // params 的形状错了服务端会静默退出，别随手改
        params: { clientInfo: { name: 'termscape', title: null, version: '0.1.0' }, capabilities: null }
      })}\n`
    )
  })
}

function toWindows(snap: RateSnapshot, prefix: string): QuotaWindow[] {
  const out: QuotaWindow[] = []
  for (const [key, w] of [
    ['primary', snap.primary],
    ['secondary', snap.secondary]
  ] as const) {
    if (!w || typeof w.usedPercent !== 'number') continue
    // windowDurationMins 缺失 → 认不出语义，这一行隐藏，绝不显示成 0
    if (!w.windowDurationMins) continue
    out.push({
      id: `${prefix}:${key}`,
      label: windowLabel(w.windowDurationMins),
      usedPercent: w.usedPercent,
      windowMinutes: w.windowDurationMins,
      resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : undefined,
      scopeModel: snap.limitName ?? undefined
    })
  }
  return out
}

export async function collectCodex(args: {
  accountId: string
  name: string
  codexHome: string
  homeDir: string
}): Promise<AccountQuota> {
  const base = {
    accountId: args.accountId,
    provider: 'codex',
    name: args.name,
    capturedAt: now(),
    windows: [] as QuotaWindow[]
  }
  const bin = findCodexBin(args.homeDir)
  if (!bin) {
    return { ...base, state: 'unconfigured', source: '-', hint: '本机没找到 codex' }
  }
  const r = await askRateLimits(bin, args.codexHome)
  if (!r.ok) {
    const notLoggedIn = /authentication required|not logged in/i.test(r.error)
    return {
      ...base,
      state: notLoggedIn ? 'unconfigured' : 'unavailable',
      source: 'codex app-server',
      hint: notLoggedIn ? `未登录 —— 在用这个账号的终端里跑一次 codex login` : r.error
    }
  }

  const main = r.data['rateLimits'] as RateSnapshot | undefined
  const byId = (r.data['rateLimitsByLimitId'] ?? {}) as Record<string, RateSnapshot>
  if (!main?.primary) {
    return {
      ...base,
      state: 'unknown-shape',
      source: 'codex app-server',
      hint: 'codex 返回的字段不认识（它升级了？）'
    }
  }

  const windows = toWindows(main, `${args.accountId}:main`)
  // 按模型细分的桶（GPT-5.3-Codex-Spark 之类）。主桶已经在上面了，跳过重复
  for (const [id, snap] of Object.entries(byId)) {
    if (id === main.limitId) continue
    windows.push(...toWindows(snap, `${args.accountId}:${id}`))
  }

  const spend =
    main.credits && (main.credits.hasCredits || main.credits.unlimited)
      ? [
          {
            label: '额度信用',
            usedMinor: 0,
            currency: 'USD',
            enabled: true,
            limitMinor: Number(main.credits.balance ?? 0) * 100
          }
        ]
      : undefined

  return {
    ...base,
    state: 'ok',
    source: 'codex app-server（官方）',
    plan: main.planType ?? undefined,
    windows,
    spend
  }
}
