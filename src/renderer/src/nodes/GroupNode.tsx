import { memo, useContext, useState } from 'react'
import { useReactFlow, useStore, type Node, type NodeProps } from '@xyflow/react'
import { TmuxContext, RequestDeleteContext } from '../identity-context'

export type GroupNodeT = Node<{ title: string; collapsed?: boolean }, 'group'>

/* 组状态取组内最高优先级 error > attention > running > idle
   —— 缩到全景时一个色块就要说清"这组里最糟的情况是什么" */
const COLLAPSED_H = 46

function GroupNodeImpl({ id, data }: NodeProps<GroupNodeT>): React.JSX.Element {
  const { setNodes, getNodes } = useReactFlow()
  const [bcast, setBcast] = useState<string | null>(null)
  const tmuxOk = useContext(TmuxContext)
  const requestDelete = useContext(RequestDeleteContext)

  // 聚合子节点状态（返回字符串保证 selector 相等性）
  const counts = useStore((s) => {
    const c: Record<string, number> = { running: 0, attention: 0, error: 0, idle: 0 }
    let total = 0
    for (const n of s.nodes) {
      if (n.parentId !== id) continue
      total++
      const st = String((n.data as { status?: string }).status ?? 'idle')
      if (st in c) c[st]++
    }
    return `${total}|${c.running}|${c.attention}|${c.error}`
  })
  const [total, running, attention, error] = counts.split('|').map(Number)
  const worst = error > 0 ? 'error' : attention > 0 ? 'attention' : running > 0 ? 'running' : 'idle'

  const kids = (): Node[] => getNodes().filter((n) => n.parentId === id)
  const terms = (): Node[] => kids().filter((n) => n.type === 'terminal')

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
                hidden: false,
                position: {
                  x: g.position.x + n.position.x,
                  y: g.position.y + n.position.y
                }
              }
            : n
        )
    })
  }

  /**
   * 折叠：子节点 hidden → React Flow 不再渲染 → TerminalNode cleanup 释放 PTY 客户端。
   * 只有存在 tmux 会话时里面的进程才活得下来；**没有 tmux 时折叠就是把进程杀了**，
   * 所以无 tmux 一律禁用折叠（按钮置灰并说明原因）。
   */
  const toggleCollapse = (): void => {
    if (!tmuxOk) return
    const next = !data.collapsed
    setNodes((ns) => {
      // 展开时按子节点实际范围回算高度，不用额外存旧高度
      const extent = ns.reduce(
        (m, n) => (n.parentId === id ? Math.max(m, n.position.y + (n.height ?? 380)) : m),
        0
      )
      return ns.map((n) => {
        if (n.id === id) {
          return {
            ...n,
            height: next ? COLLAPSED_H : Math.max(240, extent + 20),
            data: { ...n.data, collapsed: next }
          }
        }
        return n.parentId === id ? { ...n, hidden: next } : n
      })
    })
  }

  const closeBcast = (): void => {
    setBcast(null)
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, zIndex: undefined } : n)))
  }

  const sendBroadcast = (): void => {
    const cmd = (bcast ?? '').trim()
    const list = terms()
    if (!cmd || !list.length) return
    for (const n of list) window.termspace.write(n.id, `${cmd}\r`)
    closeBcast()
  }

  /** 批量重启：真杀会话再以相同身份/目录/预设重开（restartTick 驱动 spawn effect 重跑） */
  const restartAll = (): void => {
    const list = terms()
    if (!list.length) return
    if (
      !window.confirm(
        `重启「${data.title}」下的 ${list.length} 个终端？\n当前会话会被结束，再以相同身份、目录和启动命令重开。`
      )
    ) {
      return
    }
    for (const n of list) void window.termspace.destroy(n.id)
    setNodes((ns) =>
      ns.map((n) =>
        n.parentId === id && n.type === 'terminal'
          ? {
              ...n,
              data: {
                ...n.data,
                status: 'idle',
                restartTick: (((n.data as { restartTick?: number }).restartTick ?? 0) + 1)
              }
            }
          : n
      )
    )
  }

  return (
    <div className={`group-node group-${worst}${data.collapsed ? ' collapsed' : ''}`}>
      <div className="group-node-header">
        <button
          className="group-caret nodrag"
          disabled={!tmuxOk}
          title={
            !tmuxOk
              ? '折叠需要 tmux：没有 tmux 时子终端被隐藏即等于结束进程'
              : data.collapsed
                ? '展开集群'
                : '折叠集群（tmux 会话保持存活）'
          }
          onClick={(e) => {
            e.stopPropagation()
            toggleCollapse()
          }}
        >
          {data.collapsed ? '▸' : '▾'}
        </button>
        <span className="group-node-title">{data.title}</span>
        <span className="group-node-counts">
          {total} 终端{running > 0 && ` · ${running} 运行`}
          {attention > 0 && ` · ${attention} 需要你`}
          {error > 0 && ` · ${error} 出错`}
        </span>
        {/* 折叠时子终端已卸载（pty 客户端不在），群发/重启会静默落空 → 直接不给按钮 */}
        {!data.collapsed && (
          <>
            <button
              className="group-act nodrag"
              title="向组内所有终端群发一条命令"
              onClick={(e) => {
                e.stopPropagation()
                const open = bcast === null
                setBcast(open ? '' : null)
                // 抬 z-index：React Flow 按 zIndex 排序渲染，不抬的话
                // 浮在组框上方的输入条会被相邻节点压住
                setNodes((ns) =>
                  ns.map((n) => (n.id === id ? { ...n, zIndex: open ? 1000 : undefined } : n))
                )
              }}
            >
              群发
            </button>
            <button
              className="group-act nodrag"
              title="结束并重开组内所有会话（保留身份/目录/启动命令）"
              onClick={(e) => {
                e.stopPropagation()
                restartAll()
              }}
            >
              重启
            </button>
          </>
        )}
        <button className="term-node-close nodrag" title="解组（终端保留）" onClick={ungroup}>
          ⊟
        </button>
        <button
          className="term-node-close nodrag"
          title="删除集群及组内全部终端（会话结束）"
          onClick={(e) => {
            e.stopPropagation()
            // 走画布统一入口：确认弹窗、撤回记录、连线一并处理都在那里
            const list = kids()
            requestDelete(
              [id, ...list.map((k) => k.id)],
              `删除集群「${data.title}」及组内 ${list.length} 个节点`
            )
          }}
        >
          ✕
        </button>
      </div>
      {/* 浮在组头**上方**：子终端节点渲染在父组之上，放组内会被整个盖住 */}
      {bcast !== null && !data.collapsed && (
        <div className="group-bcast nodrag">
          <input
            className="group-bcast-input"
            autoFocus
            value={bcast}
            placeholder="命令会被原样敲进组内每个终端并回车"
            onChange={(e) => setBcast(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendBroadcast()
              if (e.key === 'Escape') closeBcast()
            }}
            spellCheck={false}
          />
          <button className="group-act send" onClick={sendBroadcast} disabled={!bcast.trim()}>
            发送到 {terms().length} 个终端
          </button>
        </div>
      )}
    </div>
  )
}

export default memo(GroupNodeImpl)
