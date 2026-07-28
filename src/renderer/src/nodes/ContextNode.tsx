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
  // 同终端的滚动链：编辑区还能滚就归它，滚到头交给画布平移
  const pinchZoom = usePinchZoom((e) => {
    const el = e.currentTarget as HTMLTextAreaElement | null
    if (!el) return false
    const canUp = el.scrollTop > 0
    const canDown = el.scrollTop + el.clientHeight < el.scrollHeight - 1
    return (e.deltaY < 0 && canUp) || (e.deltaY > 0 && canDown)
  })
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef(0)

  useEffect(() => {
    // alive 守卫：快速删除/重建同 id 时，迟到的 load 不能覆盖新状态
    let alive = true
    void window.termspace.loadContext(id).then((t) => {
      if (!alive) return
      setText(t)
      setLoaded(true)
    })
    return () => {
      alive = false
      window.clearTimeout(timer.current) // 卸载时丢弃未触发的防抖保存
    }
  }, [id])

  const onChange = (v: string): void => {
    setText(v)
    setDirty(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void window.termspace.saveContext(id, v).then((r) => {
        setFailed(r?.ok === false)
        setDirty(false)
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
