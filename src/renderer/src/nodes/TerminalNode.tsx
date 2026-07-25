import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { IdentityContext } from '../identity-context'
import { FarChip, FAR_ZOOM } from './FarChip'
import { usePinchZoom } from '../usePinchZoom'
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export type TermStatus = 'running' | 'idle' | 'attention' | 'error'
export type TermNode = Node<
  {
    title: string
    status: TermStatus
    identityId?: string
    command?: string // agent 预设启动命令
    provider?: string
    fontSize?: number
    cwd?: string
    /** 自增即重开会话（集群批量重启用）；不持久化 */
    restartTick?: number
  },
  'terminal'
>

// 缩放低于此值 → 隐藏活终端，显示 LOD 占位（性能 + 可读性）
const LOD_ZOOM = 0.35

// macOS Terminal.app 深色系配色 + 系统色
const XTERM_THEME = {
  background: '#131315',
  foreground: '#F5F5F7',
  cursor: '#0A84FF',
  cursorAccent: '#131315',
  selectionBackground: 'rgba(10, 132, 255, 0.28)',
  black: '#2C2C2E',
  red: '#FF453A',
  green: '#30D158',
  yellow: '#FF9F0A',
  blue: '#0A84FF',
  magenta: '#BF5AF2',
  cyan: '#64D2FF',
  white: '#F5F5F7',
  brightBlack: '#636366',
  brightRed: '#FF6961',
  brightGreen: '#66E884',
  brightYellow: '#FFB340',
  brightBlue: '#409CFF',
  brightMagenta: '#DA8FFF',
  brightCyan: '#70D7FF',
  brightWhite: '#FFFFFF'
}

const STATUS_LABEL: Record<TermStatus, string> = {
  running: '运行中',
  attention: '需要你',
  idle: '空闲',
  error: '已退出'
}

const FONT_MIN = 8
const FONT_MAX = 24
const FONT_DEFAULT = 13

function TerminalNodeImpl({ id, data, selected }: NodeProps<TermNode>): React.JSX.Element {
  const holderRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const zoom = useStore((s) => s.transform[2])
  const lod = zoom < LOD_ZOOM
  const far = zoom < FAR_ZOOM
  // 连到本终端的简报节点（画布连线决定注入哪份上下文）
  const ctxIds = useStore((s) =>
    s.edges
      .filter((e) => e.target === id && e.data?.kind === 'context')
      .map((e) => e.source)
      .sort()
      .join(',')
  )
  const { deleteElements, updateNodeData } = useReactFlow()
  const identities = useContext(IdentityContext)
  const [editing, setEditing] = useState(false)
  const [ctxPct, setCtxPct] = useState<number | null>(null)
  const [fontHint, setFontHint] = useState(false)

  // per-node 订阅，避免高频 usage 更新走 setNodes 触发全画布 rerender
  useEffect(
    () =>
      window.termscape.onAgentContext((e) => {
        if (e.nodeId === id) setCtxPct(e.usedPercent)
      }),
    [id]
  )

  useEffect(() => {
    const el = holderRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: data.fontSize ?? FONT_DEFAULT,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: XTERM_THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    fitRef.current = fit
    try {
      // Chromium 每页 ~16 个 WebGL context 上限，超限最老的被强制丢弃；
      // context 丢失时 dispose addon → xterm 落回 DOM renderer 保持可用
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL 不可用 → xterm 自动落回 DOM renderer
    }
    fit.fit()

    const offData = window.termscape.onData(id, (d) => term.write(d))
    const offExit = window.termscape.onExit(id, (code) => {
      term.write(`\r\n\x1b[38;5;244m[进程已退出 code=${code}]\x1b[0m\r\n`)
      // 非零退出 = 真出事了，红边框比一行灰字显眼得多（缩到全景也看得见）
      if (code !== 0) updateNodeData(id, { status: 'error' })
    })
    void window.termscape.spawn(id, term.cols, term.rows, {
      identityId: data.identityId,
      command: data.command,
      provider: data.provider,
      contextNodeIds: ctxIds ? ctxIds.split(',') : [],
      cwd: data.cwd
    })
    const inputSub = term.onData((d) => window.termscape.write(id, d))

    // Warp 式复制粘贴：选中即可复制（⌘C），⌘V 粘贴；右键也走这套
    const onKey = term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.metaKey || e.ctrlKey)) return true
      if (e.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      if (e.key === 'v') {
        void navigator.clipboard.readText().then((t) => window.termscape.write(id, t))
        return false
      }
      return true
    })
    void onKey

    let raf = 0
    const ro = new ResizeObserver(() => {
      // rAF 合帧：NodeResizer 拖拽期间每帧触发
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        fit.fit()
        window.termscape.resize(id, term.cols, term.rows)
      })
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      inputSub.dispose()
      offData()
      offExit()
      window.termscape.kill(id)
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
    // identityId/command 变更 = 重生成会话（cleanup kill → respawn）
    // ctxIds 变更也重生成：上下文是启动时注入的
    // fontSize 故意不在依赖里：改字号只重排，不重开会话
    // restartTick 变更 = 批量重启：调用方已 destroy 掉旧会话，这里重跑即新开
  }, [id, data.identityId, data.command, data.cwd, ctxIds, data.restartTick])

  // 字号变更：改渲染 + refit + 通知 pty 新 cols/rows（会话不动）
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = data.fontSize ?? FONT_DEFAULT
    fit.fit()
    window.termscape.resize(id, term.cols, term.rows)
  }, [id, data.fontSize])

  // 字号改动时头部短暂提示当前值（⌥滚轮 / 右键菜单调节）
  const hintTimer = useRef(0)
  const stepFont = (delta: number): void => {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, (data.fontSize ?? FONT_DEFAULT) + delta))
    updateNodeData(id, { fontSize: next })
    setFontHint(true)
    window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setFontHint(false), 1200)
  }
  useEffect(() => () => window.clearTimeout(hintTimer.current), [])

  /* 内容区滚轮分流（原生 non-passive 监听，见 usePinchZoom 注释）：
     pinch → 缩放画布；⌥+滚轮 → 调字号；普通滚轮 → 留给终端回滚，拦住画布 pan */
  const attachWheel = usePinchZoom((e) => {
    if (e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      stepFont(e.deltaY < 0 ? 1 : -1)
      return
    }
    e.stopPropagation()
  })
  const setHolder = useCallback(
    (el: HTMLDivElement | null): void => {
      holderRef.current = el
      attachWheel(el)
    },
    [attachWheel]
  )

  return (
    <div
      className={`term-node status-${data.status}${selected ? ' selected' : ''}${
        far ? ` far far-${data.status}` : ''
      }`}
    >
      {/* 手柄透明：拖节点边角即可缩放，不用四个丑圆点；选中态改用发光边框表达 */}
      <NodeResizer
        minWidth={360}
        minHeight={220}
        isVisible
        handleStyle={{ opacity: 0, width: 16, height: 16, border: 'none' }}
        lineStyle={{ opacity: 0, borderWidth: 8 }}
      />
      {/* 左：接收（简报注入 / 被上游派活）；右：派活给下游 agent */}
      <Handle type="target" position={Position.Left} className="tb-handle in" />
      <Handle type="source" position={Position.Right} className="tb-handle out" />
      <div className="term-node-header">
        <span className={`status-dot ${data.status}`} />
        {editing ? (
          <input
            className="term-node-title-input nodrag"
            defaultValue={data.title}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim()
              if (v) updateNodeData(id, { title: v })
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span className="term-node-title" onDoubleClick={() => setEditing(true)}>
            {data.title}
          </span>
        )}
        {identities.length > 0 && (
          <select
            className="identity-select nodrag"
            value={data.identityId ?? ''}
            title="切换凭证会重开会话"
            onChange={(e) => {
              // 换身份 = 新 env → 必须真杀旧会话（否则 tmux -A 会接回旧 env 的会话）
              void window.termscape.destroy(id)
              updateNodeData(id, { identityId: e.currentTarget.value || undefined })
            }}
          >
            <option value="">默认身份</option>
            {identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        )}
        {fontHint && <span className="font-hint">{data.fontSize ?? FONT_DEFAULT} px</span>}
        {ctxPct !== null && (
          <span
            className={`ctx-meter ${ctxPct > 80 ? 'hot' : ctxPct > 60 ? 'warm' : ''}`}
            title={`上下文已用 ${ctxPct}%`}
          >
            <span className="ctx-fill" style={{ width: `${ctxPct}%` }} />
          </span>
        )}
        <span className={`status-chip ${data.status}`}>{STATUS_LABEL[data.status]}</span>
        <button
          className="term-node-close nodrag"
          title="关闭终端（结束会话）"
          onClick={(e) => {
            e.stopPropagation()
            void window.termscape.destroy(id) // 真杀 tmux 会话（unmount cleanup 只释放客户端）
            void deleteElements({ nodes: [{ id }] })
          }}
        >
          ✕
        </button>
      </div>
      <div
        ref={setHolder}
        className="term-node-body nodrag"
        style={{ visibility: lod ? 'hidden' : 'visible' }}
        onContextMenu={(e) => {
          // 终端内右键：有选中就复制，否则粘贴（不弹画布菜单）
          e.preventDefault()
          e.stopPropagation()
          const term = termRef.current
          if (term?.hasSelection()) {
            void navigator.clipboard.writeText(term.getSelection())
          } else {
            void navigator.clipboard.readText().then((t) => window.termscape.write(id, t))
          }
        }}
      />
      {lod && !far && (
        <div className="term-node-lod">
          <span className={`status-dot big ${data.status}`} />
          <span className="term-node-lod-title">{data.title}</span>
        </div>
      )}
      {far && (
        <FarChip
          zoom={zoom}
          dotClass={data.status}
          title={data.title}
          state={STATUS_LABEL[data.status]}
          stateClass={data.status}
          extra={ctxPct !== null ? `${ctxPct}%` : undefined}
        />
      )}
    </div>
  )
}

export default memo(TerminalNodeImpl)
