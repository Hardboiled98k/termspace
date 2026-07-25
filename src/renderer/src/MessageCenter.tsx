import { useEffect, useState } from 'react'
import type { TermNode } from './nodes/TerminalNode'
import type { BoardNode, PendingApproval } from './App'

/**
 * 从终端原文里认出「1. Yes, I trust this folder」这类编号选项。
 * TUI 菜单是键盘驱动的（在 iTerm/Warp 里同样点不了），所以把选项提到这里变成可点按钮，
 * 点一下就等于敲对应数字 + 回车。
 */
function parseChoices(text: string): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*[❯>▸*]?\s*(\d{1,2})[.)、]\s+(\S.*?)\s*$/)
    if (!m) continue
    const label = m[2].slice(0, 40)
    if (out.some((o) => o.key === m[1])) continue
    out.push({ key: m[1], label })
  }
  // 只在看起来确实是选择题时才给按钮（单独一行的编号不算）
  return out.length >= 2 ? out.slice(0, 6) : []
}

/**
 * 就地作答卡片：把终端当前屏的尾部原文显示出来，用户看着内容回答。
 * 拿不到结构化审批的 attention（Claude 的编号选择、y/n 提问、裸终端等待输入）走这条。
 * 关键在于**先看见问题再回答** —— 否则就是盲按，那正是之前被否掉的做法。
 */
function AskCard({
  node,
  onFocus
}: {
  node: TermNode
  onFocus: (id: string) => void
}): React.JSX.Element {
  const [peek, setPeek] = useState('')
  const [text, setText] = useState('')

  useEffect(() => {
    let alive = true
    const pull = (): void => {
      void window.termscape.peek(node.id, 8).then((t) => {
        if (alive) setPeek(t)
      })
    }
    pull()
    const t = setInterval(pull, 2500) // 终端还在动，跟着刷新
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [node.id])

  const send = (s: string): void => {
    void window.termscape.reply(node.id, s)
    setText('')
  }
  const choices = parseChoices(peek)

  return (
    <div className="msg-card">
      <div className="msg-card-head">
        <span className="status-dot attention" />
        <span className="msg-card-title">{node.data.title}</span>
        <button className="msg-act ghost" onClick={() => onFocus(node.id)}>
          查看 →
        </button>
      </div>
      {peek && <pre className="msg-peek">{peek}</pre>}
      {choices.length > 0 && (
        <div className="msg-choices">
          {choices.map((c) => (
            <button
              key={c.key}
              className="msg-choice"
              title={`发送 ${c.key} + 回车`}
              onClick={() => send(`${c.key}\r`)}
            >
              <span className="msg-choice-key">{c.key}</span>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="msg-card-actions">
        <input
          className="msg-reply"
          value={text}
          placeholder="直接作答（回车发送）"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(`${text}\r`)
          }}
          spellCheck={false}
        />
        <button className="msg-act" title="只发一个回车（选默认项）" onClick={() => send('\r')}>
          ⏎
        </button>
        <button className="msg-act deny" title="发送 Esc（取消）" onClick={() => send('\x1b')}>
          Esc
        </button>
      </div>
    </div>
  )
}

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

  // 不自带 Panel：和额度 HUD 同属右上角栏（两个 top-right Panel 会叠在同一点上）
  return (
    <div className="msg-center">
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
          <div className="msg-title needs">
            <span className="msg-pulse" />
            {attention.length} 个等你处理
          </div>
          {attention.map((n) => (
            <AskCard key={n.id} node={n} onFocus={onFocus} />
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
    </div>
  )
}
