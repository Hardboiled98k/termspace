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
  useReactFlow,
  type NodeChange,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import TerminalNode, { type TermNode } from './nodes/TerminalNode'
import GroupNode, { type GroupNodeT } from './nodes/GroupNode'
import WorkerNode, { type WorkerNodeT } from './nodes/WorkerNode'
import { IdentityContext } from './identity-context'

export type BoardNode = TermNode | GroupNodeT | WorkerNodeT

const nodeTypes = { terminal: TerminalNode, group: GroupNode, worker: WorkerNode }

const statusColor: Record<string, string> = {
  running: '#0A84FF',
  attention: '#FF9F0A',
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
  type?: 'terminal' | 'group'
  parentId?: string
  identityId?: string
  command?: string
  provider?: string
}
interface Workspace {
  nodes: SavedNode[]
  viewport?: Viewport
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
  useEffect(() => window.termboard.onQuota(setQuota), [])

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

  const hasQuota = quota?.five_hour || quota?.seven_day
  if (!hasQuota && agentRows.length === 0) return null

  return (
    <Panel position="top-right" className="quota-hud">
      {hasQuota && (
        <>
          <span className="quota-title">Claude</span>
          {quota?.five_hour && <QuotaRow label="5h" pool={quota.five_hour} />}
          {quota?.seven_day && <QuotaRow label="周" pool={quota.seven_day} />}
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
    </Panel>
  )
}

/* ── Identity 管理面板 ── */
function IdentityPanel({
  identities,
  onChanged,
  onClose
}: {
  identities: IdentityMeta[]
  onChanged: (list: IdentityMeta[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<IdentityMeta['provider']>('claude')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState('')

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
      onChanged(await window.termboard.upsertIdentity({ name, provider, env }))
      setName('')
      setEnvText('')
      setError('')
    } catch {
      setError('保存失败（系统加密不可用？）')
    }
  }

  return (
    <div className="identity-overlay" onClick={onClose}>
      <div className="identity-panel" onClick={(e) => e.stopPropagation()}>
        <div className="identity-panel-head">
          <span>凭证管理</span>
          <button className="term-node-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="identity-list">
          {identities.length === 0 && <div className="identity-empty">还没有凭证</div>}
          {identities.map((i) => (
            <div key={i.id} className="identity-row">
              <span className={`identity-provider ${i.provider}`}>{i.provider}</span>
              <span className="identity-name">{i.name}</span>
              <span className="identity-keys">{i.envKeys.join(' · ')}</span>
              <button
                className="identity-del"
                onClick={async () => onChanged(await window.termboard.deleteIdentity(i.id))}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="identity-form">
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
              '每行一条 KEY=VALUE，例如\nANTHROPIC_API_KEY=sk-ant-xxx\nCLAUDE_CONFIG_DIR=/Users/me/.claude-work'
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
    </div>
  )
}

/* ── Agent 预设面板（F6）── */
function PresetPanel({
  presets,
  identities,
  onChanged,
  onClose
}: {
  presets: Preset[]
  identities: IdentityMeta[]
  onChanged: (list: Preset[]) => void
  onClose: () => void
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
      await window.termboard.upsertPreset({
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
    <div className="identity-overlay" onClick={onClose}>
      <div className="identity-panel" onClick={(e) => e.stopPropagation()}>
        <div className="identity-panel-head">
          <span>Agent 节点预设</span>
          <button className="term-node-close" onClick={onClose}>
            ✕
          </button>
        </div>
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
                onClick={async () => onChanged(await window.termboard.deletePreset(p.id))}
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
  if (s.type === 'group') {
    return {
      id: s.id,
      type: 'group',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { title: s.title }
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
      provider: s.provider
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
    title: n.data.title,
    type: n.type
  }
  if (n.type === 'group') return base
  return {
    ...base,
    parentId: n.parentId,
    identityId: n.data.identityId,
    command: n.data.command,
    provider: n.data.provider
  }
}

function nextId(nodes: BoardNode[], prefix: string): string {
  const max = nodes.reduce((m, n) => {
    if (!n.id.startsWith(prefix)) return m
    const num = parseInt(n.id.slice(prefix.length), 10)
    return Number.isFinite(num) && num > m ? num : m
  }, 0)
  return `${prefix}${max + 1}`
}

function Board(): React.JSX.Element {
  const [nodes, setNodes] = useState<BoardNode[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saveTick, setSaveTick] = useState(0)
  const [identities, setIdentities] = useState<IdentityMeta[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [defaultIdentity, setDefaultIdentity] = useState('')
  const [showIdentities, setShowIdentities] = useState(false)
  const [showPresetPanel, setShowPresetPanel] = useState(false)
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [ctxMap, setCtxMap] = useState<Record<string, NodeCtx>>({})
  const hadSaved = useRef(false)
  const viewportRef = useRef<Viewport | null>(null)
  const { setViewport, fitView } = useReactFlow()

  // HUD 画布概览用：收集各节点 context 用量（事件只在变化时来，频率低）
  useEffect(
    () =>
      window.termboard.onAgentContext((e) => {
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

  // F7：cdx worker 状态 → 卡片节点（upsert 保留用户拖过的位置；不持久化）
  useEffect(
    () =>
      window.termboard.onWorkers((rows) => {
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
    void window.termboard.listIdentities().then(setIdentities)
    void window.termboard.listPresets().then(setPresets)
  }, [])

  // 启动恢复：有存档用存档，没有播种默认节点
  useEffect(() => {
    void window.termboard.loadWorkspace().then((raw) => {
      const ws = raw as Workspace | null
      if (ws?.nodes?.length) {
        hadSaved.current = true
        setNodes(ws.nodes.map(fromSaved))
        if (ws.viewport) {
          viewportRef.current = ws.viewport
          void setViewport(ws.viewport)
        }
      } else {
        setNodes(seedNodes())
        // 节点 set 是异步渲染，等一帧再 fitView（prop 版在空画布时已错过时机）
        setTimeout(() => void fitView({ padding: 0.25, maxZoom: 1 }), 60)
      }
      setLoaded(true)
    })
  }, [setViewport, fitView])

  // 防抖落盘：布局/标题/视口变化 500ms 后写 JSON
  useEffect(() => {
    if (!loaded) return
    const t = setTimeout(() => {
      void window.termboard.saveWorkspace({
        // worker 卡片是运行时投影（cdx 状态），不持久化
        nodes: nodes
          .filter((n): n is Exclude<BoardNode, WorkerNodeT> => n.type !== 'worker')
          .map(toSaved),
        viewport: viewportRef.current ?? undefined
      })
    }, 500)
    return () => clearTimeout(t)
  }, [nodes, saveTick, loaded])

  const onNodesChange = useCallback(
    (changes: NodeChange<BoardNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  )

  // agent 状态事件 → 节点 glow/胶囊（兜底策略见 ARCHITECTURE-NOTES.md §3）
  useEffect(() => {
    const doneAt = new Map<string, number>()
    const lastEventAt = new Map<string, number>()

    const apply = (nodeId: string, status: TermNode['data']['status']): void => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId && n.type === 'terminal' && n.data.status !== status
            ? { ...n, data: { ...n.data, status } }
            : n
        )
      )
    }

    const off = window.termboard.onAgentStatus((e) => {
      lastEventAt.set(e.nodeId, Date.now())
      if (e.state === 'working') {
        // done-holdoff 3s：并行 hook 晚到的 working 不许复活已结束的 turn
        if (!e.newTurn && Date.now() - (doneAt.get(e.nodeId) ?? 0) < 3000) return
        apply(e.nodeId, 'running')
      } else if (e.state === 'blocked' || e.state === 'waiting') {
        apply(e.nodeId, 'attention')
      } else {
        doneAt.set(e.nodeId, Date.now())
        apply(e.nodeId, 'idle')
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

  const addTerminal = useCallback(
    (preset?: Preset) => {
      setShowAgentMenu(false)
      setNodes((ns) => {
        const id = nextId(ns, 't')
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
              provider: preset?.provider
            }
          }
        ]
      })
    },
    [defaultIdentity]
  )

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
    window.termboard.ready()
  }, [])

  const selectedCount = nodes.filter(
    (n) => n.type === 'terminal' && n.selected && !n.parentId
  ).length

  return (
    <IdentityContext.Provider value={identities}>
      <div className="h-screen w-screen">
        {showIdentities && (
          <IdentityPanel
            identities={identities}
            onChanged={setIdentities}
            onClose={() => setShowIdentities(false)}
          />
        )}
        {showPresetPanel && (
          <PresetPanel
            presets={presets}
            identities={identities}
            onChanged={setPresets}
            onClose={() => setShowPresetPanel(false)}
          />
        )}
        <ReactFlow
          nodes={nodes}
          onNodesChange={onNodesChange}
          onMoveEnd={onMoveEnd}
          nodeTypes={nodeTypes}
          colorMode="dark"
          minZoom={0.15}
          maxZoom={1.5} /* ponytail: WebGL canvas 放大是位图拉伸会糊，>1.5 不可接受；真·清晰放大需按 zoom 重设 fontSize，后续做 */
          panOnScroll
          zoomOnScroll={false}
          deleteKeyCode={null}
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
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
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
          <BoardHUD nodes={nodes} ctxMap={ctxMap} onFocus={focusNode} />
          <Panel position="top-left" className="toolbar">
            <span className="toolbar-title">TermBoard</span>
            <span className="toolbar-sep" />
            <button className="toolbar-btn" onClick={() => addTerminal()}>
              ＋ 终端
            </button>
            <span className="agent-menu-wrap">
              <button
                className="toolbar-btn"
                onClick={() => setShowAgentMenu((s) => !s)}
              >
                ＋ Agent ▾
              </button>
              {showAgentMenu && (
                <div className="agent-menu">
                  {presets.map((p) => (
                    <button key={p.id} className="agent-menu-item" onClick={() => addTerminal(p)}>
                      <span className={`identity-provider ${p.provider}`}>{p.provider}</span>
                      {p.name}
                    </button>
                  ))}
                  <button
                    className="agent-menu-item manage"
                    onClick={() => {
                      setShowAgentMenu(false)
                      setShowPresetPanel(true)
                    }}
                  >
                    管理预设…
                  </button>
                </div>
              )}
            </span>
            {selectedCount >= 2 && (
              <button className="toolbar-btn accent" onClick={groupSelected}>
                成组 ({selectedCount})
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
            <button className="toolbar-btn" onClick={() => setShowIdentities(true)}>
              凭证
            </button>
            <span className="toolbar-count">{nodes.length} 节点</span>
          </Panel>
        </ReactFlow>
      </div>
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
