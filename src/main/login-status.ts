/**
 * `codex login status` 的输出解析。
 *
 * 单独成文件是为了能被 `node --test` 覆盖 —— identity-store.ts 依赖 electron 进不去，
 * 而这几行正是**已经出过事**的地方：原来写的是
 *
 *   if (/Logged in/i.test(out)) return 'in'
 *   if (/Not logged in/i.test(out)) return 'out'
 *
 * `/Logged in/i` 命中 "Not logged in"（"Not **logged in**" 里就有这个子串），
 * 于是**每一个未登录的号都显示成「已登录」**。而节点上显示登录态的唯一意义，
 * 就是防止用户以为"拉了线就等于登录了"—— 判反了比不显示更糟。
 */

import { maskEmail, maskEmailsInText } from '../shared/mask.ts'
export interface LoginStatus {
  state: 'in' | 'out' | 'unknown'
  detail: string
  /** 这个号的隔离目录，给界面显示"它存在哪" */
  home?: string
  email?: string
  plan?: string
  authMethod?: string
}

/** 未登录的说法（codex 0.145 实测是 `Not logged in`；另外几种是防它改文案） */
const OUT = /\b(not logged in|logged out|no (stored )?credentials|please (run )?(codex )?login)\b/i
/** 已登录：必须**先排除**上面那些否定式再判 */
const IN = /\b(logged in|authenticated as|signed in)\b/i

/**
 * `claude auth status --json` 的输出。
 *
 * **这个命令是存在的** —— 项目里一度写着"Claude 没有等价命令（穷举过 --help）"，
 * 是错的（codex 审查指出后实测：本机 claude 2.1.220 直接返回下面这个 JSON）。
 * 它比 codex 那边给得还多：邮箱能区分两个订阅号，subscriptionType 能看出 max/pro。
 */
export interface ClaudeAuth {
  loggedIn?: boolean
  authMethod?: string
  email?: string
  subscriptionType?: string
}

export function parseClaudeAuth(stdout: string, home?: string): LoginStatus {
  let j: ClaudeAuth
  try {
    const v: unknown = JSON.parse(stdout)
    /* `JSON.parse` 对合法 JSON 的 `null` / 数字 / 字符串都成功。
       `null` 会让下面读 `.loggedIn` 直接抛（整个 IPC handler 变成 reject）；
       数字则读出 undefined → 被判成「未登录」，而它其实是「没看懂」。
       两种都必须落到 unknown。 */
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { state: 'unknown', detail: maskEmailsInText(stdout.trim()).slice(0, 80) || '查不出来', home }
    }
    j = v as ClaudeAuth
  } catch {
    // 认不出就 unknown，**不猜**（命令换形状了也不能编一个登录态出来）
    return { state: 'unknown', detail: maskEmailsInText(stdout.trim()).slice(0, 80) || '查不出来', home }
  }
  if (j.loggedIn !== true) {
    return { state: 'out', detail: '未登录 —— 在连着的终端里跑一次 claude 登录', home }
  }
  /* authMethod 要显示出来：`api_key` 意味着这个终端**走按量计费**，不是订阅额度。
     两者在界面上长得一样但账单完全不同 —— 这正是 identity 里那条
     "用户 shell export 的 ANTHROPIC_API_KEY 会让订阅号白开"的坑。 */
  /* **邮箱拼进给人看的字符串之前必须先脱敏**（`email` 字段本身仍返回原值，
     那是给程序区分两个同 provider 订阅号用的）。实测过的反例：
     额度卡上「a***@…」和「max · abc123xyz@…」并列，一个脱敏一个明文。 */
  const bits = [
    j.subscriptionType ?? j.authMethod ?? '已登录',
    j.email ? maskEmail(j.email) : undefined,
    j.authMethod === 'api_key' ? '按量计费（非订阅）' : undefined
  ].filter(Boolean)
  return {
    state: 'in',
    detail: bits.join(' · ').slice(0, 80),
    home,
    email: j.email,
    plan: j.subscriptionType,
    authMethod: j.authMethod
  }
}

export function parseCodexLogin(out: string, home?: string): LoginStatus {
  const text = out.trim()
  if (!text) return { state: 'unknown', detail: '查不出来', home }
  // 否定优先。反过来的话 "Not logged in" 会被 IN 命中
  if (OUT.test(text)) {
    return { state: 'out', detail: '未登录 —— 在连着的终端里跑一次 codex login', home }
  }
  if (IN.test(text)) return { state: 'in', detail: maskEmailsInText(text).slice(0, 80), home }
  // 认不出的输出如实报 unknown，**不猜**（猜"已登录"会让用户白等一个不存在的号）
  return { state: 'unknown', detail: maskEmailsInText(text).slice(0, 80), home }
}
