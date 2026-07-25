import { memo } from 'react'
import { useReactFlow, useStore, type Node, type NodeProps } from '@xyflow/react'

export type GroupNodeT = Node<{ title: string }, 'group'>

function GroupNodeImpl({ id, data }: NodeProps<GroupNodeT>): React.JSX.Element {
  const { setNodes, getNodes, deleteElements } = useReactFlow()

  // 聚合子节点状态（返回字符串保证 selector 相等性）
  const counts = useStore((s) => {
    let running = 0
    let attention = 0
    let total = 0
    for (const n of s.nodes) {
      if (n.parentId !== id) continue
      total++
      const st = (n.data as { status?: string }).status
      if (st === 'running') running++
      else if (st === 'attention') attention++
    }
    return `${total}|${running}|${attention}`
  })
  const [total, running, attention] = counts.split('|').map(Number)

  const ungroup = (): void => {
    setNodes((ns) => {
      const g = ns.find((n) => n.id === id)
      if (!g) return ns
      return ns
        .filter((n) => n.id !== id)
        .map((n) =>
          n.parentId === id
            ? {
                ...n,
                parentId: undefined,
                extent: undefined,
                position: {
                  x: g.position.x + n.position.x,
                  y: g.position.y + n.position.y
                }
              }
            : n
        )
    })
  }

  return (
    <div className={`group-node${attention > 0 ? ' has-attention' : ''}`}>
      <div className="group-node-header">
        <span className="group-node-title">{data.title}</span>
        <span className="group-node-counts">
          {total} 终端{running > 0 && ` · ${running} 运行`}
          {attention > 0 && ` · ${attention} 需要你`}
        </span>
        <button className="term-node-close nodrag" title="解组（终端保留）" onClick={ungroup}>
          ⊟
        </button>
        <button
          className="term-node-close nodrag"
          title="删除集群及组内全部终端（会话结束）"
          onClick={(e) => {
            e.stopPropagation()
            const kids = getNodes().filter((n) => n.parentId === id)
            // 一次点击结束 N 个会话且不可撤销 → 必须确认。想留终端请用左边的「解组」
            if (
              kids.length > 0 &&
              !window.confirm(`结束「${data.title}」下的 ${kids.length} 个终端？会话会被真正杀掉，无法恢复。`)
            ) {
              return
            }
            for (const k of kids) void window.termboard.destroy(k.id) // 真杀 tmux 会话
            void deleteElements({ nodes: [{ id }, ...kids.map((k) => ({ id: k.id }))] })
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

export default memo(GroupNodeImpl)
