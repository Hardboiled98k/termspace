import { memo, useState } from 'react'
import type { Node, NodeProps } from '@xyflow/react'

/* F7：detached worker 卡片（cdx 引擎，只显示不持久化） */
export type WorkerNodeT = Node<
  {
    task: string
    backend: string
    model?: string
    state: string
    repo?: string
    question?: string | null
    ageS?: number
  },
  'worker'
>

const STATE_LABEL: Record<string, string> = {
  working: '干活中',
  awaiting_reply: '等你回复',
  stalled: '疑似卡死',
  failed: '失败',
  killed: '已杀',
  done: '完成'
}

const TERMINAL_STATES = new Set(['done', 'failed', 'killed'])

function stateClass(state: string): string {
  if (state === 'working') return 'running'
  if (state === 'awaiting_reply' || state === 'stalled') return 'attention'
  if (state === 'failed' || state === 'killed') return 'error'
  return 'idle'
}

function fmtAge(s?: number): string {
  if (!s && s !== 0) return ''
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

/** 从 cdx result --json 里抠出最终消息文本（字段名以 cdx.py 为准，做宽松兜底） */
function extractResult(output: string): string {
  try {
    const obj = JSON.parse(output) as Record<string, unknown>
    for (const key of ['message', 'result', 'last_message', 'output']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim()) return v
    }
    return output
  } catch {
    return output
  }
}

function WorkerNodeImpl({ data }: NodeProps<WorkerNodeT>): React.JSX.Element {
  const cls = stateClass(data.state)
  const [reply, setReply] = useState('')
  const [resultText, setResultText] = useState('')
  const [busy, setBusy] = useState(false)

  const act = async (action: 'result' | 'kill' | 'send', text?: string): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.termboard.workerAction(action, data.task, text)
      if (action === 'result') setResultText(extractResult(r.output))
      if (action === 'send') setReply('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`worker-node status-${cls}`}>
      <div className="worker-node-head">
        <span className={`identity-provider ${data.backend}`}>{data.backend}</span>
        <span className="worker-node-task">{data.task}</span>
        <span className={`status-chip ${cls === 'error' ? 'attention' : cls}`}>
          {STATE_LABEL[data.state] ?? data.state}
        </span>
      </div>
      <div className="worker-node-meta">
        {data.model && <span className="hud-node-model">{data.model}</span>}
        {data.repo && <span className="worker-node-repo">{data.repo.split('/').pop()}</span>}
        <span className="worker-node-age">{fmtAge(data.ageS)}</span>
      </div>
      {data.question && (
        <div className="worker-node-question" title={data.question}>
          ❓ {data.question}
        </div>
      )}
      {data.state === 'awaiting_reply' && (
        <div className="worker-node-reply nodrag">
          <input
            placeholder="回复 worker…"
            value={reply}
            disabled={busy}
            onChange={(e) => setReply(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reply.trim()) void act('send', reply)
            }}
          />
          <button disabled={busy || !reply.trim()} onClick={() => void act('send', reply)}>
            发送
          </button>
        </div>
      )}
      <div className="worker-node-actions nodrag">
        {TERMINAL_STATES.has(data.state) && (
          <button disabled={busy} onClick={() => void act('result')}>
            收结果
          </button>
        )}
        {!TERMINAL_STATES.has(data.state) && (
          <button className="danger" disabled={busy} onClick={() => void act('kill')}>
            杀掉
          </button>
        )}
      </div>
      {resultText && (
        <div className="worker-node-result nodrag nowheel">{resultText.slice(0, 2000)}</div>
      )}
    </div>
  )
}

export default memo(WorkerNodeImpl)
