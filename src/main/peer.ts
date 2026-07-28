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

import { createHash } from 'node:crypto'

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

export const PEER_TIMEOUTS = {
  /** 远端 delegate 自己的等待上限 */
  remoteDelegateMs: 240_000,
  /**
   * 对端 helper 的 curl 上限。
   * 比 delegate 多 30s 是因为 delegate **返回之前还要干活**：
   * 最后一轮 1.5s 轮询 + 等 transcript 落盘 1.2s + 读整个 transcript 文件。
   * 只给几秒余量的话，正常完成的派活会在最后一步被自己人掐断。
   */
  helperMs: 270_000,
  /** 本机等 ssh 的上限。要比 helper 长，留出建连和把回答传回来的时间 */
  sshMs: 300_000,
  /** 发起方 tb 脚本里 curl 的上限。最外层，必须最长 */
  tbMs: 320_000
} as const

/**
 * 超时必须**逐层严格递增**。
 *
 * 反了或者持平，就会出现注释里一直想避免的那个状态：**内层刚注入并完成，
 * 外层已经放弃** —— 用户看到的是"派活失败"，而对面那个 agent 真的开始干活了，
 * 结果没人接得住。原来 helper 和 ssh 都是 260s，正是持平。
 */
/* 断线只能理解成 detach，不是 cancel：注入是不可撤回的。所以也**不自动重试** ——
   重试一次就是把同一个任务往对面那个 agent 里注入两遍。 */
export const TIMEOUT_LADDER = [
  PEER_TIMEOUTS.remoteDelegateMs,
  PEER_TIMEOUTS.helperMs,
  PEER_TIMEOUTS.sshMs,
  PEER_TIMEOUTS.tbMs
] as const

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
# Termspace 跨机派活入口（自动生成，每次启动重写 —— 端口会变）。
# 由对端 ssh 过来执行，任务正文走 stdin。不接受命令行参数。
exec curl -sS -m ${Math.round(PEER_TIMEOUTS.helperMs / 1000)} \\
  -H 'X-Termboard-Peer: ${token}' \\
  -H 'Content-Type: application/json' \\
  --data-binary @- "http://127.0.0.1:${port}/tb/peer"
`
}

/**
 * 幂等键。**必须从内容派生，不能用随机数。**
 *
 * 随机 id 在重试时是另一个值，等于没有幂等。而这里要防的恰恰是重试：
 * 派活超时（或 ssh 断了）之后，任务**其实已经注入进对面那个 agent 了**——
 * 断线只能理解成 detach，不是 cancel。此时人或 agent 再发一次同样的任务，
 * 就是往同一个会话里注入两遍。
 *
 * 用 `source + target + task` 的哈希：同一个人把同一个任务派给同一个终端，
 * 就是同一次派活。
 */
export function peerRequestId(source: string, target: string, task: string): string {
  /* 用 JSON 数组而不是分隔符拼串。两个理由：
     ① 拼串有歧义 —— `"a"+sep+"b c"` 和 `"a b"+sep+"c"` 会撞成同一个 id（用空格
        当分隔符时实测真撞），两次不同的派活会互相拿到对方的结果；
     ② 原来用的是**裸 NUL 字节**，它无歧义但在源码里完全不可见，
        任何一次复制粘贴或编辑器规范化都会把它变成空格，然后 ① 就发生了。 */
  return createHash('sha256')
    .update(JSON.stringify([source, target, task]))
    .digest('hex')
    .slice(0, 32)
}

export interface PeerEntry {
  state: 'running' | 'done'
  result?: string
  at: number
}

/**
 * 短期结果表。**只有"记住 id"是不够的** —— 重试时要能说出上次到底怎么了：
 * 还在跑，还是已经跑完了、结果是什么。只挡不给结果的话，用户只会再试一次。
 *
 * `begin` 必须是**原子登记**：先查后写之间不能有 await，否则两个并发请求
 * 都会看到"没记录"然后都注入 —— 那正是这张表要防的事。
 */
export function createRequestLog(
  ttlMs = 10 * 60_000,
  max = 200
): {
  begin: (id: string, now: number) => PeerEntry | null
  finish: (id: string, result: string, now: number) => void
  /** 派活没跑起来（被拒/出错）时把登记撤掉，否则同一个任务十分钟内都派不出去 */
  abandon: (id: string) => void
  size: () => number
} {
  const log = new Map<string, PeerEntry>()
  /** Map 保序，超量时删最早的 */
  const trim = (): void => {
    while (log.size > max) {
      const first = log.keys().next()
      if (first.done) break
      log.delete(first.value)
    }
  }
  const sweep = (now: number): void => {
    for (const [k, v] of log) if (now - v.at > ttlMs) log.delete(k)
    trim()
  }
  return {
    /** 返回 null = 这是新请求，可以继续；否则返回已有条目，调用方据此回话 */
    begin: (id, now) => {
      sweep(now)
      const hit = log.get(id)
      if (hit) return hit
      log.set(id, { state: 'running', at: now })
      trim() // **插入之后**再修剪：sweep 跑在插入前，只按它算会超出 max 一条
      return null
    },
    finish: (id, result, now) => {
      // 结果时间戳用完成时刻：TTL 从"拿到结果"起算才是用户感知的那十分钟
      log.set(id, { state: 'done', result, at: now })
    },
    abandon: (id) => void log.delete(id),
    size: () => log.size
  }
}

/**
 * 远端 helper 的输入。走 stdin 而不是 argv，理由见 sshArgs。
 *
 * `source` 只用于**展示和日志**（远端画布上会显示"谁派来的"）。
 * 它是调用方自报的，远端不能拿它当权限键 —— 远端的授权靠自己的
 * 「允许跨机派活」开关，不靠这个字符串。
 *
 * 两种操作共用这一条通道：
 * - `ask`    派活
 * - `agents` 列对端画布上的 agent 终端（**只读**）—— 没有它就没法知道 target 该填什么，
 *            对端的节点 id 是随机的（`t-7k3f9a`），只能跑去那台机器的画布上看
 */
export type PeerReq =
  | { op: 'ask'; source: string; target: string; task: string }
  | { op: 'agents'; source: string }

export interface PeerAskPayload {
  source: string
  target: string
  task: string
}

export function encodePeerAsk(p: PeerAskPayload): string {
  return JSON.stringify({ op: 'ask', ...p })
}

export function encodePeerAgents(source: string): string {
  return JSON.stringify({ op: 'agents', source })
}

/**
 * 任务正文的字节上限。
 *
 * HTTP body 的 1 MiB 限制**不够当这个用**：整段 task 会被一次 `writeToPty` 打进
 * 目标终端，几百 KB 的输入会堵住 pty、撑爆 agent 的上下文，而链路上还挂着一条
 * 等 4 分钟的同步请求。派活的任务是一段提示词，32 KiB 已经很宽了。
 */
export const TASK_MAX_BYTES = 32 * 1024

/**
 * 远端 helper 解析 stdin。任何不合形状的输入都要拒，别猜。
 *
 * **省略 op 视为 `ask`**：两台机器不会同时升级，改了一边就断另一边不可接受。
 */
export function decodePeerReq(raw: string): PeerReq | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  /* source 只用于显示，但"只用于显示"正是要收敛控制字符的理由：
     它会进 `peer:${source}` 和事件日志，带 ANSI/换行就能在终端和 UI 里伪装成别的行。 */
  const source =
    typeof o.source === 'string' ? o.source.replace(/[^\w.:@-]/g, '').slice(0, 64) : ''

  if (o.op === 'agents') return { op: 'agents', source }
  // 认不出的 op 一律拒 —— 别把一个将来才有的操作当成派活执行了
  if (o.op !== undefined && o.op !== 'ask') return null

  if (typeof o.target !== 'string' || !NODE_RE.test(o.target)) return null
  if (typeof o.task !== 'string' || !o.task.trim()) return null
  // 按**字节**算：中文一个字三字节，按字符数限会让实际长度是三倍
  if (Buffer.byteLength(o.task, 'utf8') > TASK_MAX_BYTES) return null
  return { op: 'ask', source, target: o.target, task: o.task }
}

