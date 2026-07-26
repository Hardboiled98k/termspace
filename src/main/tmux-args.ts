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
