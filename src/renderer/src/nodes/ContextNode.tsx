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

/* F2：共享上下文 Hub — 编辑单一事实源文件（userData/board-context.md）
   注入路径：所有终端 env TERMBOARD_CONTEXT_FILE；
   「Claude ＋共享上下文」预设启动时 --append-system-prompt 灌入 */
export type ContextNodeT = Node<{ title: string }, 'context'>

function ContextNodeImpl({ id, selected }: NodeProps<ContextNodeT>): React.JSX.Element {
  const { deleteElements } = useReactFlow()
  const zoom = useZoom()
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const timer = useRef(0)

  useEffect(() => {
    void window.termboard.loadContext(id).then((t) => {
      setText(t)
      setLoaded(true)
    })
  }, [id])

  const onChange = (v: string): void => {
    setText(v)
    setDirty(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void window.termboard.saveContext(id, v).then(() => setDirty(false))
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
        <span className={`status-chip ${dirty ? 'attention' : 'idle'}`}>
          {dirty ? '保存中…' : '已注入新 agent'}
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
