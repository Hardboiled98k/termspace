import { Panel } from '@xyflow/react'
import type { TermNode } from './nodes/TerminalNode'
import type { BoardNode } from './App'

/**
 * 右侧悬浮消息中心（用户想法 #3）：
 * 监控全画布，把「需要你」的 agent 浮出来，可一键聚焦/快捷应答（y / Enter / Esc），
 * 不用挨个切终端去看。运行中/集群概览也一眼可见。
 */
export function MessageCenter({
  nodes,
  onFocus,
  onQuickReply
}: {
  nodes: BoardNode[]
  onFocus: (id: string) => void
  onQuickReply: (id: string, key: string) => void
}): React.JSX.Element | null {
  const terms = nodes.filter((n): n is TermNode => n.type === 'terminal')
  const attention = terms.filter((n) => n.data.status === 'attention')
  const running = terms.filter((n) => n.data.status === 'running')
  const groups = nodes.filter((n) => n.type === 'group').length

  // 没有任何需要注意的、也没在跑 → 不打扰
  if (attention.length === 0 && running.length === 0) return null

  return (
    <Panel position="top-right" className="msg-center">
      {attention.length > 0 && (
        <div className="msg-section">
          <div className="msg-title needs">
            <span className="msg-pulse" />
            {attention.length} 个 agent 需要你
          </div>
          {attention.map((n) => (
            <div key={n.id} className="msg-card" onClick={() => onFocus(n.id)}>
              <div className="msg-card-head">
                <span className="status-dot attention" />
                <span className="msg-card-title">{n.data.title}</span>
              </div>
              <div className="msg-card-actions">
                <button
                  className="msg-act approve"
                  title="发送 y + 回车（批准）"
                  onClick={(e) => {
                    e.stopPropagation()
                    onQuickReply(n.id, 'approve')
                  }}
                >
                  批准
                </button>
                <button
                  className="msg-act"
                  title="发送回车（确认默认）"
                  onClick={(e) => {
                    e.stopPropagation()
                    onQuickReply(n.id, 'enter')
                  }}
                >
                  确认
                </button>
                <button
                  className="msg-act deny"
                  title="发送 Esc（取消）"
                  onClick={(e) => {
                    e.stopPropagation()
                    onQuickReply(n.id, 'esc')
                  }}
                >
                  取消
                </button>
                <button
                  className="msg-act ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    onFocus(n.id)
                  }}
                >
                  查看 →
                </button>
              </div>
            </div>
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
      {groups > 0 && <div className="msg-foot">{groups} 个集群 · {terms.length} 终端</div>}
    </Panel>
  )
}
