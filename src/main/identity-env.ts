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
/**
 * 凭证里**不许出现**的键。
 *
 * 原来的保护只写在 spawn 那侧、而且只挡 `set`：
 *
 *   for (const k of idEnv.unset) delete env[k]          // ← 没挡
 *   for (const [k, v] of Object.entries(idEnv.set)) {
 *     if (k.startsWith('TERMBOARD_')) continue          // ← 只挡了这边
 *
 * 而 `KEY=`（空值）走的正是 unset 那条路。于是一个写着 `TERMBOARD_HOOK_TOKEN=`
 * 的凭证能**把那个节点的状态上报、审批、`tb` 路由全部弄哑**，界面上完全看不出来；
 * `PATH=` 则直接废掉 shell。
 *
 * 所以堵在这个唯一收口：set 和 unset 一起挡，凭证存进来和取出去都过这里。
 */
const RESERVED = /^(TERMBOARD_|PATH$|TMUX$|TMUX_PANE$|TERM$|SHELL$|HOME$)/

/** 这个键能不能出现在凭证里 */
export const isReservedEnvKey = (k: string): boolean => RESERVED.test(k)

/**
 * 把一个 identity 的 env 包应用到基础环境上。**set 和 unset 必须一起用**。
 *
 * 单独抽出来是因为原先三处各写各的，而少写 unset 的那处会得出相反的结论：
 * 一个订阅型凭证配了 `ANTHROPIC_API_KEY=`（删掉继承来的 key），终端里确实删掉了，
 * 但查登录态那处只用了 `{set}` 再合并完整 `process.env` —— 那把 key 还在，
 * 于是 `claude auth status` 报 `api_key`，界面显示「按量计费」。
 * **和这个终端实际的计费方式正好相反。**
 */
export function applyIdentityEnv(
  base: NodeJS.ProcessEnv,
  resolved: ResolvedEnv | null
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base }
  if (!resolved) return out
  for (const k of resolved.unset) delete out[k]
  for (const [k, v] of Object.entries(resolved.set)) out[k] = v
  return out
}

export function materializeEnv(raw: Record<string, string>, home: string): ResolvedEnv {
  const set: Record<string, string> = {}
  const unset: string[] = []
  for (const [k, v] of Object.entries(raw)) {
    // 保留键一律丢弃：删掉它们等于让这个节点静默失能
    if (isReservedEnvKey(k)) continue
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

/**
 * 这个账号实际按什么计费。
 *
 * **判据只有一条：最终生效的环境里有没有 API key。** 有就是按量 —— CLI 见到
 * `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 就走它，`CODEX_HOME` 里躺着哪个订阅号
 * 完全不影响这个事实。
 *
 * 原来两处各写各的、判据还不一样：
 * - 登录态用 `有 API key && 没有隔离目录` → 两样都配的凭证会去查那个目录，
 *   把里面另一个订阅号的「已登录」显示在这个凭证名下
 * - 额度用 `有隔离目录 ? 订阅 : 按量` → 同样的凭证会去拉那个订阅号的额度百分比
 *
 * 于是用户看到"已登录、还剩 70%"，而每一次调用都在出账单。两处必须共用这一个函数。
 *
 * 传 `probeEnv` 而不是 identity 自己的 `set`：**用户 shell 里 export 的 key 会被
 * app 继承下去**，那也是真的会生效；identity 用 `KEY=` 显式删掉的则已经不在里面了。
 */
export function billingKind(
  probeEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  provider: string
): 'api-key' | 'subscription' {
  const key = provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
  return probeEnv[key] ? 'api-key' : 'subscription'
}
