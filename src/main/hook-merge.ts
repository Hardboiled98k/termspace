/**
 * hook 配置的合并/摘除 —— 纯函数，能被 `node --test` 跑到（hooks.ts 依赖 electron 进不来）。
 *
 * 钉的是一个**会伤到用户数据**的行为：安装时若整组过滤，
 * 用户放在同一个 matcher group 里的格式化 / 审计 / 安全 hook 会被一起删掉。
 * 卸载那边本来就是逐条摘的，安装这边一度不是 —— 两处判据不一致，改一处漏一处。
 */

export interface HookGroup {
  matcher?: string
  hooks?: { type?: string; command?: string }[]
}

/** settings.json 里识别我方条目的标记（含于托管脚本路径） */
export const MARKER = 'termboard'

export const isOurs = (cmd: unknown): boolean => typeof cmd === 'string' && cmd.includes(MARKER)

/**
 * 逐 handler 摘掉我方条目，保留同组里用户自己的 handler。
 *
 * 空组原样留着 —— 那是用户的结构，我们没有理由替他清理。
 */
export function stripOurHandlers(arr: HookGroup[]): HookGroup[] {
  const kept: HookGroup[] = []
  for (const g of arr) {
    if (!g.hooks?.length) {
      kept.push(g)
      continue
    }
    const rest = g.hooks.filter((h) => !isOurs(h.command))
    if (rest.length) kept.push({ ...g, hooks: rest })
  }
  return kept
}
