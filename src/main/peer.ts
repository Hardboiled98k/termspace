/**
 * 跨机派活：`tb ask <peer>:<节点> <任务>`。
 *
 * ## 为什么走 SSH 而不是给远程 API 加一条路由
 *
 * 用户单人两台机（MacBook 编程 / Mac mini 生产），本来就有免密 ssh。走 SSH 的话：
 * **不新增任何网络暴露面** —— 两边的 hook server 照旧只绑 127.0.0.1，
 * SSH 隧道进来的请求源地址本身就是 127.0.0.1。而给 `remote.ts` 加
 * `POST /api/delegate` 等于把「往有 Bash 权限的 agent 里注入提示词」这件事
 * 变成一个网络路由 —— 字面上不是 exec，安全语义上是 RCE-by-proxy。
 *
 * 代价是这条路只在「两台机之间已有 SSH 信任」时成立。这正是本功能的适用范围：
 * **同一个人的两台机器**，不是多人协作（多人见 docs/collab-review-codex.md）。
 *
 * ## 诚实说明边界
 *
 * 能 ssh 进那台机的人本来就有完整 shell 权限，所以这里的开关和白名单
 * **不构成安全边界**，和本机那套 per-node token 一样是产品护栏：
 * 挡住误用和 agent 自作主张，挡不住一个已经能登录那台机的人。
 */

/** ssh alias 只允许这些字符。**开头不能是 `-`** —— 见 sshArgs 的注释 */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * alias 格式合法吗。**settings 落盘校验和这里必须用同一个判据** ——
 * 各写一份正则，改一处漏一处，而漏的那一处正好是"手改 settings.json
 * 塞个 `-oProxyCommand=` 进白名单"这条路。
 */
export const isPeerAlias = (s: unknown): s is string =>
  typeof s === 'string' && ALIAS_RE.test(s)
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface PeerTarget {
  alias: string
  nodeId: string
}

/**
 * 拆 `mini:t-abc`。不是跨机形态（不含冒号）返回 null —— 调用方据此走本机原路。
 *
 * 冒号只切第一个：节点 id 的字符集里没有冒号，但万一以后有，
 * 「alias 不含冒号」这条比「nodeId 不含冒号」更可靠。
 */
export function parsePeerTarget(target: string): PeerTarget | null {
  const i = target.indexOf(':')
  if (i < 0) return null
  const alias = target.slice(0, i)
  const nodeId = target.slice(i + 1)
  if (!ALIAS_RE.test(alias) || !NODE_RE.test(nodeId)) return null
  return { alias, nodeId }
}

/**
 * 这个 alias 在不在白名单里。
 *
 * **白名单是必须的，不是加固**：alias 直接进 ssh 的 argv，而
 * `ssh -oProxyCommand=... x` 这种以 `-` 开头的「主机名」会被 ssh 当成选项解析，
 * 等于让调用方在本机执行任意命令。ALIAS_RE 已经挡了开头的 `-`，
 * 白名单是第二道 —— 派活这条链路上，任何一层都可能是最后一层。
 */
export function peerAllowed(alias: string, peers: string[]): boolean {
  if (!ALIAS_RE.test(alias)) return false
  return peers.includes(alias)
}

/**
 * ssh 参数。
 *
 * - `--` 之后才是主机名：即使 ALIAS_RE 有漏，ssh 也不会再把它当选项。
 * - `BatchMode=yes`：没配免密时**立刻失败**而不是挂在密码提示上。
 *   派活是同步等待的，挂住就是把调用方那个 agent 一起挂住。
 * - `ConnectTimeout`：网络不通时同理，要快速失败。
 * - 远端不跑 shell 解析：helper 路径和参数各自独立传，任务正文走 stdin，
 *   **绝不拼进命令行** —— 任务是自由文本，拼进去就是命令注入，
 *   而且 argv 在 `ps` 里对同机所有用户可见。
 */
export function sshArgs(alias: string, helper = PEER_HELPER_REMOTE): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', alias, helper]
}

/**
 * 对端 helper 的路径，**由对端 shell 解析**，所以：
 * - 必须引起来 —— macOS 的 userData 路径里有空格（`Application Support`），
 *   不引的话 ssh 那头会把它当成三个参数，报一个看不懂的 "No such file"。
 * - 用双引号而不是单引号 —— `$HOME` 要在对端展开（两台机的用户名可能不同）。
 *   这是写死的常量，不含任何用户输入，所以双引号里的 `$` 没有注入面。
 */
export const PEER_HELPER_REMOTE = '"$HOME/Library/Application Support/termboard/bin/tb-peer"'

/**
 * 被派活那一侧的入口脚本。对端 ssh 过来直接执行它。
 *
 * 为什么要有这个脚本，而不是让对面自己 curl：
 * hook 端口**每次启动都变**，token 也只存在本机文件里 —— 对面既拿不到也不该拿。
 * 把这两样留在被派活的这一侧，跨机链路上就只传任务本身。
 *
 * - **不收任何命令行参数**：argv 在 `ps` 里对同机所有用户可见，而任务是自由文本。
 * - `--data-binary @-`：原样透传 stdin，不做任何 shell 解析。
 * - `-sS`：静默但保留错误输出，否则 ssh 那头拿到的是一片空白。
 */
export function buildPeerHelper(port: number, token: string): string {
  return `#!/bin/sh
# Termscape 跨机派活入口（自动生成，每次启动重写 —— 端口会变）。
# 由对端 ssh 过来执行，任务正文走 stdin。不接受命令行参数。
exec curl -sS -m ${Math.round(PEER_TIMEOUTS.remoteDelegateMs / 1000) + 20} \\
  -H 'X-Termboard-Peer: ${token}' \\
  -H 'Content-Type: application/json' \\
  --data-binary @- "http://127.0.0.1:${port}/tb/peer"
`
}

/**
 * 远端 helper 的输入。走 stdin 而不是 argv，理由见 sshArgs。
 *
 * `source` 只用于**展示和日志**（远端画布上会显示"谁派来的"）。
 * 它是调用方自报的，远端不能拿它当权限键 —— 远端的授权靠自己的
 * 「允许跨机派活」开关，不靠这个字符串。
 */
export interface PeerAskPayload {
  source: string
  target: string
  task: string
}

export function encodePeerAsk(p: PeerAskPayload): string {
  return JSON.stringify(p)
}

/** 远端 helper 解析 stdin。任何不合形状的输入都要拒，别猜 */
export function decodePeerAsk(raw: string): PeerAskPayload | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.target !== 'string' || !NODE_RE.test(o.target)) return null
  if (typeof o.task !== 'string' || !o.task.trim()) return null
  const source = typeof o.source === 'string' ? o.source.slice(0, 64) : ''
  return { source, target: o.target, task: o.task }
}

/**
 * 跨机的超时分层。**外层必须比内层长**，否则调用方先放弃、远端还在跑，
 * 而任务已经注入进去了 —— 那次派活的结果没人接得住，用户看到的是超时，
 * 实际上目标终端过一会儿真的会开始干活。
 *
 * 断线只能理解成 detach，不是 cancel：注入是不可撤回的。所以也**不自动重试** ——
 * 重试一次就是把同一个任务往那个 agent 里注入两遍。
 */
export const PEER_TIMEOUTS = {
  /** 远端 delegate 自己的等待上限 */
  remoteDelegateMs: 240_000,
  /** 本机等 ssh 的上限，留 20s 给建连和回传 */
  sshMs: 260_000
} as const
