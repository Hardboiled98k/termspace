/**
 * identity env 包 → 可直接用的环境变量。
 *
 * 单独成文件是为了可测：identity-store.ts 依赖 electron（Keychain 加密），
 * 跑不进 `node --test`，而这段展开规则决定了「同一台机器上两个订阅账号」
 * 到底成不成立，必须有回归网。
 */

export interface ResolvedEnv {
  set: Record<string, string>
  /** 要从继承环境里**删掉**的变量名 */
  unset: string[]
}

/**
 * 两条语义，都是为了「同一台机器上开两个订阅账号」这个场景：
 *
 * 1. **`KEY=`（空值）= 删掉这个变量**，不是设成空串。
 *    订阅账号靠 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 隔离，但如果用户的 shell 里
 *    export 过 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`，它会被 app 继承下去，
 *    CLI 优先走 API key 计费 —— 订阅号白开了，而且账单静悄悄。必须能删掉。
 *
 * 2. **`~/` 和 `$HOME/` 要展开**。env 值不过 shell，写 `CODEX_HOME=~/.codex-b`
 *    的话 codex 会老老实实在当前目录建一个名叫 `~` 的文件夹。
 */
export function materializeEnv(raw: Record<string, string>, home: string): ResolvedEnv {
  const set: Record<string, string> = {}
  const unset: string[] = []
  for (const [k, v] of Object.entries(raw)) {
    if (v === '') {
      unset.push(k)
      continue
    }
    set[k] = v.startsWith('~/')
      ? `${home}/${v.slice(2)}`
      : v.startsWith('$HOME/')
        ? `${home}/${v.slice(6)}`
        : v
  }
  return { set, unset }
}
