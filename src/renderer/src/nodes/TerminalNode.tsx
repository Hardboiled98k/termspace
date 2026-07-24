import { memo, useEffect, useRef, useState } from 'react'
import {
  NodeResizer,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export type TermStatus = 'running' | 'idle' | 'attention'
export type TermNode = Node<{ title: string; status: TermStatus }, 'terminal'>

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
  idle: '空闲'
}

function TerminalNodeImpl({ id, data, selected }: NodeProps<TermNode>): React.JSX.Element {
  const holderRef = useRef<HTMLDivElement>(null)
  const lod = useStore((s) => s.transform[2] < LOD_ZOOM)
  const { deleteElements, updateNodeData } = useReactFlow()
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    const el = holderRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: XTERM_THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
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

    const offData = window.termboard.onData(id, (d) => term.write(d))
    const offExit = window.termboard.onExit(id, (code) =>
      term.write(`\r\n\x1b[38;5;244m[进程已退出 code=${code}]\x1b[0m\r\n`)
    )
    void window.termboard.spawn(id, term.cols, term.rows)
    const inputSub = term.onData((d) => window.termboard.write(id, d))

    let raf = 0
    const ro = new ResizeObserver(() => {
      // rAF 合帧：NodeResizer 拖拽期间每帧触发
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        fit.fit()
        window.termboard.resize(id, term.cols, term.rows)
      })
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      inputSub.dispose()
      offData()
      offExit()
      window.termboard.kill(id)
      term.dispose()
    }
  }, [id])

  return (
    <div className={`term-node status-${data.status}${selected ? ' selected' : ''}`}>
      <NodeResizer minWidth={360} minHeight={220} isVisible={selected} />
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
        <span className={`status-chip ${data.status}`}>{STATUS_LABEL[data.status]}</span>
        <button
          className="term-node-close nodrag"
          title="关闭终端（结束会话）"
          onClick={(e) => {
            e.stopPropagation()
            void deleteElements({ nodes: [{ id }] }) // unmount cleanup 会 kill pty
          }}
        >
          ✕
        </button>
      </div>
      <div
        ref={holderRef}
        className="term-node-body nodrag"
        style={{ visibility: lod ? 'hidden' : 'visible' }}
        onWheel={(e) => {
          // 普通滚轮留给终端回滚（拦住画布 pan）；
          // pinch 缩放（macOS 上是 ctrlKey+wheel）放行给画布 zoom
          if (!e.ctrlKey) e.stopPropagation()
        }}
      />
      {lod && (
        <div className="term-node-lod">
          <span className={`status-dot big ${data.status}`} />
          <span className="term-node-lod-title">{data.title}</span>
        </div>
      )}
    </div>
  )
}

export default memo(TerminalNodeImpl)
