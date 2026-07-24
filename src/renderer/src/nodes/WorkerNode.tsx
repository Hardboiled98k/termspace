import { memo } from 'react'
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

function WorkerNodeImpl({ data }: NodeProps<WorkerNodeT>): React.JSX.Element {
  const cls = stateClass(data.state)
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
    </div>
  )
}

export default memo(WorkerNodeImpl)
