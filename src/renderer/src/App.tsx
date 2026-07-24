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
import { IdentityContext } from './identity-context'

const nodeTypes = { terminal: TerminalNode }

const statusColor: Record<string, string> = {
  running: '#0A84FF',
  attention: '#FF9F0A',
  idle: '#48484A'
}

/* 磁盘上的工作区格式（只存布局，不存运行时状态） */
interface SavedNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  title: string
  identityId?: string
}
interface Workspace {
  nodes: SavedNode[]
  viewport?: Viewport
}

const DEFAULT_SIZE = { width: 580, height: 380 }

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
              onChange={(e) =>
                setProvider(e.currentTarget.value as IdentityMeta['provider'])
              }
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

function QuotaHUD(): React.JSX.Element | null {
  const [quota, setQuota] = useState<Quota | null>(null)
  useEffect(() => window.termboard.onQuota(setQuota), [])
  if (!quota?.five_hour && !quota?.seven_day) return null
  return (
    <Panel position="top-right" className="quota-hud">
      <span className="quota-title">Claude</span>
      {quota.five_hour && <QuotaRow label="5h" pool={quota.five_hour} />}
      {quota.seven_day && <QuotaRow label="周" pool={quota.seven_day} />}
    </Panel>
  )
}

function seedNodes(): TermNode[] {
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

function toTermNode(s: SavedNode): TermNode {
  return {
    id: s.id,
    type: 'terminal',
    position: { x: s.x, y: s.y },
    width: s.width || DEFAULT_SIZE.width,
    height: s.height || DEFAULT_SIZE.height,
    data: { title: s.title || s.id, status: 'idle', identityId: s.identityId }
  }
}

function toSaved(n: TermNode): SavedNode {
  return {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width: n.width ?? n.measured?.width ?? DEFAULT_SIZE.width,
    height: n.height ?? n.measured?.height ?? DEFAULT_SIZE.height,
    title: n.data.title,
    identityId: n.data.identityId
  }
}

function nextId(nodes: TermNode[]): string {
  const max = nodes.reduce((m, n) => {
    const num = parseInt(n.id.replace(/^t/, ''), 10)
    return Number.isFinite(num) && num > m ? num : m
  }, 0)
  return `t${max + 1}`
}

function Board(): React.JSX.Element {
  const [nodes, setNodes] = useState<TermNode[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saveTick, setSaveTick] = useState(0)
  const [identities, setIdentities] = useState<IdentityMeta[]>([])
  const [defaultIdentity, setDefaultIdentity] = useState('')
  const [showIdentities, setShowIdentities] = useState(false)

  useEffect(() => {
    void window.termboard.listIdentities().then(setIdentities)
  }, [])
  const hadSaved = useRef(false)
  const viewportRef = useRef<Viewport | null>(null)
  const { setViewport, fitView } = useReactFlow()

  // 启动恢复：有存档用存档，没有播种默认节点
  useEffect(() => {
    void window.termboard.loadWorkspace().then((raw) => {
      const ws = raw as Workspace | null
      if (ws?.nodes?.length) {
        hadSaved.current = true
        setNodes(ws.nodes.map(toTermNode))
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
        nodes: nodes.map(toSaved),
        viewport: viewportRef.current ?? undefined
      })
    }, 500)
    return () => clearTimeout(t)
  }, [nodes, saveTick, loaded])

  const onNodesChange = useCallback(
    (changes: NodeChange<TermNode>[]) =>
      setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  )

  // agent 状态事件 → 节点 glow/胶囊（兜底策略见 ARCHITECTURE-NOTES.md §3）
  useEffect(() => {
    const doneAt = new Map<string, number>()
    const lastEventAt = new Map<string, number>()

    const apply = (nodeId: string, status: TermNode['data']['status']): void => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId && n.data.status !== status
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
        // done / session(start|end reset)
        doneAt.set(e.nodeId, Date.now())
        apply(e.nodeId, 'idle')
      }
    })

    // stale-working 清扫：丢 Stop / CLI 崩溃的最后防线（30min 无事件回 idle）
    const sweep = setInterval(() => {
      const now = Date.now()
      setNodes((ns) =>
        ns.map((n) => {
          if (n.data.status === 'idle') return n
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

  const addTerminal = useCallback(() => {
    setNodes((ns) => {
      const id = nextId(ns)
      const n = ns.length
      return [
        ...ns,
        {
          id,
          type: 'terminal' as const,
          position: { x: 120 + (n % 5) * 160, y: 160 + (n % 3) * 140 },
          ...DEFAULT_SIZE,
          data: {
            title: `zsh · ${id}`,
            status: 'idle' as const,
            identityId: defaultIdentity || undefined
          }
        }
      ]
    })
  }, [defaultIdentity])

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
          nodeColor={(n) => statusColor[(n.data as { status?: string }).status ?? 'idle']}
          nodeStrokeWidth={3}
        />
        <QuotaHUD />
        <Panel position="top-left" className="toolbar">
          <span className="toolbar-title">TermBoard</span>
          <span className="toolbar-sep" />
          <button className="toolbar-btn" onClick={addTerminal}>
            ＋ 终端
          </button>
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

