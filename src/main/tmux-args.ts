/**
 * tmux 启动参数拼装（纯函数）。
 *
 * 单独成文件是为了可测：tmux.ts 依赖 electron，进不了 `node --test`，
 * 而"identity 的变量到底有没有真的传进会话"正是会静默失败的那一类 ——
 * 界面上凭证配得好好的，开着 tmux 就是不生效，从表面完全看不出来。
 */

export const TMUX_SOCKET = 'termboard'

/** 该节点 identity 显式声明的变量：keys = 要设的，unset = 要删的 */
export interface IdentityEnvSpec {
  keys: string[]
  unset: string[]
}

/**
 * 交给 tmux **客户端进程**的环境。
 *
 * ⚠️ 这是多钥匙隔离的命根子，**别把它简化成"直接把 env 传下去"**：
 * tmux server 是长寿共享的，而且**第一个客户端的环境会变成 server 的全局环境**。
 * 于是「凭证 A 的终端先起 → server 带着 A 的私钥活着 → 凭证 B 的终端后起」时，
 * B 的 pane 会从 server 继承到 A 的私钥 —— 两个账号的密钥就串了。
 *
 * 实测（tmux -L leaktest，两个 session）：
 *   A 的客户端环境带 LEAK_A_SECRET → B 里 `new-window` 打印出 `sk-AAAA`
 *   改成客户端干净、身份只走 `-e` → B 里打印 `NONE`，A 自己照常拿得到
 *
 * 注意 tmux 的 `set-environment -u` **盖不住这个** —— 那些变量只在 server 的
 * 全局环境里（`show-environment -g` 看得到、`-t <session>` 看不到），
 * 会话级的 `-u` 对它无效。所以只能从源头拦。
 *
 * unset 的键也要一并从基础环境里删掉：否则本节点虽然用 `env -u` 包住了自己的 shell，
 * 那个键还是会被带进 server，成为后来所有会话的全局继承。
 */
export function tmuxClientEnv(
  env: Record<string, string>,
  identity?: IdentityEnvSpec
): Record<string, string> {
  const out = { ...env }
  for (const k of identity?.keys ?? []) delete out[k]
  for (const k of identity?.unset ?? []) delete out[k]
  // TERMBOARD_* 全部走 -e 下发。留在基础环境里会让 server 记住**第一个节点**的
  // NODE_ID / HOOK_TOKEN，用户在会话里手开一个 window 就会顶着别人的身份上报
  for (const k of Object.keys(out)) if (k.startsWith('TERMBOARD_')) delete out[k]
  return out
}

export function assembleSpawnArgs(
  tmux: string | null,
  session: string,
  conf: string,
  shell: string,
  cwd: string,
  env: Record<string, string>,
  identity?: IdentityEnvSpec
): { file: string; args: string[] } {
  const unset = identity?.unset ?? []
  /* 真 unset 只能靠 `env -u`：tmux 的 `-e KEY=` 只把值设成空串（实测），
     而 tmux server 是长寿共享的，**没给 -e 的变量会继承 server 启动时的环境** ——
     用户 shell 里 export 过的 OPENAI_API_KEY / ANTHROPIC_API_KEY 就是这么漏进
     每个会话的，让 CLI 绕过订阅走按量计费，账单还不吭声。 */
  const stripped = unset.length ? ['/usr/bin/env', ...unset.flatMap((k) => ['-u', k])] : []

  if (!tmux) {
    return stripped.length
      ? { file: stripped[0], args: [...stripped.slice(1), shell, '-l'] }
      : { file: shell, args: ['-l'] }
  }

  const args = ['-L', TMUX_SOCKET, '-f', conf, 'new-session', '-A', '-D']
  /* env 不能靠继承 → -e 显式注入。
     已存在的 session attach 时 -e 被忽略 = 会话保持自己的身份，语义正确。

     转发范围 = identity 显式声明的键 ∪ 几个已知 provider 前缀。
     **不能只按前缀猜**：OPENAI_* 一度不在前缀表里，于是 identity 里写
     `OPENAI_API_KEY=...` 在开着 tmux 时静默不生效。 */
  const explicit = new Set(identity?.keys ?? [])
  const providerPrefix = /^(ANTHROPIC_|CLAUDE_|CODEX_|GEMINI_|OPENAI_)/
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('TERMBOARD_') || k === 'TERM' || k === 'COLORTERM') continue // TERM 由 tmux 管
    if (explicit.has(k) || providerPrefix.test(k)) args.push('-e', `${k}=${v}`)
  }
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('TERMBOARD_')) args.push('-e', `${k}=${v}`)
  }
  args.push('-c', cwd, '-s', session, ...stripped, shell, '-l')
  return { file: tmux, args }
}
