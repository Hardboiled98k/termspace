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
  /** 端点不在本画布节点集里、被丢掉的连线数 */
  edges: number
}

/**
 * **连线也必须净化，而且原因和节点不是一回事。**
 *
 * 连线在这个产品里**就是授权**（`authorizeLink` 首先查 `boardLinks`）。
 * 原来只净化 nodes、edges 原样加载 —— 于是别人发来的画布里塞一条悬空边
 * `term-1 → broker:postgres:prod`，导入之后那条 `tb db` 就是**永久授权**，
 * 一次弹窗都不会有。（codex 对手方审查逮到，直接打脸我"broker 不是画布节点、
 * key 永远匹配不上连线"的设计断言。）
 *
 * 判据：**两端都必须是这张画布上真实存活的节点 id**。
 * 主进程侧还有第二道（`broker:` 目标一律不认 boardLinks），两道都要留着 ——
 * 这一道保的是"授权图不含幽灵"，那一道保的是"就算含了也不生效"。
 */
function sanitizeEdges(raw: unknown, ids: Set<string>, r: SanitizeResult): unknown {
  if (!Array.isArray(raw)) return raw
  return raw.filter((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      r.edges++
      return false
    }
    const { source, target } = e as { source?: unknown; target?: unknown }
    const ok = typeof source === 'string' && typeof target === 'string' && ids.has(source) && ids.has(target)
    if (!ok) r.edges++
    return ok
  })
}

/** 净化后**存活**的节点 id（连线要按它过滤） */
function idsOf(nodes: unknown): Set<string> {
  const s = new Set<string>()
  if (!Array.isArray(nodes)) return s
  for (const n of nodes) {
    const id = (n as { id?: unknown })?.id
    if (typeof id === 'string' && id) s.add(id)
  }
  return s
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
  const r: SanitizeResult = { ws: {}, commands: 0, identities: 0, dropped: 0, edges: 0 }
  const ws: Record<string, unknown> = { ...input }

  // v1：顶层就是一块画布
  if (Array.isArray(ws.nodes)) {
    ws.nodes = sanitizeNodes(ws.nodes, r)
    // 顺序不能反：edges 要按**净化之后**存活的节点过滤
    ws.edges = sanitizeEdges(ws.edges, idsOf(ws.nodes), r)
  }

  // v2：projects + boards[pid].nodes
  if (ws.boards && typeof ws.boards === 'object' && !Array.isArray(ws.boards)) {
    const boards: Record<string, unknown> = {}
    for (const [pid, b] of Object.entries(ws.boards as Record<string, unknown>)) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) continue
      const board = { ...(b as Record<string, unknown>) }
      if (Array.isArray(board.nodes)) {
        board.nodes = sanitizeNodes(board.nodes, r)
        board.edges = sanitizeEdges(board.edges, idsOf(board.nodes), r)
      }
      boards[pid] = board
    }
    ws.boards = boards
  }

  r.ws = ws
  return r
}
