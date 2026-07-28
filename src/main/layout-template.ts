/**
 * 任务布局模板 —— 可以发给同事的「前端 agent + 后端 agent + 测试 shell + 浏览器 + 简报」。
 *
 * 现在只有两个极端：单节点预设、或整块本机 workspace。中间缺了这一层。
 * 而直接分享 workspace 会撞上今天修的那个 P0（外部文件里的 `command`
 * 会在重启后自动执行），所以模板从设计上就不能是"workspace 换个名字"。
 *
 * 三条判据，缺一条这东西就不能发给别人：
 *
 * 1. **不含任何凭证**。`identityId` 是本机的 id，对别人毫无意义，
 *    而留着它意味着导入方的节点会静默绑上他自己的某个账号。
 * 2. **相对 cwd**。模板里存 `./api`，导入时相对你选的根目录展开。
 *    存绝对路径 = 只在作者机器上有意义。
 * 3. **命令默认暂停**。铺出来的终端带着"建议命令"，但**不自动跑** ——
 *    用户看一眼再决定。Zellij 对远程 layout 里的命令就是这么处理的。
 *
 * 不做的：不存运行态（状态、scrollback、tmux 会话）、不存 worktree 绑定
 * （那是本机文件系统的事）、不存窗口尺寸之外的画布视口。
 */

export interface TemplateNode {
  /** 模板内的局部 id，只用来表达连线关系 */
  ref: string
  type: 'terminal' | 'browser' | 'context' | 'group'
  title: string
  /** 相对根目录的路径（`.` = 根本身）。绝对路径会被拒 */
  cwd?: string
  /** **建议**命令。导入后停在那儿，用户点了才跑 */
  suggestedCommand?: string
  provider?: string
  url?: string
  /** 属于哪个组（组自身的 ref） */
  parent?: string
  x: number
  y: number
  width?: number
  height?: number
}

export interface LayoutTemplate {
  kind: 'termspace-layout'
  version: 1
  name: string
  description?: string
  nodes: TemplateNode[]
  /** `from>to`，语义与画布连线一致 */
  edges: { from: string; to: string; kind: string }[]
}

const TYPES = new Set(['terminal', 'browser', 'context', 'group'])

/**
 * 从画布节点导出模板。**剥掉一切本机的东西**。
 *
 * `absRoot` 是导出时选的根：所有落在它下面的 cwd 转成相对路径，
 * 落在外面的**整个丢掉 cwd**（而不是保留绝对路径）—— 一个指向
 * `/Users/you/...` 的模板发给别人只会让他的终端起在家目录，
 * 还泄漏了你的用户名和目录结构。
 */
export function toTemplate(
  name: string,
  nodes: {
    id: string
    type?: string
    parentId?: string
    position: { x: number; y: number }
    width?: number
    height?: number
    data: Record<string, unknown>
  }[],
  edges: { source: string; target: string; data?: { kind?: string } }[],
  absRoot: string,
  description?: string
): LayoutTemplate {
  const rel = (cwd: unknown): string | undefined => {
    if (typeof cwd !== 'string' || !cwd) return undefined
    if (cwd === absRoot) return '.'
    const base = absRoot.endsWith('/') ? absRoot : `${absRoot}/`
    return cwd.startsWith(base) ? cwd.slice(base.length) : undefined
  }
  const keep = nodes.filter((n) => TYPES.has(n.type ?? 'terminal'))
  const ids = new Set(keep.map((n) => n.id))
  return {
    kind: 'termspace-layout',
    version: 1,
    name: name.trim().slice(0, 60) || '未命名布局',
    ...(description ? { description: description.slice(0, 400) } : {}),
    nodes: keep.map((n) => ({
      ref: n.id,
      type: (n.type ?? 'terminal') as TemplateNode['type'],
      title: String(n.data.title ?? n.id).slice(0, 60),
      ...(rel(n.data.cwd) ? { cwd: rel(n.data.cwd) } : {}),
      /* 导出时把 `command` 改名成 `suggestedCommand`。**名字不同是有意的** ——
         导入侧读的字段和自动执行那条路径读的字段（`command`）必须不是同一个，
         这样"忘了处理"的默认结果是不跑，而不是跑。 */
      ...(typeof n.data.command === 'string' && n.data.command
        ? { suggestedCommand: n.data.command.slice(0, 500) }
        : {}),
      ...(typeof n.data.provider === 'string' ? { provider: n.data.provider } : {}),
      ...(typeof n.data.url === 'string' ? { url: n.data.url } : {}),
      ...(n.parentId && ids.has(n.parentId) ? { parent: n.parentId } : {}),
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      ...(n.width ? { width: Math.round(n.width) } : {}),
      ...(n.height ? { height: Math.round(n.height) } : {})
    })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ from: e.source, to: e.target, kind: e.data?.kind ?? 'context' }))
  }
}

export interface ImportedNode extends TemplateNode {
  /** 展开后的绝对 cwd */
  absCwd?: string
}

export interface ImportResult {
  ok: boolean
  error?: string
  name?: string
  nodes?: ImportedNode[]
  edges?: { from: string; to: string; kind: string }[]
  /** 有多少个节点带着建议命令（导入确认框要说清楚"它们不会自动跑"） */
  withCommands?: number
}

/**
 * 校验并展开模板。**这是外部文件的入口，判据要密**。
 *
 * 特别是 cwd：绝对路径、`..` 逃逸一律拒。模板可以来自任何人，
 * 而它决定的是"在哪个目录起一个 shell"。
 */
export function fromTemplate(raw: unknown, absRoot: string): ImportResult {
  const t = raw as LayoutTemplate | null
  if (!t || typeof t !== 'object' || t.kind !== 'termspace-layout') {
    return { ok: false, error: '这不是 Termspace 的布局模板' }
  }
  if (t.version !== 1) return { ok: false, error: `不认识的模板版本：${String(t.version)}` }
  if (!Array.isArray(t.nodes)) return { ok: false, error: '模板里没有 nodes' }
  if (t.nodes.length > 60) return { ok: false, error: '模板节点太多（上限 60）' }

  const nodes: ImportedNode[] = []
  for (const n of t.nodes) {
    if (!n || typeof n !== 'object') continue
    if (!TYPES.has(n.type)) continue // 不认识的类型整个丢，别兜底成终端
    if (typeof n.ref !== 'string' || !n.ref) continue
    let absCwd: string | undefined
    if (n.cwd !== undefined) {
      if (typeof n.cwd !== 'string') return { ok: false, error: 'cwd 不是字符串' }
      if (n.cwd.startsWith('/') || n.cwd.includes('..') || n.cwd.includes('\0')) {
        return { ok: false, error: `模板里的路径不合法：${n.cwd}（必须是根目录下的相对路径）` }
      }
      absCwd = n.cwd === '.' ? absRoot : `${absRoot.replace(/\/$/, '')}/${n.cwd}`
    }
    nodes.push({
      ...n,
      title: String(n.title ?? n.ref).slice(0, 60),
      ...(absCwd ? { absCwd } : {}),
      x: Number(n.x) || 0,
      y: Number(n.y) || 0
    })
  }
  const refs = new Set(nodes.map((n) => n.ref))
  const edges = (Array.isArray(t.edges) ? t.edges : []).filter(
    (e) => e && refs.has(e.from) && refs.has(e.to)
  )
  return {
    ok: true,
    name: String(t.name ?? '未命名布局').slice(0, 60),
    nodes,
    edges,
    withCommands: nodes.filter((n) => n.suggestedCommand).length
  }
}
