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

export interface LoginStatus {
  state: 'in' | 'out' | 'unknown'
  detail: string
  /** 这个号的隔离目录，给界面显示"它存在哪" */
  home?: string
}

/** 未登录的说法（codex 0.145 实测是 `Not logged in`；另外几种是防它改文案） */
const OUT = /\b(not logged in|logged out|no (stored )?credentials|please (run )?(codex )?login)\b/i
/** 已登录：必须**先排除**上面那些否定式再判 */
const IN = /\b(logged in|authenticated as|signed in)\b/i

export function parseCodexLogin(out: string, home?: string): LoginStatus {
  const text = out.trim()
  if (!text) return { state: 'unknown', detail: '查不出来', home }
  // 否定优先。反过来的话 "Not logged in" 会被 IN 命中
  if (OUT.test(text)) {
    return { state: 'out', detail: '未登录 —— 在连着的终端里跑一次 codex login', home }
  }
  if (IN.test(text)) return { state: 'in', detail: text.slice(0, 80), home }
  // 认不出的输出如实报 unknown，**不猜**（猜"已登录"会让用户白等一个不存在的号）
  return { state: 'unknown', detail: text.slice(0, 80), home }
}
