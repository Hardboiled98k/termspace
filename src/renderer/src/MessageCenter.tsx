import { useEffect, useRef, useState } from 'react'
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
  const [err, setErr] = useState('')
  /** 抓不到当前屏就不让作答 —— 看不见问题的"回答"就是盲按，那正是被否掉的做法 */
  const blind = peek === ''

  /* 当前屏的指纹。**回答要绑定到用户真正看见的那一屏** ——
     卡片 2.5s 抓一次，点击发生在两次抓取之间：这段时间里问题可能已经答完、
     agent 可能已经退到 shell（那时写进去的就是一条命令）、也可能是新会话
     接管了同一个节点。主进程落笔前会拿这个指纹重对一次。 */
  const sig = useRef('')

  useEffect(() => {
    let alive = true
    const pull = (): void => {
      void window.termspace.peek(node.id, 8).then((r) => {
        if (!alive) return
        setPeek(r.text)
        sig.current = r.sig
      })
    }
    pull()
    const t = setInterval(pull, 2500) // 终端还在动，跟着刷新
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [node.id])

  /* 只有真写进去了才清输入框。以前无视 reply 的返回值就清 ——
     终端已经没了 / 写入失败时，用户打的字直接蒸发，屏幕上还一切正常。 */
  const send = (s: string): void => {
    void window.termspace.reply(node.id, s, sig.current).then((r) => {
      if (r.ok) {
        setText('')
        setErr('')
        return
      }
      setErr(r.error || '没能写进终端')
      // 画面变了 → 立刻拉一次新的，让用户看着新内容重新决定（输入的字保留）
      if (r.changed) {
        void window.termspace.peek(node.id, 8).then((n) => {
          setPeek(n.text)
          sig.current = n.sig
        })
      }
    })
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
      {peek ? (
        <pre className="msg-peek">{peek}</pre>
      ) : (
        <div className="msg-verdict">抓不到这个终端的当前画面，点「查看 →」去终端里直接回答</div>
      )}
      {err && <div className="msg-verdict deny">{err}</div>}
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
          disabled={blind}
          placeholder={blind ? '看不到画面，不能盲答' : '直接作答（回车发送）'}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(`${text}\r`)
          }}
          spellCheck={false}
        />
        <button
          className="msg-act"
          disabled={blind}
          title="只发一个回车（选默认项）"
          onClick={() => send('\r')}
        >
          ⏎
        </button>
        <button
          className="msg-act deny"
          disabled={blind}
          title="发送 Esc（取消）"
          onClick={() => send('\x1b')}
        >
          Esc
        </button>
      </div>
    </div>
  )
}

/**
 * 批准按钮。规则引擎建议拒绝时改成两段式 —— 第一下只是"上膛"，第二下才真批。
 *
 * 它给不了"这条是安全的"，只能给"这条明显危险"（自动放行清单是空的，见
 * approval-policy.ts）。所以这里唯一该做的就是给危险项加一道摩擦，
 * 别把它渲染成一枚让人以为已经审过的绿色对勾 —— 那才是安全感剧场。
 */
function ApproveButton({
  verdict,
  onApprove
}: {
  verdict?: PolicyVerdict
  onApprove: () => void
}): React.JSX.Element {
  const risky = verdict?.decision === 'deny'
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      /* 危险项不能长得像主操作。蓝色实心 = "推荐点这个"，
         而这里我们恰恰不推荐 —— 降级成描边样式，让「拒绝」不再是视觉上的次选 */
      className={`msg-act ${armed ? 'armed' : risky ? 'risky' : 'approve'}`}
      title={risky ? '规则引擎建议拒绝，需要点两次' : '允许这次工具调用'}
      onClick={(e) => {
        e.stopPropagation()
        if (risky && !armed) return setArmed(true)
        onApprove()
      }}
    >
      {armed ? '确定？再点一次' : risky ? '仍然批准' : '批准'}
    </button>
  )
}

/**
 * 右侧悬浮消息中心：把「需要你」的 agent 浮出来，不用挨个切终端去看。
 *
 * 审批走 Claude 的 PermissionRequest hook 结构化通道 —— 卡片上直接显示**它要做什么**
 * （工具名 + 命令/路径摘要），批准/拒绝是真应答，不是往终端盲发按键。
 * 拿不到结构化审批的 attention（比如普通 Notification）只给「查看」，不给假的批准按钮。
 */
/**
 * 任务账本卡片。
 *
 * 存在的理由不是"记录好看"，而是**人离开一小时回来要知道哪些结果可信**。
 * 所以只显示需要判断的那几条：失败/超时/被拒 + 还在跑 + 最近完成的少数几条。
 * 全量历史不在这儿翻（那是账本文件的事），这里是"回来先看这个"。
 */
function TaskCards({ onFocus }: { onFocus: (id: string) => void }): React.JSX.Element | null {
  const [rows, setRows] = useState<TaskRow[]>([])
  useEffect(() => {
    void window.termspace.listTasks().then(setRows)
    return window.termspace.onTasks(setRows)
  }, [])

  /* 只留"需要判断的" + 最近 3 条已完成。
     全都列出来的话，跑过几十次派活之后这块就没法看了 —— 而它的价值恰恰是
     "一眼扫完"。真要翻历史去看账本文件。 */
  const need = rows.filter((r) => r.state !== 'done')
  const recent = rows.filter((r) => r.state === 'done').slice(0, 3)
  const show = [...need, ...recent]
  if (!show.length) return null

  const label: Record<string, string> = {
    running: '进行中',
    done: '已完成',
    failed: '失败',
    timeout: '超时',
    rejected: '被拒'
  }
  const dot: Record<string, string> = {
    running: 'running',
    done: 'idle',
    failed: 'error',
    timeout: 'error',
    rejected: 'attention'
  }

  return (
    <div className="msg-section">
      <div className="msg-title">派活记录 · {need.length} 条待看</div>
      {show.map((r) => (
        <div className="msg-card task-card" key={r.id}>
          <div className="msg-card-head">
            <span className={`status-dot ${dot[r.state] ?? 'idle'}`} />
            <span className="msg-card-title">
              {r.source} → {r.target}
            </span>
            <span className="task-state">{label[r.state] ?? r.state}</span>
            {/* 目标是本机节点时才跳得过去；跨机的 target 形如 mini:t-x，跳不了 */}
            {!r.target.includes(':') && (
              <button className="msg-act ghost" onClick={() => onFocus(r.target)}>
                查看 →
              </button>
            )}
          </div>
          <div className="task-brief">{r.brief}</div>
          {r.branch && <div className="task-meta">⎇ {r.branch}</div>}
          {(r.result || r.error) && <div className="task-meta">{r.error ?? r.result}</div>}
        </div>
      ))}
    </div>
  )
}

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
  const [taskCount, setTaskCount] = useState(0)
  useEffect(() => {
    void window.termspace.listTasks().then((r) => setTaskCount(r.length))
    return window.termspace.onTasks((r) => setTaskCount(r.length))
  }, [])

  /* **有任务记录时也要出现**。原来只看 approvals/attention/running ——
     于是"派活刚失败、所有终端都空闲"这个最需要被看见的场景，整块面板是隐藏的。 */
  if (
    approvals.length === 0 &&
    attention.length === 0 &&
    running.length === 0 &&
    taskCount === 0
  ) {
    return null
  }

  // 不自带 Panel：和额度 HUD 同属右上角栏（两个 top-right Panel 会叠在同一点上）
  return (
    <div className="msg-center">
      <TaskCards onFocus={onFocus} />
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
              {a.verdict && (
                <div className={`msg-verdict ${a.verdict.decision}`} title={`规则 ${a.verdict.rule}`}>
                  {a.verdict.decision === 'deny' ? '建议拒绝：' : '需要你决定：'}
                  {a.verdict.reason}
                </div>
              )}
              <div className="msg-card-actions">
                <ApproveButton verdict={a.verdict} onApprove={() => onDecide(a.id, true)} />
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
