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
