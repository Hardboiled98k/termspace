import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import TerminalNode, { type TermNode } from './nodes/TerminalNode'
import GroupNode, { type GroupNodeT } from './nodes/GroupNode'
import WorkerNode, { type WorkerNodeT } from './nodes/WorkerNode'
import ContextNode, { type ContextNodeT } from './nodes/ContextNode'
import BrowserNode, { type BrowserNodeT, browserViews } from './nodes/BrowserNode'
import { IdentityContext, TmuxContext, RequestDeleteContext } from './identity-context'
import { SettingsPanel, type SettingsSection } from './SettingsPanel'
import { MessageCenter } from './MessageCenter'
import {
  IconTerminal,
  IconAgent,
  IconBrief,
  IconFit,
  IconKey,
  IconSettings,
  IconGroup,
  IconChevron,
  IconGlobe,
  IconHand,
  IconCursor
} from './Icons'

export type BoardNode = TermNode | GroupNodeT | WorkerNodeT | ContextNodeT | BrowserNodeT

/** 挂起中的工具审批（Claude PermissionRequest hook，主进程把那次 HTTP 请求挂着等决定） */
export interface PendingApproval {
  id: string
  nodeId: string
  toolName: string
  /** 已截断的展示用摘要 —— 完整输入只在主进程，安全判定不能用这个 */
  summary: string
  toolUseId: string
  createdAt: number
  sessionId: string
  cwd: string
  inputHash: string
  /** 规则引擎判定。只会是「转人工」或「建议拒绝」，永远没有「自动放行」 */
  verdict?: PolicyVerdict
}

/** 一次删除操作的可撤回记录 */
interface UndoEntry {
  label: string
  nodes: BoardNode[]
  edges: Edge[]
  /** nodeId → 销毁前抓到的屏幕内容（撤回时回灌，避免恢复出来是一片空白） */
  screens: Record<string, string>
  at: number
}

const nodeTypes = {
  terminal: TerminalNode,
  group: GroupNode,
  worker: WorkerNode,
  context: ContextNode,
  browser: BrowserNode
}

const statusColor: Record<string, string> = {
  running: '#0A84FF',
  attention: '#FF9F0A',
  error: '#FF453A',
  idle: '#48484A',
  group: '#2C2C2E'
}

/* 磁盘上的工作区格式（只存布局，不存运行时状态） */
interface SavedNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  title: string
  type?: 'terminal' | 'group' | 'context' | 'browser'
  parentId?: string
  identityId?: string
  command?: string
  provider?: string
  fontSize?: number
  cwd?: string
  url?: string
  collapsed?: boolean
}
interface SavedEdge {
  id: string
  source: string
  target: string
  kind: 'context' | 'delegate'
}
/* 项目 = 一张画布 + 一个工作目录（新终端继承它） */
interface Project {
  id: string
  name: string
  cwd: string
}
interface SavedBoard {
  nodes: SavedNode[]
  edges?: SavedEdge[]
  viewport?: Viewport
}
interface Workspace extends SavedBoard {
  // v2
  projects?: Project[]
  activeProjectId?: string
  boards?: Record<string, SavedBoard>
}

const HOME_LABEL = '默认'

function shortPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+/)?.[0]
  return home ? p.replace(home, '~') : p
}

/* 连线语义：简报→终端 = 注入上下文；终端→终端 = 派活通道（M5-p3 接 MCP） */
function edgeStyle(kind: 'context' | 'delegate'): Partial<Edge> {
  return kind === 'context'
    ? {
        animated: false,
        style: { stroke: '#BF5AF2', strokeWidth: 1.6, strokeDasharray: '5 4' },
        data: { kind }
      }
    : {
        animated: true,
        style: { stroke: '#0A84FF', strokeWidth: 1.8 },
        data: { kind }
      }
}

const DEFAULT_SIZE = { width: 580, height: 380 }
/* 成组自动排列参数 */
const GROUP_GAP = 16
const GROUP_PAD = 20
const GROUP_HEAD = 48

/* ── 额度 HUD（数据源: ~/.claude/claude-usage.json，60s 轮询）── */
interface QuotaPool {
  used_percentage: number
  resets_at: number
}
interface Quota {
  five_hour?: QuotaPool
  seven_day?: QuotaPool
}

function zoneClass(pct: number): string {
  // 对齐太极三区：🟢<60 🟡60-78 🔴>78
  return pct > 78 ? 'red' : pct > 60 ? 'yellow' : 'green'
}

function resetIn(resetsAt: number): string {
  const min = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000))
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}m`
}

function QuotaRow({ label, pool }: { label: string; pool: QuotaPool }): React.JSX.Element {
  const pct = Math.round(pool.used_percentage)
  return (
    <div className="quota-row" title={`${label} 已用 ${pct}%，${resetIn(pool.resets_at)} 后重置`}>
      <span className="quota-label">{label}</span>
      <span className="quota-bar">
        <span className={`quota-fill ${zoneClass(pct)}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="quota-pct">{pct}%</span>
      <span className="quota-reset">{resetIn(pool.resets_at)}</span>
    </div>
  )
}

/* 一个供应商一块（未来加 Codex/OpenAI/自定义 API 只需往数组里加） */
function ProviderBlock({
  name,
  pools
}: {
  name: string
  pools: { label: string; pool: QuotaPool }[]
}): React.JSX.Element {
  return (
    <div className="quota-provider">
      <span className="quota-provider-name">{name}</span>
      <div className="quota-provider-rows">
        {pools.map((p) => (
          <QuotaRow key={p.label} label={p.label} pool={p.pool} />
        ))}
      </div>
    </div>
  )
}

/* ── HUD：额度 + 画布概览（M4，用户想法 #1）── */
interface NodeCtx {
  pct: number
  model: string
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').slice(0, 16)
}

function BoardHUD({
  nodes,
  ctxMap,
  onFocus
}: {
  nodes: BoardNode[]
  ctxMap: Record<string, NodeCtx>
  onFocus: (id: string) => void
}): React.JSX.Element | null {
  const [quota, setQuota] = useState<Quota | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => window.termscape.onQuota(setQuota), [])

  const terms = nodes.filter((n): n is TermNode => n.type === 'terminal')
  const running = terms.filter((n) => n.data.status === 'running').length
  const attention = terms.filter((n) => n.data.status === 'attention').length
  // "agent 节点" = 有 provider / 有 context 数据 / 非空闲，最多列 6 行
  const agentRows = terms
    .filter((n) => n.data.provider || ctxMap[n.id] || n.data.status !== 'idle')
    .sort((a, b) => {
      const rank = (s: string): number => (s === 'attention' ? 0 : s === 'running' ? 1 : 2)
      return rank(a.data.status) - rank(b.data.status)
    })
  const shown = agentRows.slice(0, 6)

  const claudePools: { label: string; pool: QuotaPool }[] = []
  if (quota?.five_hour) claudePools.push({ label: '5h', pool: quota.five_hour })
  if (quota?.seven_day) claudePools.push({ label: '周', pool: quota.seven_day })
  const providers = claudePools.length ? [{ name: 'Claude', pools: claudePools }] : []
  if (providers.length === 0 && agentRows.length === 0) return null

  // 折叠态：只留一行摘要（多订阅时最省地方）
  const peak = Math.max(0, ...claudePools.map((p) => Math.round(p.pool.used_percentage)))

  return (
    <div className={`quota-hud${collapsed ? ' collapsed' : ''}`}>
      <button className="hud-toggle" onClick={() => setCollapsed((c) => !c)}>
        <span className="hud-toggle-label">
          {collapsed
            ? `${providers.length ? `${peak}%` : ''}${
                attention > 0 ? ` · ${attention} 需要你` : running > 0 ? ` · ${running} 运行` : ''
              }` || '概览'
            : '用量'}
        </span>
        <span className="hud-caret">{collapsed ? '▾' : '▴'}</span>
      </button>
      {!collapsed && (
        <>
          {providers.length > 0 && (
            <>
              {/* 必须写清楚这是**账号级**的量。它读的是 ~/.claude/claude-usage.json ——
                  Claude Code 自己维护的本机全局文件，跟这张画布上有没有 Claude 终端无关。
                  以前只写一个「用量」，画布上一个 Claude 节点都没有时照样显示百分比，
                  用户会以为这是画布用掉的。 */}
              <span className="quota-title" title="读本机 ~/.claude/claude-usage.json，与画布内容无关">
                账号额度 · 本机全局
              </span>
              {providers.map((p) => (
                <ProviderBlock key={p.name} name={p.name} pools={p.pools} />
              ))}
              <span className="quota-foot">含画布之外的 Claude（终端、IDE、其他窗口）</span>
            </>
          )}
          {agentRows.length > 0 && (
        <>
          <div className="hud-divider" />
          <span className="quota-title">
            画布 · {terms.length} 终端
            {running > 0 && ` · ${running} 运行`}
            {attention > 0 && ` · ${attention} 需要你`}
          </span>
          {shown.map((n) => {
            const ctx = ctxMap[n.id]
            return (
              <button
                key={n.id}
                className="hud-node-row"
                title="点击聚焦节点"
                onClick={() => onFocus(n.id)}
              >
                <span className={`status-dot ${n.data.status}`} />
                <span className="hud-node-title">{n.data.title}</span>
                {ctx && (
                  <>
                    <span className="hud-node-model">{shortModel(ctx.model)}</span>
                    <span className={`ctx-meter ${ctx.pct > 80 ? 'hot' : ctx.pct > 60 ? 'warm' : ''}`}>
                      <span className="ctx-fill" style={{ width: `${ctx.pct}%` }} />
                    </span>
                    <span className="hud-node-pct">{ctx.pct}%</span>
                  </>
                )}
              </button>
            )
          })}
          {agentRows.length > shown.length && (
            <span className="hud-more">还有 {agentRows.length - shown.length} 个…</span>
          )}
        </>
      )}
        </>
      )}
    </div>
  )
}

/* ── Identity 管理面板 ── */
function IdentityPanel({
  identities,
  onChanged
}: {
  identities: IdentityMeta[]
  onChanged: (list: IdentityMeta[]) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<IdentityMeta['provider']>('claude')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState('')

  /* 一键模板：多订阅账号是这个面板最主要的用途，但没人会自己想到
     「原来隔离靠的是 CODEX_HOME」。实测过：换目录后 `codex login status`
     确实报 Not logged in，两个号互不相干。
     末尾那条空值是**删掉**继承来的 API key —— 不删的话 CLI 会优先走按量计费，
     订阅号白开，而且账单不吭声。 */
  const fillTemplate = (kind: 'codex' | 'claude'): void => {
    const n = (identities.filter((i) => i.provider === kind).length + 1).toString()
    setProvider(kind)
    setName(`${kind === 'codex' ? 'Codex' : 'Claude'} 订阅号 ${n}`)
    setEnvText(
      kind === 'codex'
        ? `CODEX_HOME=~/.codex-acct${n}\nOPENAI_API_KEY=`
        : `CLAUDE_CONFIG_DIR=~/.claude-acct${n}\nANTHROPIC_API_KEY=`
    )
  }

  const save = async (): Promise<void> => {
    const env: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq <= 0) continue
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    if (!name.trim() || Object.keys(env).length === 0) {
      setError('名称和至少一条 KEY=VALUE 必填')
      return
    }
    try {
      onChanged(await window.termscape.upsertIdentity({ name, provider, env }))
      setName('')
      setEnvText('')
      setError('')
    } catch {
      setError('保存失败（系统加密不可用？）')
    }
  }

  return (
    <div className="settings-section">
        <h3 className="settings-h">凭证管理</h3>
        <div className="identity-list">
          {identities.length === 0 && <div className="identity-empty">还没有凭证</div>}
          {identities.map((i) => (
            <div key={i.id} className="identity-row">
              <span className={`identity-provider ${i.provider}`}>{i.provider}</span>
              <span className="identity-name">{i.name}</span>
              <span className="identity-keys">{i.envKeys.join(' · ')}</span>
              <button
                className="identity-del"
                onClick={async () => onChanged(await window.termscape.deleteIdentity(i.id))}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="identity-form">
          <div className="identity-form-row">
            <button className="toolbar-btn" onClick={() => fillTemplate('codex')}>
              ＋ Codex 订阅号
            </button>
            <button className="toolbar-btn" onClick={() => fillTemplate('claude')}>
              ＋ Claude 订阅号
            </button>
          </div>
          <p className="settings-note">
            <b>同一台机器上挂多个订阅账号</b>：codex 认 <code>CODEX_HOME</code>、claude 认{' '}
            <code>CLAUDE_CONFIG_DIR</code>，各指一个目录就是各自独立的登录态 ——
            两个终端节点跑同一条 <code>codex</code> 命令，登的是两个号。
            <br />
            流程：上面点模板 → 保存 → 在节点的凭证下拉里选它（会重开会话）→
            在那个终端里跑一次 <code>codex login</code>（claude 则是 <code>/login</code>）。
            以后这个节点一直是这个号。
            <br />
            写 <code>KEY=</code>（等号后留空）表示<b>删掉</b>继承来的变量。模板里默认删
            <code> OPENAI_API_KEY</code> / <code>ANTHROPIC_API_KEY</code> —— 你的 shell 里
            export 过的话，CLI 会优先走按量计费，订阅号等于白开且账单不吭声。
            值支持 <code>~/</code> 与 <code>$HOME/</code> 开头（env 不过 shell，不展开会
            真的建一个叫 <code>~</code> 的目录）。
          </p>
          <div className="identity-form-row">
            <input
              placeholder="名称（如 Claude 工作号）"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <select
              value={provider}
              onChange={(e) => setProvider(e.currentTarget.value as IdentityMeta['provider'])}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="gemini">gemini</option>
              <option value="custom">custom</option>
            </select>
          </div>
          <textarea
            rows={4}
            placeholder={
              '每行一条 KEY=VALUE，例如\nCODEX_HOME=~/.codex-work\nOPENAI_API_KEY=   ← 留空 = 删掉这个变量'
            }
            value={envText}
            onChange={(e) => setEnvText(e.currentTarget.value)}
          />
          {error && <div className="identity-error">{error}</div>}
          <button className="toolbar-btn" onClick={() => void save()}>
            保存凭证（Keychain 加密）
          </button>
        </div>
    </div>
  )
}

/* ── Agent 预设面板（F6）── */
function PresetPanel({
  presets,
  identities,
  onChanged
}: {
  presets: Preset[]
  identities: IdentityMeta[]
  onChanged: (list: Preset[]) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<Preset['provider']>('claude')
  const [command, setCommand] = useState('')
  const [identityId, setIdentityId] = useState('')
  const [error, setError] = useState('')

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError('名称必填')
      return
    }
    onChanged(
      await window.termscape.upsertPreset({
        name,
        provider,
        command,
        identityId: identityId || undefined
      })
    )
    setName('')
    setCommand('')
    setIdentityId('')
    setError('')
  }

  const identityName = (id?: string): string =>
    identities.find((i) => i.id === id)?.name ?? ''

  return (
    <div className="settings-section">
        <h3 className="settings-h">Agent 节点预设</h3>
        <p className="settings-note">
          预设 = 启动命令 + 身份。工具栏「Agent」按预设一键起节点，终端落在当前项目目录。
        </p>
        <div className="identity-list">
          {presets.map((p) => (
            <div key={p.id} className="identity-row">
              <span className={`identity-provider ${p.provider}`}>{p.provider}</span>
              <span className="identity-name">{p.name}</span>
              <span className="identity-keys">
                {p.command || '(纯终端)'}
                {p.identityId ? ` @ ${identityName(p.identityId)}` : ''}
              </span>
              <button
                className="identity-del"
                onClick={async () => onChanged(await window.termscape.deletePreset(p.id))}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="identity-form">
          <div className="identity-form-row">
            <input
              placeholder="名称（如 Claude 主脑）"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <select
              value={provider}
              onChange={(e) => setProvider(e.currentTarget.value as Preset['provider'])}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="gemini">gemini</option>
              <option value="custom">custom</option>
            </select>
          </div>
          <div className="identity-form-row">
            <input
              placeholder="启动命令（如 claude --model opus）"
              value={command}
              onChange={(e) => setCommand(e.currentTarget.value)}
            />
            <select value={identityId} onChange={(e) => setIdentityId(e.currentTarget.value)}>
              <option value="">默认身份</option>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          {error && <div className="identity-error">{error}</div>}
          <button className="toolbar-btn" onClick={() => void save()}>
            保存预设
          </button>
        </div>
    </div>
  )
}

function seedNodes(): BoardNode[] {
  return [
    {
      id: 't1',
      type: 'terminal',
      position: { x: 80, y: 120 },
      ...DEFAULT_SIZE,
      data: { title: 'zsh · main', status: 'idle' }
    }
  ]
}

function fromSaved(s: SavedNode): BoardNode {
  if (s.type === 'browser') {
    return {
      id: s.id,
      type: 'browser',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { url: s.url || 'about:blank', title: s.title }
    }
  }
  if (s.type === 'context') {
    return {
      id: s.id,
      type: 'context',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { title: s.title }
    }
  }
  if (s.type === 'group') {
    return {
      id: s.id,
      type: 'group',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { title: s.title, collapsed: s.collapsed }
    }
  }
  return {
    id: s.id,
    type: 'terminal',
    position: { x: s.x, y: s.y },
    width: s.width || DEFAULT_SIZE.width,
    height: s.height || DEFAULT_SIZE.height,
    parentId: s.parentId,
    extent: s.parentId ? ('parent' as const) : undefined,
    data: {
      title: s.title || s.id,
      status: 'idle',
      identityId: s.identityId,
      command: s.command,
      provider: s.provider,
      fontSize: s.fontSize,
      cwd: s.cwd
    }
  }
}

function toSaved(n: Exclude<BoardNode, WorkerNodeT>): SavedNode {
  const base = {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width: n.width ?? n.measured?.width ?? DEFAULT_SIZE.width,
    height: n.height ?? n.measured?.height ?? DEFAULT_SIZE.height,
    title: n.type === 'browser' ? (n.data.title ?? '浏览器') : n.data.title,
    type: n.type
  }
  if (n.type === 'browser') return { ...base, url: n.data.url }
  // 折叠态要持久化：不然重开后组身还是缩着、子终端却全冒出来
  if (n.type === 'group') return { ...base, collapsed: n.data.collapsed }
  if (n.type === 'context') return base
  return {
    ...base,
    parentId: n.parentId,
    identityId: n.data.identityId,
    command: n.data.command,
    provider: n.data.provider,
    fontSize: n.data.fontSize,
    cwd: n.data.cwd
  }
}

function nextIdFrom(ids: string[], prefix: string): string {
  const max = ids.reduce((m, i) => {
    if (!i.startsWith(prefix)) return m
    const num = parseInt(i.slice(prefix.length), 10)
    return Number.isFinite(num) && num > m ? num : m
  }, 0)
  return `${prefix}${max + 1}`
}

function nextId(nodes: BoardNode[], prefix: string): string {
  return nextIdFrom(
    nodes.map((n) => n.id),
    prefix
  )
}

function Board(): React.JSX.Element {
  const [nodes, setNodes] = useState<BoardNode[]>([])
  /** 最新 nodes 的同步镜像：给那些不该因 nodes 变化而重建的 callback 用 */
  const nodesRef = useRef<BoardNode[]>([])
  nodesRef.current = nodes
  const edgesRef = useRef<Edge[]>([])
  /* 撤回栈。删终端会真杀 tmux 会话 —— 进程救不回来，但布局、配置、连线和
     最后一屏内容可以，够把"手滑删掉"从灾难降级成麻烦。 */
  const undoRef = useRef<UndoEntry[]>([])
  const [undoHint, setUndoHint] = useState<UndoEntry | null>(null)
  const hintTimer = useRef(0)
  const [edges, setEdges] = useState<Edge[]>([])
  edgesRef.current = edges
  const [loaded, setLoaded] = useState(false)
  const [saveTick, setSaveTick] = useState(0)
  // 落盘失败必须让用户看见：静默失败 = 用户以为存好了，关掉就没了
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // 一次性提示（审批失效等）
  const [notice, setNotice] = useState<string | null>(null)
  /** 挂起中的工具审批（来自 Claude PermissionRequest hook，主进程把请求挂着） */
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  useEffect(() => window.termscape.onApprovals(setApprovals), [])
  const [identities, setIdentities] = useState<IdentityMeta[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [defaultIdentity, setDefaultIdentity] = useState('')
  const [defaultFontSize, setDefaultFontSize] = useState(13)
  /** tmux 可用与否决定集群能不能折叠（无 tmux 时隐藏子节点 = 杀进程） */
  const [tmuxOk, setTmuxOk] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(
    // 自检截图模式下直接展开设置面板
    new URLSearchParams(location.search).get('panel') as SettingsSection | null
  )
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    nodeId?: string
    selection?: boolean
    edgeId?: string
  } | null>(null)
  const [mapActive, setMapActive] = useState(false)
  const [canvasMode, setCanvasMode] = useState<'pan' | 'select'>('pan')
  const mapTimer = useRef(0)
  const [ctxMap, setCtxMap] = useState<Record<string, NodeCtx>>({})
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState('')
  // 非活跃项目的画布（终端不销毁 pty，tmux 会话续存，切回来自动 attach）
  const boardsRef = useRef<Record<string, SavedBoard>>({})
  const hadSaved = useRef(false)
  const viewportRef = useRef<Viewport | null>(null)
  const { setViewport, fitView } = useReactFlow()

  // HUD 画布概览用：收集各节点 context 用量（事件只在变化时来，频率低）
  useEffect(
    () =>
      window.termscape.onAgentContext((e) => {
        setCtxMap((m) => ({ ...m, [e.nodeId]: { pct: e.usedPercent, model: e.model } }))
      }),
    []
  )

  const focusNode = useCallback(
    (id: string) => {
      void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1 })
    },
    [fitView]
  )

  // 审批应答：走 Claude 的 PermissionRequest 结构化通道（主进程把那次 hook 请求挂着等这一下），
  // 不再往 pty 盲写 y —— 盲写没法保证落在正确的提示上。
  const decideApproval = useCallback((id: string, allow: boolean) => {
    void window.termscape.decideApproval(id, allow).then((r) => {
      if (!r.ok) setNotice(r.error ?? '应答失败')
    })
  }, [])

  // F7：cdx worker 状态 → 卡片节点（upsert 保留用户拖过的位置；不持久化）
  useEffect(
    () =>
      window.termscape.onWorkers((rows) => {
        setNodes((ns) => {
          const existing = new Map(
            ns.filter((n) => n.type === 'worker').map((n) => [n.id, n])
          )
          const others = ns.filter((n) => n.type !== 'worker')
          // 新卡片放到现有内容右侧一列
          const baseX =
            others.length > 0
              ? Math.max(...others.map((n) => n.position.x + (n.width ?? 580))) + 80
              : 80
          let placed = 0
          const workers: BoardNode[] = rows.map((r) => {
            const id = `w:${r.task}`
            const prev = existing.get(id)
            const data = {
              task: r.task,
              backend: r.backend,
              model: r.model,
              state: r.state,
              repo: r.repo,
              question: r.question,
              ageS: r.age_s
            }
            if (prev) return { ...prev, data } as BoardNode
            return {
              id,
              type: 'worker' as const,
              position: { x: baseX, y: 80 + placed++ * 170 },
              width: 280, // 高度随内容自适应（回复框/结果区会展开）
              data
            }
          })
          return [...others, ...workers]
        })
      }),
    []
  )

  useEffect(() => {
    void window.termscape.listIdentities().then(setIdentities)
    void window.termscape.listPresets().then(setPresets)
    void window.termscape.getSettings().then((s) => {
      const cfg = s as { defaultFontSize?: number; tmuxEnabled?: boolean } | null
      if (typeof cfg?.defaultFontSize === 'number' && cfg.defaultFontSize > 0) {
        setDefaultFontSize(cfg.defaultFontSize)
      }
      // 设置里开着还不够，本机得真装了 tmux
      void window.termscape.doctor().then((items) => {
        const tmux = items.find((d) => d.key === 'tmux')
        setTmuxOk(!!cfg?.tmuxEnabled && !!tmux?.ok)
      })
    })
  }, [])

  const applyBoard = useCallback(
    (b: SavedBoard | undefined) => {
      // 折叠的组：子节点 hidden 不进磁盘（那是派生状态），加载时按父组重算
      const collapsedGroups = new Set(
        (b?.nodes ?? []).filter((n) => n.type === 'group' && n.collapsed).map((n) => n.id)
      )
      setNodes(
        (b?.nodes ?? [])
          .map(fromSaved)
          .map((n) =>
            n.parentId && collapsedGroups.has(n.parentId) ? { ...n, hidden: true } : n
          )
      )
      setEdges(
        (b?.edges ?? []).map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          ...edgeStyle(e.kind)
        }))
      )
      viewportRef.current = b?.viewport ?? null
      if (b?.viewport) void setViewport(b.viewport)
      else setTimeout(() => void fitView({ padding: 0.25, maxZoom: 1 }), 60)
    },
    [setViewport, fitView]
  )

  // 启动恢复（含 v1 单画布 → v2 多项目迁移）
  useEffect(() => {
    let reapTimer = 0
    void window.termscape.loadWorkspace().then((raw) => {
      const ws = raw as Workspace | null
      let projs = ws?.projects
      let boards = ws?.boards
      let active = ws?.activeProjectId

      if (!projs?.length) {
        // v1 迁移：老画布收编成「默认」项目
        const def: Project = { id: 'p1', name: HOME_LABEL, cwd: '' }
        projs = [def]
        boards = {
          p1: {
            nodes:
              ws?.nodes ??
              seedNodes()
                .filter((n): n is Exclude<BoardNode, WorkerNodeT> => n.type !== 'worker')
                .map(toSaved),
            edges: ws?.edges,
            viewport: ws?.viewport
          }
        }
        active = 'p1'
      }
      hadSaved.current = true
      boardsRef.current = boards ?? {}
      setProjects(projs)
      const act = active && projs.some((p) => p.id === active) ? active : projs[0].id
      setActiveProject(act)
      applyBoard(boardsRef.current[act])
      setLoaded(true)
      // 清理孤儿 tmux 会话：全工作区所有项目的节点 id 都保留，其余杀掉。
      // 只在**确实读到**工作区时做 —— 读不到（首次启动 / 文件损坏）时 known 里只有种子节点，
      // reap 会把用户全部真会话当孤儿杀光，和 workspace 损坏组成连环丢数据。
      if (raw) {
        const known = Object.values(boardsRef.current).flatMap((b) => b.nodes.map((n) => n.id))
        // 延迟 5s，等活跃画布节点 spawn 完（它们也在 ptys 里被保护）
        reapTimer = window.setTimeout(() => void window.termscape.reapSessions(known), 5000)
      }
    })
    return () => window.clearTimeout(reapTimer)
  }, [applyBoard])

  // 当前画布快照（worker 卡片是运行时投影，不持久化）
  const snapshot = useCallback(
    (): SavedBoard => ({
      nodes: nodes
        .filter((n): n is Exclude<BoardNode, WorkerNodeT> => n.type !== 'worker')
        .map(toSaved),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        kind: (e.data?.kind as 'context' | 'delegate') ?? 'delegate'
      })),
      viewport: viewportRef.current ?? undefined
    }),
    [nodes, edges]
  )

  // 防抖落盘：当前画布写回所属项目，整个工作区一起存
  useEffect(() => {
    if (!loaded || !activeProject) return
    const t = setTimeout(() => {
      boardsRef.current[activeProject] = snapshot()
      void window.termscape
        .saveWorkspace({
          projects,
          activeProjectId: activeProject,
          boards: boardsRef.current
        })
        .then((r) => setSaveErr(r?.ok === false ? (r.error ?? '未知错误') : null))
    }, 500)
    return () => clearTimeout(t)
  }, [saveTick, loaded, activeProject, projects, snapshot])

  const switchProject = useCallback(
    (pid: string) => {
      if (pid === activeProject) return
      boardsRef.current[activeProject] = snapshot()
      setActiveProject(pid)
      applyBoard(boardsRef.current[pid])
    },
    [activeProject, snapshot, applyBoard]
  )

  const addProject = useCallback(async () => {
    const dir = await window.termscape.pickFolder()
    if (!dir) return
    const pid = `p${Date.now().toString(36)}`
    boardsRef.current[activeProject] = snapshot()
    boardsRef.current[pid] = { nodes: [], edges: [] }
    setProjects((ps) => [...ps, { id: pid, name: dir.split('/').pop() || '项目', cwd: dir }])
    setActiveProject(pid)
    applyBoard(boardsRef.current[pid])
  }, [activeProject, snapshot, applyBoard])

  const closeProject = useCallback(
    (pid: string) => {
      // 只从标签栏移除；画布记录保留（tmux 会话也还活着），重新添加同目录即恢复
      setProjects((ps) => {
        if (ps.length <= 1) return ps
        const rest = ps.filter((p) => p.id !== pid)
        if (pid === activeProject) {
          const next = rest[0].id
          setActiveProject(next)
          applyBoard(boardsRef.current[next])
        }
        return rest
      })
    },
    [activeProject, applyBoard]
  )

  const projectCwd = projects.find((p) => p.id === activeProject)?.cwd || undefined

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    []
  )

  // 连线规则：简报→终端=上下文注入；终端→终端=派活通道；终端→浏览器=允许驱动该浏览器；其余拒绝
  const onConnect = useCallback(
    (c: Connection) => {
      const src = nodes.find((n) => n.id === c.source)
      const tgt = nodes.find((n) => n.id === c.target)
      if (!src || !tgt || src.id === tgt.id) return
      let kind: 'context' | 'delegate' | null = null
      if (src.type === 'context' && tgt.type === 'terminal') kind = 'context'
      else if (src.type === 'terminal' && (tgt.type === 'terminal' || tgt.type === 'browser')) {
        kind = 'delegate'
      }
      if (!kind) return
      setEdges((es) => addEdge({ ...c, ...edgeStyle(kind) }, es))
    },
    [nodes]
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<BoardNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  )

  // agent 状态事件 → 节点 glow/胶囊（兜底策略见 ARCHITECTURE-NOTES.md §3）
  useEffect(() => {
    const doneAt = new Map<string, number>()
    const lastEventAt = new Map<string, number>()

    /* error 是进程非零退出置的，属于"这个终端已经出事了"的终态。
       迟到的 hook 事件（Stop/PostToolUse）不能把它洗回 idle/running —— 那样红框一闪就没了。
       只有明确的新一轮（SessionStart / 用户提交新 prompt）才允许覆盖。 */
    const apply = (
      nodeId: string,
      status: TermNode['data']['status'],
      canClearError = false
    ): void => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== nodeId || n.type !== 'terminal') return n
          if (n.data.status === status) return n
          if (n.data.status === 'error' && !canClearError) return n
          return { ...n, data: { ...n.data, status } }
        })
      )
    }

    const off = window.termscape.onAgentStatus((e) => {
      lastEventAt.set(e.nodeId, Date.now())
      const fresh = e.newTurn || e.event === 'SessionStart' // 新一轮才允许清 error
      if (e.state === 'working') {
        // done-holdoff 3s：并行 hook 晚到的 working 不许复活已结束的 turn
        if (!e.newTurn && Date.now() - (doneAt.get(e.nodeId) ?? 0) < 3000) return
        apply(e.nodeId, 'running', fresh)
      } else if (e.state === 'blocked' || e.state === 'waiting') {
        apply(e.nodeId, 'attention', fresh)
      } else {
        doneAt.set(e.nodeId, Date.now())
        apply(e.nodeId, 'idle', fresh)
      }
    })

    // stale-working 清扫：丢 Stop / CLI 崩溃的最后防线（30min 无事件回 idle）
    const sweep = setInterval(() => {
      const now = Date.now()
      setNodes((ns) =>
        ns.map((n) => {
          if (n.type !== 'terminal' || n.data.status === 'idle') return n
          const last = lastEventAt.get(n.id)
          return last && now - last > 30 * 60_000
            ? { ...n, data: { ...n.data, status: 'idle' as const } }
            : n
        })
      )
    }, 60_000)

    return () => {
      off()
      clearInterval(sweep)
    }
  }, [])

  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => {
    viewportRef.current = vp
    setSaveTick((t) => t + 1) // 走统一防抖保存
  }, [])

  // minimap：平移/缩放时浮现，静止 1.6s 后淡出
  const onMove = useCallback(() => {
    setMapActive(true)
    window.clearTimeout(mapTimer.current)
    mapTimer.current = window.setTimeout(() => setMapActive(false), 1600)
  }, [])

  const addTerminal = useCallback(
    (preset?: Preset) => {
      setShowAgentMenu(false)
      setNodes((ns) => {
        // id 必须全工作区唯一：它就是 tmux 会话名，跨项目撞名会串会话
        const allIds = [
          ...ns.map((n) => n.id),
          ...Object.values(boardsRef.current).flatMap((b) => b.nodes.map((n) => n.id))
        ]
        const id = nextIdFrom(allIds, 't')
        const n = ns.length
        return [
          ...ns,
          {
            id,
            type: 'terminal' as const,
            position: { x: 120 + (n % 5) * 160, y: 160 + (n % 3) * 140 },
            ...DEFAULT_SIZE,
            data: {
              title: preset ? `${preset.name} · ${id}` : `zsh · ${id}`,
              status: 'idle' as const,
              identityId: preset?.identityId || defaultIdentity || undefined,
              command: preset?.command || undefined,
              provider: preset?.provider,
              cwd: projectCwd, // 新终端落在当前项目目录
              fontSize: defaultFontSize // 设置里的默认字号（此前存了但没人读，改了不生效）
            }
          }
        ]
      })
    },
    [defaultIdentity, projectCwd, defaultFontSize]
  )

  /** 返回新节点 id：tb browser open 要靠它把「创建者即所有者」的授权落到实处 */
  const addBrowser = useCallback(
    (url?: string): string => {
      // id 在更新器外算：setNodes 的更新器不是同步跑的，拿不到返回值。
      // 同一 tick 连开两个浏览器会撞 id，但这条路径由 IPC 串行驱动，实际不会发生。
      const newId = nextId(nodesRef.current, 'b')
      setNodes((ns) => {
        if (ns.some((n) => n.id === newId)) return ns
        const n = ns.length
        return [
          ...ns,
          {
            id: newId,
            type: 'browser' as const,
            position: { x: 200 + (n % 4) * 120, y: 200 + (n % 3) * 100 },
            width: 640,
            height: 460,
            data: { url: url || 'https://www.google.com' }
          }
        ]
      })
      return newId
    },
    []
  )

  // F2: 共享上下文 Hub — 无则建（一块板一个），有则聚焦。
  // id 必须带项目号：早期硬编码 'ctx-hub' 导致所有项目共用同一个磁盘文件，简报跨项目串板。
  const openContextHub = useCallback(() => {
    setNodes((ns) => {
      const existing = ns.find((n) => n.type === 'context')
      if (existing) {
        setTimeout(() => focusNode(existing.id), 0)
        return ns
      }
      return [
        ...ns,
        {
          id: `ctx-${activeProject}`,
          type: 'context' as const,
          position: { x: 40, y: 300 },
          width: 420,
          height: 320,
          data: { title: '共享上下文' }
        }
      ]
    })
  }, [focusNode, activeProject])

  // F1: 框选成组 + 自动网格排列（Shift+拖拽框选后点「成组」）
  const groupSelected = useCallback(() => {
    setNodes((ns) => {
      const sel = ns.filter(
        (n): n is TermNode => n.type === 'terminal' && !!n.selected && !n.parentId
      )
      if (sel.length < 2) return ns
      const selIds = new Set(sel.map((n) => n.id))
      const rest = ns.filter((n) => !selIds.has(n.id))
      const gid = nextId(ns, 'g')
      const cols = Math.ceil(Math.sqrt(sel.length))
      const rows = Math.ceil(sel.length / cols)
      const cellW = Math.max(...sel.map((n) => n.width ?? DEFAULT_SIZE.width))
      const cellH = Math.max(...sel.map((n) => n.height ?? DEFAULT_SIZE.height))
      const gw = GROUP_PAD * 2 + cols * cellW + (cols - 1) * GROUP_GAP
      const gh = GROUP_HEAD + GROUP_PAD + rows * cellH + (rows - 1) * GROUP_GAP + GROUP_PAD
      const minX = Math.min(...sel.map((n) => n.position.x))
      const minY = Math.min(...sel.map((n) => n.position.y))
      // 按视觉位置排序后填网格 = 整整齐齐
      const sorted = [...sel].sort(
        (a, b) => a.position.y - b.position.y || a.position.x - b.position.x
      )
      const group: GroupNodeT = {
        id: gid,
        type: 'group',
        position: { x: minX - GROUP_PAD, y: minY - GROUP_HEAD - GROUP_PAD },
        width: gw,
        height: gh,
        data: { title: `集群 ${gid.slice(1)}` }
      }
      const children = sorted.map((n, i) => ({
        ...n,
        parentId: gid,
        extent: 'parent' as const,
        selected: false,
        width: cellW,
        height: cellH,
        position: {
          x: GROUP_PAD + (i % cols) * (cellW + GROUP_GAP),
          y: GROUP_HEAD + GROUP_PAD + Math.floor(i / cols) * (cellH + GROUP_GAP)
        }
      }))
      // 父节点必须排在子节点前面（React Flow 要求）
      return [...rest, group, ...children]
    })
  }, [])

  // 所有订阅 effect 注册完之后握手：主进程收到才重推 quota/workers（防启动竞态）
  useEffect(() => {
    window.termscape.ready()
  }, [])

  // tb browser 驱动：主进程转发指令 → 操作对应 webview → 回结果
  useEffect(
    () =>
      window.termscape.onBrowserCmd(async (req) => {
        const { reqId, nodeId, action, arg } = req
        const done = (ok: boolean, result: string): void =>
          window.termscape.browserResult({ reqId, ok, result })
        // nodeId 为空 → 取第一个浏览器节点（agent 常只开一个）；
        // 但**指名了却找不到**必须报错，不能静默回退 —— 否则 goto/js 会打到另一个
        // 浏览器节点上，而那个节点里可能是用户已登录的会话。
        if (nodeId && !browserViews.has(nodeId)) {
          return done(
            false,
            `找不到浏览器节点 ${nodeId}（tb browser list 看现有节点）。已拒绝，未回退到其他节点。`
          )
        }
        const wv = nodeId
          ? (browserViews.get(nodeId) ?? null)
          : browserViews.size
            ? [...browserViews.values()][0]
            : null
        if (action === 'list') {
          return done(true, [...browserViews.keys()].join('\n') || '(画布上没有浏览器节点)')
        }
        if (action === 'open') {
          // 首行是裸 id：主进程据此把「创建者即所有者」的授权落到真实节点上，
          // agent 也能拿它做后续的 --node 参数
          const newId = addBrowser(arg)
          // 谁开的就自动连一条线：授权在画布上看得见，想撤销直接删线
          if (req.source) {
            setEdges((es) =>
              addEdge(
                {
                  source: req.source,
                  target: newId,
                  sourceHandle: null,
                  targetHandle: null,
                  ...edgeStyle('delegate')
                },
                es
              )
            )
          }
          return done(true, `${newId}\n已打开浏览器节点 ${newId}：${arg}`)
        }
        if (!wv) return done(false, '画布上没有浏览器节点，先 tb browser open <url>')
        try {
          if (action === 'goto') {
            await wv.loadURL(arg)
            return done(true, `已导航到 ${arg}`)
          }
          if (action === 'text') {
            const t = await wv.executeJavaScript('document.body.innerText')
            return done(true, String(t).slice(0, 8000))
          }
          if (action === 'js') {
            const r = await wv.executeJavaScript(arg)
            return done(true, typeof r === 'string' ? r : JSON.stringify(r ?? null))
          }
          if (action === 'shot') {
            const img = await wv.capturePage()
            // arg 为落盘路径（主进程给），data URL 转 base64 回传由主进程存文件
            return done(true, img.toDataURL())
          }
          return done(false, `未知动作 ${action}`)
        } catch (e) {
          return done(false, `执行失败：${String(e)}`)
        }
      }),
    [addBrowser]
  )

  // 把画布 agent 摘要 + 授权连线同步给主进程（tb agents / 派活 / 浏览器驱动都要用）。
  // 连线即授权：终端→终端 = 可派活，终端→浏览器 = 可驱动该浏览器。删线即撤销。
  useEffect(() => {
    window.termscape.reportAgents({
      agents: nodes
        .filter((n): n is TermNode => n.type === 'terminal')
        .map((n) => ({
          id: n.id,
          title: n.data.title,
          provider: n.data.provider,
          status: n.data.status
        })),
      links: edges
        .filter((e) => (e.data?.kind ?? 'delegate') === 'delegate')
        .map((e) => `${e.source}>${e.target}`),
      // 现存节点全集：主进程据此撤销指向已消失节点的一次性授权（id 会被复用）
      nodeIds: nodes.filter((n) => n.type !== 'worker').map((n) => n.id),
      /* 完整画布快照，给远程 API（手机端要按同样的空间关系画出来）。
         只含布局与状态，不含任何终端内容 —— 内容走单独的 peek 接口。 */
      board: {
        projects,
        activeProjectId: activeProject,
        nodes: nodes
          .filter((n) => n.type !== 'worker')
          .map((n) => ({
            id: n.id,
            type: n.type,
            title:
              n.type === 'terminal'
                ? n.data.title
                : n.type === 'browser'
                  ? (n.data.title ?? '浏览器')
                  : n.type === 'context'
                    ? '共享上下文'
                    : n.data.title,
            status: n.type === 'terminal' ? n.data.status : undefined,
            provider: n.type === 'terminal' ? n.data.provider : undefined,
            x: n.position.x,
            y: n.position.y,
            width: n.width ?? n.measured?.width ?? 0,
            height: n.height ?? n.measured?.height ?? 0,
            parentId: n.parentId,
            hidden: !!n.hidden
          })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          kind: (e.data?.kind as string) ?? 'delegate'
        }))
      }
    })
  }, [nodes, edges, projects, activeProject])

  // 右键菜单动作
  const menuNode = menu?.nodeId ? nodes.find((n) => n.id === menu.nodeId) : undefined
  const bumpFont = useCallback(
    (delta: number) => {
      if (!menu?.nodeId) return
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== menu.nodeId || n.type !== 'terminal') return n
          const cur = n.data.fontSize ?? 13
          return { ...n, data: { ...n.data, fontSize: Math.min(24, Math.max(8, cur + delta)) } }
        })
      )
    },
    [menu]
  )
  /** 删节点必须连带删它的连线：连线就是授权图，而节点 id 会复用
      （nextIdFrom 取 max+1），留下悬空连线等于让新节点白捡旧节点的授权 */
  const dropEdgesOf = useCallback((ids: Set<string>) => {
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)))
  }, [])

  /**
   * 统一的删除入口：确认 → 收好可撤回记录 → destroy（拿回最后一屏）→ 移除节点与连线。
   * 所有删除路径都走这里，别再各写各的 —— 之前就是散在四处才漏掉了连线和子节点。
   */
  const removeNodes = useCallback(
    async (ids: string[], label: string, opts?: { skipConfirm?: boolean }): Promise<void> => {
      const gone = new Set(ids)
      const doomed = nodesRef.current.filter((n) => gone.has(n.id))
      if (!doomed.length) return
      const terms = doomed.filter((n) => n.type === 'terminal')
      if (!opts?.skipConfirm) {
        const what =
          terms.length > 0
            ? `${label}？其中 ${terms.length} 个终端的会话会被结束（跑着的进程无法恢复）。`
            : `${label}？`
        if (!window.confirm(`${what}\n\n删除后可以用 ⌘Z 撤回布局与配置。`)) return
      }
      // destroy 会返回销毁前的屏幕内容，留着撤回时回灌
      const screens: Record<string, string> = {}
      await Promise.all(
        terms.map(async (n) => {
          screens[n.id] = await window.termscape.destroy(n.id).catch(() => '')
        })
      )
      const keptEdges = edgesRef.current.filter((e) => gone.has(e.source) || gone.has(e.target))
      undoRef.current.push({ label, nodes: doomed, edges: keptEdges, screens, at: Date.now() })
      if (undoRef.current.length > 20) undoRef.current.shift()
      setNodes((ns) => ns.filter((n) => !gone.has(n.id)))
      dropEdgesOf(gone)
      setUndoHint(undoRef.current[undoRef.current.length - 1])
      window.clearTimeout(hintTimer.current)
      hintTimer.current = window.setTimeout(() => setUndoHint(null), 12_000)
    },
    [dropEdgesOf]
  )

  /** 撤回：先把屏幕内容写回快照文件，再放节点回画布（顺序反了就会先 spawn 后回灌，白屏） */
  const requestDelete = useCallback(
    (ids: string[], label: string): void => {
      void removeNodes(ids, label)
    },
    [removeNodes]
  )

  const undoDelete = useCallback(async (): Promise<void> => {
    const entry = undoRef.current.pop()
    if (!entry) return
    setUndoHint(null)
    await Promise.all(
      Object.entries(entry.screens).map(([id, text]) =>
        text ? window.termscape.seedScrollback(id, text) : Promise.resolve(false)
      )
    )
    setNodes((ns) => [...ns, ...entry.nodes.filter((n) => !ns.some((x) => x.id === n.id))])
    setEdges((es) => [...es, ...entry.edges.filter((e) => !es.some((x) => x.id === e.id))])
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        // 终端里 ⌘Z 有自己的语义，只在画布上生效
        const t = e.target as HTMLElement | null
        if (t?.closest('.term-node-body, input, textarea')) return
        e.preventDefault()
        void undoDelete()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoDelete])

  const deleteMenuNode = useCallback(() => {
    if (!menuNode) return
    const kids = nodes.filter((n) => n.parentId === menuNode.id).map((n) => n.id)
    const label =
      menuNode.type === 'group' ? `删除集群及组内 ${kids.length} 个节点` : '删除该节点'
    void removeNodes([menuNode.id, ...kids], label)
    setMenu(null)
  }, [menuNode, nodes, removeNodes])

  const selectedCount = nodes.filter(
    (n) => n.type === 'terminal' && n.selected && !n.parentId
  ).length

  return (
    <IdentityContext.Provider value={identities}>
      <TmuxContext.Provider value={tmuxOk}>
      <RequestDeleteContext.Provider value={requestDelete}>
      <div className={`h-screen w-screen mode-${canvasMode}`}>
        {settingsOpen && (
          <SettingsPanel
            initial={settingsOpen}
            onClose={() => setSettingsOpen(null)}
            renderPresets={() => (
              <PresetPanel presets={presets} identities={identities} onChanged={setPresets} />
            )}
            renderIdentities={() => (
              <IdentityPanel identities={identities} onChanged={setIdentities} />
            )}
          />
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onMoveEnd={onMoveEnd}
          onMove={onMove}
          onPaneClick={() => setMenu(null)}
          onPaneContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          onNodeContextMenu={(e, n) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, nodeId: n.id })
          }}
          onSelectionContextMenu={(e) => {
            // 框选后右键：弹「成组」菜单
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, selection: true })
          }}
          onEdgeContextMenu={(e, edge) => {
            // 连线右键 → 删除。连线即授权，所以必须能撤销
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, edgeId: edge.id })
          }}
          nodeTypes={nodeTypes}
          colorMode="dark"
          minZoom={0.02} /* 真·无限：能缩到极远看全局分布 */
          translateExtent={[
            [-Infinity, -Infinity],
            [Infinity, Infinity]
          ]}
          nodeExtent={[
            [-Infinity, -Infinity],
            [Infinity, Infinity]
          ]}
          maxZoom={1.5} /* ponytail: WebGL canvas 放大是位图拉伸会糊，>1.5 不可接受；真·清晰放大需按 zoom 重设 fontSize，后续做 */
          panOnScroll
          zoomOnScroll={false}
          deleteKeyCode={null}
          panOnDrag={canvasMode === 'pan'}
          selectionOnDrag={canvasMode === 'select'}
          selectionKeyCode={canvasMode === 'pan' ? 'Shift' : null}
          edgesReconnectable={false}
          connectionLineStyle={{ stroke: '#0A84FF', strokeWidth: 2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.2}
            color="rgba(255, 255, 255, 0.22)"
            bgColor="transparent"
          />
          <Controls position="bottom-left" showInteractive={false} />
          {undoHint && !saveErr && !notice && (
            <Panel position="bottom-center" className="undo-toast">
              已{undoHint.label}
              <button
                className="undo-btn"
                onClick={() => {
                  void undoDelete()
                }}
              >
                撤回（⌘Z）
              </button>
              <button className="undo-dismiss" onClick={() => setUndoHint(null)}>
                ✕
              </button>
            </Panel>
          )}
          {(saveErr || notice) && (
            <Panel position="bottom-center" className="save-alert">
              <span className="save-alert-dot" />
              {saveErr ? `画布未能保存：${saveErr}` : notice}
              <button
                className="save-alert-retry"
                onClick={() => (saveErr ? setSaveTick((t) => t + 1) : setNotice(null))}
              >
                {saveErr ? '重试' : '知道了'}
              </button>
            </Panel>
          )}
          <Panel position="bottom-left" className="mode-switch">
            <button
              className={`mode-btn active ${canvasMode}`}
              title={
                canvasMode === 'pan'
                  ? '当前：拖拽平移（Shift 框选）· 点击切到框选'
                  : '当前：拖拽框选（空格平移）· 点击切到平移'
              }
              onClick={() => setCanvasMode((m) => (m === 'pan' ? 'select' : 'pan'))}
            >
              {canvasMode === 'pan' ? <IconHand /> : <IconCursor />}
            </button>
          </Panel>
          <MiniMap
            className={mapActive ? 'map-visible' : 'map-hidden'}
            pannable
            zoomable
            nodeColor={(n) => {
              if (n.type === 'context') return '#BF5AF2'
              if (n.type === 'browser') return '#5AC8FA'
              if (n.type === 'group') return statusColor['group']
              if (n.type === 'worker') {
                const st = (n.data as { state?: string }).state
                if (st === 'working') return statusColor['running']
                if (st === 'awaiting_reply' || st === 'stalled') return statusColor['attention']
                return statusColor['idle']
              }
              return statusColor[(n.data as { status?: string }).status ?? 'idle']
            }}
            nodeStrokeWidth={3}
          />
          {/* 右上角单一栏：额度 HUD 与消息中心竖排。两个各自的 top-right Panel
              会被绝对定位到同一点上，字直接压在一起 */}
          <Panel position="top-right" className="right-rail">
            <BoardHUD nodes={nodes} ctxMap={ctxMap} onFocus={focusNode} />
            <MessageCenter
              nodes={nodes}
              approvals={approvals}
              onFocus={focusNode}
              onDecide={decideApproval}
            />
          </Panel>
          {/* 浏览器式顶部标签条：贴顶、满宽、横向滚动 */}
          <Panel position="top-center" className="project-tabbar">
            <div className="project-tabs">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={`project-tab${p.id === activeProject ? ' active' : ''}`}
                  title={p.cwd ? shortPath(p.cwd) : '未指定目录（终端在 ~ 启动）'}
                  onClick={() => switchProject(p.id)}
                >
                  <span className="project-tab-name">{p.name}</span>
                  {p.cwd && <span className="project-tab-cwd">{shortPath(p.cwd)}</span>}
                  {projects.length > 1 && (
                    <span
                      className="project-tab-close"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeProject(p.id)
                      }}
                    >
                      ✕
                    </span>
                  )}
                </button>
              ))}
              <button className="project-tab add" title="打开项目文件夹" onClick={addProject}>
                ＋
              </button>
            </div>
          </Panel>
          <Panel position="top-left" className="board-top">
            <div className="toolbar">
            {/* 拆分按钮：最高频的「新建终端」保持一键，其余节点类型收进下拉。
                此前 4 个带文字 + 3 个纯图标混排，没有主次，视觉也乱。 */}
            <span className="agent-menu-wrap split">
              <button
                className="toolbar-btn split-main"
                title="新建终端"
                onClick={() => addTerminal()}
              >
                <IconTerminal />
                <span>新建终端</span>
              </button>
              <button
                className="toolbar-btn split-caret"
                title="新建其他节点：agent 预设 / 简报 / 浏览器"
                onClick={() => setShowAgentMenu((s) => !s)}
              >
                <IconChevron />
              </button>
              {showAgentMenu && (
                <div className="agent-menu">
                  <div className="agent-menu-label">Agent 预设</div>
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      className="agent-menu-item"
                      onClick={() => {
                        setShowAgentMenu(false)
                        addTerminal(p)
                      }}
                    >
                      <span className={`identity-provider ${p.provider}`}>{p.provider}</span>
                      {p.name}
                    </button>
                  ))}
                  <div className="ctx-menu-sep" />
                  <button
                    className="agent-menu-item"
                    onClick={() => {
                      setShowAgentMenu(false)
                      openContextHub()
                    }}
                  >
                    <IconBrief />
                    项目简报（共享上下文）
                  </button>
                  <button
                    className="agent-menu-item"
                    onClick={() => {
                      setShowAgentMenu(false)
                      addBrowser()
                    }}
                  >
                    <IconGlobe />
                    画布内浏览器
                  </button>
                  <div className="ctx-menu-sep" />
                  <button
                    className="agent-menu-item manage"
                    onClick={() => {
                      setShowAgentMenu(false)
                      setSettingsOpen('presets')
                    }}
                  >
                    管理预设…
                  </button>
                </div>
              )}
            </span>
            {selectedCount >= 2 && (
              <button className="toolbar-btn accent" onClick={groupSelected}>
                <IconGroup />
                <span>成组 {selectedCount}</span>
              </button>
            )}
            {identities.length > 0 && (
              <select
                className="identity-select"
                value={defaultIdentity}
                title="新终端使用的默认身份"
                onChange={(e) => setDefaultIdentity(e.currentTarget.value)}
              >
                <option value="">默认身份</option>
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            )}
            <span className="toolbar-sep" />
            <button
              className="toolbar-btn icon-only"
              title="缩放到全部节点"
              onClick={() => void fitView({ padding: 0.2, duration: 300 })}
            >
              <IconFit />
            </button>
            <button
              className="toolbar-btn icon-only"
              title="凭证管理"
              onClick={() => setSettingsOpen('identities')}
            >
              <IconKey />
            </button>
            <button
              className="toolbar-btn icon-only"
              title="设置"
              onClick={() => setSettingsOpen('general')}
            >
              <IconSettings />
            </button>
            <span className="toolbar-count">{nodes.length}</span>
            </div>
          </Panel>
          {menu && (
            <div
              className="ctx-menu"
              style={{ left: menu.x, top: menu.y }}
              onMouseLeave={() => setMenu(null)}
            >
              {menu.edgeId && (
                <>
                  <div className="ctx-menu-title">
                    {edges.find((e) => e.id === menu.edgeId)?.data?.kind === 'context'
                      ? '上下文注入连线'
                      : '派活 / 驱动授权连线'}
                  </div>
                  <button
                    className="ctx-menu-item danger"
                    onClick={() => {
                      setEdges((es) => es.filter((e) => e.id !== menu.edgeId))
                      setMenu(null)
                    }}
                  >
                    删除连线（撤销该授权）
                  </button>
                </>
              )}
              {menu.selection && (
                <>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      groupSelected()
                      setMenu(null)
                    }}
                  >
                    <IconGroup />
                    成组（{selectedCount}）
                  </button>
                  <button
                    className="ctx-menu-item danger"
                    onClick={() => {
                      // 选中里若有集群，子节点要一起删 —— 否则组没了、子节点还留着
                      // parentId 和 hidden:true，变成永远看不见也删不掉的孤儿
                      const selIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id))
                      const gone = nodes
                        .filter((n) => n.selected || (n.parentId && selIds.has(n.parentId)))
                        .map((n) => n.id)
                      void removeNodes(gone, `删除选中的 ${gone.length} 个节点`)
                      setMenu(null)
                    }}
                  >
                    删除选中（{selectedCount}）
                  </button>
                </>
              )}
              {!menu.nodeId && !menu.selection && !menu.edgeId && (
                <>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      addTerminal()
                      setMenu(null)
                    }}
                  >
                    <IconTerminal />
                    新建终端
                  </button>
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      className="ctx-menu-item"
                      onClick={() => {
                        addTerminal(p)
                        setMenu(null)
                      }}
                    >
                      <IconAgent />
                      新建 {p.name}
                    </button>
                  ))}
                  <div className="ctx-menu-sep" />
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      openContextHub()
                      setMenu(null)
                    }}
                  >
                    <IconBrief />
                    项目简报
                  </button>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      addBrowser()
                      setMenu(null)
                    }}
                  >
                    <IconGlobe />
                    浏览器
                  </button>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      void fitView({ padding: 0.2, duration: 300 })
                      setMenu(null)
                    }}
                  >
                    <IconFit />
                    适应全部
                  </button>
                </>
              )}
              {menu.nodeId && (
                <>
                  {menuNode?.type === 'terminal' && (
                    <>
                      <button className="ctx-menu-item" onClick={() => bumpFont(1)}>
                        字号放大
                        <span className="ctx-menu-hint">⌥滚轮</span>
                      </button>
                      <button className="ctx-menu-item" onClick={() => bumpFont(-1)}>
                        字号缩小
                        <span className="ctx-menu-hint">⌥滚轮</span>
                      </button>
                      <div className="ctx-menu-sep" />
                    </>
                  )}
                  {selectedCount >= 2 && (
                    <button
                      className="ctx-menu-item"
                      onClick={() => {
                        groupSelected()
                        setMenu(null)
                      }}
                    >
                      <IconGroup />
                      成组（{selectedCount}）
                    </button>
                  )}
                  <button className="ctx-menu-item danger" onClick={deleteMenuNode}>
                    删除
                    {menuNode?.type === 'terminal' && (
                      <span className="ctx-menu-hint">结束会话</span>
                    )}
                  </button>
                </>
              )}
            </div>
          )}
        </ReactFlow>
      </div>
      </RequestDeleteContext.Provider>
      </TmuxContext.Provider>
    </IdentityContext.Provider>
  )
}

export default function App(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <Board />
    </ReactFlowProvider>
  )
}
