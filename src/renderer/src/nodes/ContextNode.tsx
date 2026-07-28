import { memo, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { FarChip, FAR_ZOOM, useZoom } from './FarChip'
import { usePinchZoom } from '../usePinchZoom'

/* F2：共享上下文 Hub — 编辑单一事实源文件（userData/board-context.md）
   注入路径：所有终端 env TERMBOARD_CONTEXT_FILE；
   「Claude ＋共享上下文」预设启动时 --append-system-prompt 灌入 */
export type ContextNodeT = Node<{ title: string }, 'context'>

function ContextNodeImpl({ id, selected }: NodeProps<ContextNodeT>): React.JSX.Element {
  const { deleteElements } = useReactFlow()
  const zoom = useZoom()
  /* 只接管 pinch 缩放。普通滚轮不碰 —— textarea 自己会滚。
     以前这里算过"还能不能滚，滚到头就交给画布平移"，那套滚动链已经废弃
     （见 usePinchZoom 的注释：指针在哪就滚哪）。 */
  const pinchZoom = usePinchZoom()
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef(0)
  /* 三个 ref 各堵一条**静默丢字**的路：
     `rev` —— 用户已经敲过字时，迟到的 load 不能把内容盖回去；
     `latest` —— 卸载/切项目时把最后 800ms 的输入补发出去（老写法只 clearTimeout，
                 那一段输入连同"保存中…"一起消失，用户完全看不见）；
     `saved` —— 只有"存下去的就是当前这版"才允许消 dirty，
                 否则上一次 save 的 resolve 会把仍在编辑的内容标成已保存。 */
  const rev = useRef(0)
  const latest = useRef('')
  const saved = useRef('')

  useEffect(() => {
    // alive 守卫：快速删除/重建同 id 时，迟到的 load 不能覆盖新状态
    let alive = true
    void window.termspace.loadContext(id).then((t) => {
      if (!alive) return
      setLoaded(true)
      // 加载回来之前用户就开始敲了 → 以用户的为准，别把他的字冲掉
      if (rev.current) return
      setText(t)
      latest.current = t
      saved.current = t
    })
    return () => {
      alive = false
      window.clearTimeout(timer.current)
      // 未触发的防抖保存要**补发**，不能只是丢掉
      if (latest.current !== saved.current) {
        void window.termspace.saveContext(id, latest.current)
      }
    }
  }, [id])

  const onChange = (v: string): void => {
    setText(v)
    setDirty(true)
    latest.current = v
    rev.current++
    const myRev = rev.current
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void window.termspace.saveContext(id, v).then((r) => {
        setFailed(r?.ok === false)
        if (r?.ok !== false) saved.current = v
        // 存的这版已经不是当前这版了 → 还脏着，别报"已保存"
        if (rev.current === myRev) setDirty(false)
      })
    }, 800)
  }

  if (zoom < FAR_ZOOM) {
    return (
      <div className="context-node far far-context">
        <FarChip
          zoom={zoom}
          dotClass="context"
          title="共享上下文"
          state={text.trim() ? `${text.trim().length} 字` : '空'}
        />
      </div>
    )
  }

  return (
    <div className={`context-node${selected ? ' selected' : ''}`}>
      <NodeResizer
        minWidth={320}
        minHeight={200}
        isVisible
        handleStyle={{ opacity: 0, width: 16, height: 16, border: 'none' }}
        lineStyle={{ opacity: 0, borderWidth: 8 }}
      />
      <div className="term-node-header">
        <span className="context-node-icon">✦</span>
        <span className="term-node-title">共享上下文</span>
        <span className={`status-chip ${failed ? 'error' : dirty ? 'attention' : 'idle'}`}>
          {failed ? '保存失败' : dirty ? '保存中…' : '已注入新 agent'}
        </span>
        <button
          className="term-node-close nodrag"
          title="从画布移除（内容已存盘，随时可再打开）"
          onClick={(e) => {
            e.stopPropagation()
            void deleteElements({ nodes: [{ id }] })
          }}
        >
          ✕
        </button>
      </div>
      {/* 拉线到终端 = 把这份简报注入那个 agent（可连多个 = 并联） */}
      {/* **两侧都要有 handle**。边的语义方向恒为「上下文 → 终端」，但用户从哪头
          开始拉是他的自由 —— onConnect 里那段 swap 会把反向拖拽normalize 回来。
          以前只有右侧 source，于是那段 swap **永远执行不到**：React Flow 压根
          产生不了以本节点为 target 的 connection，用户从终端拉过来什么都不会发生。 */}
      <Handle type="target" position={Position.Left} className="tb-handle ctx" />
      <Handle type="source" position={Position.Right} className="tb-handle ctx" />
      <textarea
        className="context-node-body nodrag nowheel"
        ref={pinchZoom}
        placeholder={
          loaded
            ? '写给全画布 agent 的共享上下文（markdown）：\n项目目标 / 约束 / 决策 / 术语…\n\n用「Claude ＋共享上下文」预设起的节点自动注入；\n其他终端可 cat $TERMBOARD_CONTEXT_FILE 自取。'
            : '加载中…'
        }
        value={text}
        onChange={(e) => onChange(e.currentTarget.value)}
        spellCheck={false}
      />
    </div>
  )
}

export default memo(ContextNodeImpl)
