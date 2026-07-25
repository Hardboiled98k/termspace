import { Panel } from '@xyflow/react'
import type { TermNode } from './nodes/TerminalNode'
import type { BoardNode, PendingApproval } from './App'

/**
 * 右侧悬浮消息中心：把「需要你」的 agent 浮出来，不用挨个切终端去看。
 *
 * 审批走 Claude 的 PermissionRequest hook 结构化通道 —— 卡片上直接显示**它要做什么**
 * （工具名 + 命令/路径摘要），批准/拒绝是真应答，不是往终端盲发按键。
 * 拿不到结构化审批的 attention（比如普通 Notification）只给「查看」，不给假的批准按钮。
 */
export function MessageCenter({
  nodes,
  approvals,
  onFocus,
  onDecide
}: {
  nodes: BoardNode[]
  approvals: PendingApproval[]
  onFocus: (id: string) => void
  onDecide: (id: string, allow: boolean) => void
}): React.JSX.Element | null {
  const terms = nodes.filter((n): n is TermNode => n.type === 'terminal')
  const title = (id: string): string => terms.find((t) => t.id === id)?.data.title ?? id
  const pendingIds = new Set(approvals.map((a) => a.nodeId))
  // 有结构化审批的节点单独成组；其余 attention 只提示去看
  const attention = terms.filter((n) => n.data.status === 'attention' && !pendingIds.has(n.id))
  const running = terms.filter((n) => n.data.status === 'running')
  const groups = nodes.filter((n) => n.type === 'group').length

  if (approvals.length === 0 && attention.length === 0 && running.length === 0) return null

  return (
    <Panel position="top-right" className="msg-center">
      {approvals.length > 0 && (
        <div className="msg-section">
          <div className="msg-title needs">
            <span className="msg-pulse" />
            {approvals.length} 个待批准
          </div>
          {approvals.map((a) => (
            <div key={a.id} className="msg-card" onClick={() => onFocus(a.nodeId)}>
              <div className="msg-card-head">
                <span className="status-dot attention" />
                <span className="msg-card-title">{title(a.nodeId)}</span>
                <span className="msg-tool">{a.toolName}</span>
              </div>
              <div className="msg-detail" title={a.summary}>
                {a.summary}
              </div>
              <div className="msg-card-actions">
                <button
                  className="msg-act approve"
                  title="允许这次工具调用"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDecide(a.id, true)
                  }}
                >
                  批准
                </button>
                <button
                  className="msg-act deny"
                  title="拒绝这次工具调用"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDecide(a.id, false)
                  }}
                >
                  拒绝
                </button>
                <button
                  className="msg-act ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    onFocus(a.nodeId)
                  }}
                >
                  查看 →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {attention.length > 0 && (
        <div className="msg-section">
          <div className="msg-title needs">{attention.length} 个等你处理</div>
          {attention.map((n) => (
            <button key={n.id} className="msg-run-row" onClick={() => onFocus(n.id)}>
              <span className="status-dot attention" />
              <span className="msg-card-title">{n.data.title}</span>
              <span className="msg-more">去终端 →</span>
            </button>
          ))}
        </div>
      )}
      {running.length > 0 && (
        <div className="msg-section">
          <div className="msg-title">{running.length} 个运行中</div>
          {running.slice(0, 4).map((n) => (
            <button key={n.id} className="msg-run-row" onClick={() => onFocus(n.id)}>
              <span className="status-dot running" />
              <span className="msg-card-title">{n.data.title}</span>
            </button>
          ))}
          {running.length > 4 && <span className="msg-more">+{running.length - 4}</span>}
        </div>
      )}
      {groups > 0 && (
        <div className="msg-foot">
          {groups} 个集群 · {terms.length} 终端
        </div>
      )}
    </Panel>
  )
}
