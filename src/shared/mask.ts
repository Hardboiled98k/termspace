/**
 * 邮箱脱敏。**主进程和渲染层必须共用这一份。**
 *
 * 这个仓库已经在同一类问题上栽过两次（审批记录的 `tool_input` 有两条外发路径、
 * 各写一份脱敏于是漏了一条）。判据写死在 CLAUDE.md 里：**脱敏只能有一个出口。**
 *
 * 2026-07-29 实测又撞一次：额度卡片上同一个邮箱出现两遍 ——
 *
 * ```
 * a***@privaterelay.appleid.com                 ← 渲染层 maskEmail 过的
 * max · abc123xyz@privaterelay.appleid.com     ← presence.detail，主进程拼的，明文
 * ```
 *
 * 主进程侧的 `parseClaudeAuth` 把 `email` 直接拼进了展示字符串，而渲染层的
 * `maskEmail` 只管另一个字段。所以脱敏不能留在渲染层 —— 它必须在
 * **任何一处把邮箱拼进给人看的字符串之前**就发生。
 */

/** `alice@example.com` → `a***@example.com`；认不出邮箱形状就整个打掉 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}

/**
 * 把一段**自由文本**里的邮箱全部脱敏。
 *
 * 光有 `maskEmail` 不够 —— 还有第三条路径：CLI 的**原始输出**被整段当成
 * 展示文案。实测：`parseCodexLogin('Authenticated as alice@example.com')`
 * 把整行放进 `detail`，凭证节点的 tooltip 直接显示；Claude 那边认不出的输出
 * 也会原样回显前 80 字符。
 *
 * 判据仍是那一条：**谁把外部文本拿去给人看，谁就得先过这里。**
 */
export function maskEmailsInText(text: string): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m))
}
