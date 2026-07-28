/**
 * 额度面板里一个账号该不该显示。
 *
 * **抽出来是因为这条判据曾经写在两个地方**（AccountBlock 内一份、外层 filter 一份），
 * 注释还写着"两处保持一致" —— 那种一致靠人记，改一处漏一处只是时间问题。
 */

export interface VisibilityInput {
  /** 账号 id。`system:` 前缀 = app 自动探测的本机登录态，不是用户建的凭证 */
  accountId: string
  /** 画布上有几个终端在用这个号 */
  usingCount: number
}

/**
 * 判据只有一条：**自动探测的系统号，画布上没人用就不显示。**
 *
 * 为什么不看登录状态：用户的 codex / copilot 在系统层面是登录着的，
 * 于是"已登录 + 有真数据"，旧规则（只藏 `unconfigured`）就一直显示它们 ——
 * 而用户根本没在画布上开这个 agent。他不关心一个自己没在用的额度，
 * 那是噪音，还会把真正在用的那个挤下去。
 *
 * **用户自己建的凭证永远显示**，哪怕未登录、哪怕没人用：
 * 那是他显式创建的东西，藏起来等于"我建的号凭空消失了"。
 * 「未登录」这个状态必须在界面上存在 —— 它是可以自己修的（去跑一次 login），
 * 和"查不到"完全不同。
 */
export function shouldShowAccount({ accountId, usingCount }: VisibilityInput): boolean {
  const autoDetected = accountId.startsWith('system:')
  if (!autoDetected) return true
  return usingCount > 0
}
