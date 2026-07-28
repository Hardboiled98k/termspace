/**
 * 外部工作区文件的净化。
 *
 * **导入曾经是一个没标注的命令执行入口**：SavedNode 里带 `command`，
 * 而终端节点第一次起会话时会把 `command` 直接写进登录 shell（index.ts 的 fresh 分支）。
 * 于是"打开别人发来的画布"= 重启后自动执行文件里写的任意命令，
 * 而确认框只说了"会替换画布 / 会结束孤儿会话"，一个字没提执行。
 *
 * 用户确实是自己选的文件，但**选择打开 ≠ 同意执行里面的命令**。
 * Zellij 对远程 layout 里的命令就是这么处理的：铺出来，停在那儿，人按一下才跑。
 *
 * 本机自己的 `workspace.json`**不走这里** —— 那是用户自己敲的命令，
 * 信任级别不同。两条路必须分开，别为了"统一"把本机恢复也阉了。
 */

/** 与 board-serde 的 SAVED_TYPES 对齐。**不认识的类型必须丢掉**，
    因为 fromSaved 的兜底分支是 terminal —— 未知类型会变成一个真的会 spawn 的终端 */
const KNOWN_TYPES = new Set(['terminal', 'group', 'context', 'browser', 'credential'])

export interface SanitizeResult {
  ws: Record<string, unknown>
  /** 被摘掉启动命令的节点数（要在确认框里说给用户听） */
  commands: number
  /** 被摘掉凭证绑定的节点数 */
  identities: number
  /** 类型不认识、被整个丢掉的节点数 */
  dropped: number
}

function sanitizeNodes(raw: unknown, r: SanitizeResult): unknown {
  if (!Array.isArray(raw)) return raw
  const out: unknown[] = []
  for (const n of raw) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      r.dropped++
      continue
    }
    const node = { ...(n as Record<string, unknown>) }
    // type 缺失 = v1 老文件的终端，合法；给了但不认识 = 丢
    if (node.type !== undefined && !KNOWN_TYPES.has(String(node.type))) {
      r.dropped++
      continue
    }
    if (typeof node.command === 'string' && node.command.trim()) {
      delete node.command
      r.commands++
    } else {
      delete node.command
    }
    /* identityId 指向的是**本机**的凭证。留着它，别人发来的画布会静默绑上你的账号
       （还会按那个账号计费）。跨机它本来也没有意义 —— 导入方的凭证 id 对不上。 */
    if (typeof node.identityId === 'string' && node.identityId) {
      delete node.identityId
      r.identities++
    } else {
      delete node.identityId
    }
    out.push(node)
  }
  return out
}

/**
 * 返回一份**新的**工作区对象（不改入参），以及摘掉了什么的计数。
 *
 * 只动 `nodes` 数组里的字段，不重排结构 —— 导入的价值是把画布原样搬过来，
 * 净化要尽量小，越少改越不容易在下一次格式演进时悄悄漏掉某条路径。
 */
export function sanitizeImportedWorkspace(input: Record<string, unknown>): SanitizeResult {
  const r: SanitizeResult = { ws: {}, commands: 0, identities: 0, dropped: 0 }
  const ws: Record<string, unknown> = { ...input }

  // v1：顶层就是一块画布
  if (Array.isArray(ws.nodes)) ws.nodes = sanitizeNodes(ws.nodes, r)

  // v2：projects + boards[pid].nodes
  if (ws.boards && typeof ws.boards === 'object' && !Array.isArray(ws.boards)) {
    const boards: Record<string, unknown> = {}
    for (const [pid, b] of Object.entries(ws.boards as Record<string, unknown>)) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) continue
      const board = { ...(b as Record<string, unknown>) }
      if (Array.isArray(board.nodes)) board.nodes = sanitizeNodes(board.nodes, r)
      boards[pid] = board
    }
    ws.boards = boards
  }

  r.ws = ws
  return r
}
