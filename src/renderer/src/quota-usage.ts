/**
 * 一个账号在画布上被几个终端用着。
 *
 * 判据有三个来源，**顺序不能乱**：
 *   1. 节点显式绑了凭证（`identityId`）→ 就是那个账号，不再看别的
 *   2. hook 事件报的"此刻真跑在里面的 agent"（`liveAgents`）
 *   3. 节点建出来时定的 `provider`
 *
 * 为什么需要 (2)：用户经常先开一个普通 zsh、再手敲 `claude` —— 那种节点
 * `provider` 是空，而他正在烧那个账号的额度。只看 (3) 就把它整个藏起来了，
 * 等于账单不吭声。
 *
 * 为什么不能用前台进程名来推：**实测过，不可用** ——
 * claude 报的是版本号 `2.1.220`、codex 报 `Python`、gemini 报 `node`。
 * hook 事件是"真有 agent 在跑"的唯一可靠信号。
 *
 * 已知缺口（**故意留着，别用猜的去补**）：普通 zsh 里手敲 `codex` 不会上报 ——
 * codex 的 hook 只装在 provider=codex 那种节点的 CODEX_HOME 里。
 */
export interface UsageNode {
  id: string
  identityId?: string
  provider?: string
}

export function countUsing(
  nodes: UsageNode[],
  accountId: string,
  liveAgents: Record<string, string>
): number {
  return nodes.filter((n) => {
    if (n.identityId) return n.identityId === accountId
    const p = liveAgents[n.id] ?? n.provider
    return !!p && accountId === `system:${p}`
  }).length
}
