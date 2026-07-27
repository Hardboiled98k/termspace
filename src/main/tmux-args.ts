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

/**
 * 这个键的值是不是密钥。
 *
 * 密钥**不能走 `tmux -e`** —— 那会把值原样写进 tmux 客户端的 argv，
 * 而客户端进程和终端同寿。实测 `ps -Ao args` 全程看得到，同机其他用户也读得到
 * （macOS 不像 Linux 有 hidepid）。
 *
 * 路径类（CODEX_HOME / CLAUDE_CONFIG_DIR）不是秘密，照常走 `-e` ——
 * 这样用户在会话里手开 window 也还是同一个账号。
 */
/** POSIX shell 单引号转义 —— 值里有引号/空格/换行时不能拼裸字符串 */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
const shq = shellQuote

export const isSecretEnvKey = (k: string): boolean => /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)

export function assembleSpawnArgs(
  tmux: string | null,
  session: string,
  conf: string,
  shell: string,
  cwd: string,
  env: Record<string, string>,
  identity?: IdentityEnvSpec,
  /** 密钥落盘文件的路径（0600）。会话的 shell 先 source 它再 exec，值不进 argv */
  secretFile?: string
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
    // 密钥不进 argv（见 isSecretEnvKey）；有落盘文件时它们走那条路
    if (secretFile && isSecretEnvKey(k)) continue
    if (explicit.has(k) || providerPrefix.test(k)) args.push('-e', `${k}=${v}`)
  }
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('TERMBOARD_')) continue
    /* **HOOK_TOKEN 绝不进 argv。** 上面那个循环判密钥之前就 `continue` 掉了
       所有 `TERMBOARD_*`，这里再无条件推回去 —— 于是这把 token 整条出现在
       `ps -Ao args` 里，同机任何用户都读得到。而它能伪造该节点的 SessionStart，
       **SessionStart 在 delegate 的状态机里先于墓碑、无条件置活**
       （所以它才按 0600 落盘、创建那刻就给权限，见 hooks.ts）。

       这个 `-e` 本来就是冗余的：endpoint 文件会按 `TERMBOARD_NODE_ID`
       从 token 目录**现读**这把 token，而 hook 脚本和 tb 脚本都是 source 完再用 ——
       跨 app 重启接回老会话时也只有现读这条路管用。删掉它两条脚本路径都不受影响。 */
    if (k === 'TERMBOARD_HOOK_TOKEN') continue
    args.push('-e', `${k}=${v}`)
  }
  args.push('-c', cwd, '-s', session)
  if (secretFile) {
    /* shell 先 source 密钥文件、当场删掉它，再 exec 真正的登录 shell。
       argv 里只有路径，值一个字都不出现。文件是 0600 且用完即删，
       落盘窗口只有几毫秒。 */
    const inner = `. ${shq(secretFile)} 2>/dev/null; rm -f ${shq(secretFile)}; exec ${shq(shell)} -l`
    args.push(...stripped, '/bin/sh', '-c', inner)
  } else {
    args.push(...stripped, shell, '-l')
  }
  return { file: tmux, args }
}
