import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import TerminalNode, { type TermNode } from './nodes/TerminalNode'
import GroupNode, { type GroupNodeT } from './nodes/GroupNode'
import WorkerNode, { type WorkerNodeT } from './nodes/WorkerNode'
import ContextNode, { type ContextNodeT } from './nodes/ContextNode'
import BrowserNode, { type BrowserNodeT, browserViews } from './nodes/BrowserNode'
import { CredentialNode, type CredentialNodeType } from './nodes/CredentialNode'
import { IdentityContext, TmuxContext, RequestDeleteContext } from './identity-context'
import { SettingsPanel, type SettingsSection } from './SettingsPanel'
import { MessageCenter } from './MessageCenter'
import {
  IconTerminal,
  IconAgent,
  IconBrief,
  IconFit,
  IconKey,
  IconSettings,
  IconGroup,
  IconChevron,
  IconGlobe,
  IconHand,
  IconCursor
} from './Icons'

export type BoardNode =
  | TermNode
  | GroupNodeT
  | WorkerNodeT
  | ContextNodeT
  | BrowserNodeT
  | CredentialNodeType

/** 挂起中的工具审批（Claude PermissionRequest hook，主进程把那次 HTTP 请求挂着等决定） */
export interface PendingApproval {
  id: string
  nodeId: string
  toolName: string
  /** 已截断的展示用摘要 —— 完整输入只在主进程，安全判定不能用这个 */
  summary: string
  toolUseId: string
  createdAt: number
  sessionId: string
  cwd: string
  inputHash: string
  /** 规则引擎判定。只会是「转人工」或「建议拒绝」，永远没有「自动放行」 */
  verdict?: PolicyVerdict
}

/** 一次删除操作的可撤回记录 */
interface UndoEntry {
  label: string
  nodes: BoardNode[]
  edges: Edge[]
  /** nodeId → 销毁前抓到的屏幕内容（撤回时回灌，避免恢复出来是一片空白） */
  screens: Record<string, string>
  at: number
}

const nodeTypes = {
  terminal: TerminalNode,
  group: GroupNode,
  worker: WorkerNode,
  context: ContextNode,
  browser: BrowserNode,
  credential: CredentialNode
}

const statusColor: Record<string, string> = {
  running: '#0A84FF',
  attention: '#FF9F0A',
  error: '#FF453A',
  idle: '#48484A',
  group: '#2C2C2E'
}

/* 磁盘上的工作区格式（只存布局，不存运行时状态） */
interface SavedNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  title: string
  type?: 'terminal' | 'group' | 'context' | 'browser' | 'credential'
  parentId?: string
  identityId?: string
  command?: string
  provider?: string
  fontSize?: number
  cwd?: string
  url?: string
  collapsed?: boolean
}
interface SavedEdge {
  id: string
  source: string
  target: string
  kind: 'context' | 'delegate'
}
/* 项目 = 一张画布 + 一个工作目录（新终端继承它） */
interface Project {
  id: string
  name: string
  cwd: string
}
interface SavedBoard {
  nodes: SavedNode[]
  edges?: SavedEdge[]
  viewport?: Viewport
}
interface Workspace extends SavedBoard {
  // v2
  projects?: Project[]
  activeProjectId?: string
  boards?: Record<string, SavedBoard>
}

const HOME_LABEL = '默认'

function shortPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+/)?.[0]
  return home ? p.replace(home, '~') : p
}

/* 连线语义：简报→终端 = 注入上下文；终端→终端 = 派活通道（M5-p3 接 MCP） */
function edgeStyle(kind: 'context' | 'delegate'): Partial<Edge> {
  return kind === 'context'
    ? {
        animated: false,
        style: { stroke: '#BF5AF2', strokeWidth: 1.6, strokeDasharray: '5 4' },
        data: { kind }
      }
    : {
        animated: true,
        style: { stroke: '#0A84FF', strokeWidth: 1.8 },
        data: { kind }
      }
}

const DEFAULT_SIZE = { width: 580, height: 380 }
/* 成组自动排列参数 */
const GROUP_GAP = 16
const GROUP_PAD = 20
const GROUP_HEAD = 48

/* ── 额度 HUD ──────────────────────────────────────────
   归属单位是**账号**，不是 provider（见 docs/QUOTA.md）。
   同时挂两个 codex 订阅时那就是两行，绝不能混成一个数。 */

/** 超过这个岁数就明确标出来，别让用户拿旧数做决定 */
const STALE_SEC = 5 * 60

function ago(capturedAt: number): string {
  const sec = Math.max(0, Math.round(Date.now() / 1000 - capturedAt))
  const min = Math.round(sec / 60)
  return min >= 60 ? `${Math.floor(min / 60)} 小时前` : `${min} 分钟前`
}

function zoneClass(pct: number): string {
  // 对齐太极三区：🟢<60 🟡60-78 🔴>78
  return pct > 78 ? 'red' : pct > 60 ? 'yellow' : 'green'
}

function resetIn(resetsAt: number): string {
  const min = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000))
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}m`
}

function QuotaRow({ w }: { w: QuotaWindow }): React.JSX.Element {
  const pct = Math.round(w.usedPercent)
  const label = w.scopeModel ? `${w.label}·${w.scopeModel}` : w.label
  return (
    <div
      className="quota-row"
      title={`${label} 已用 ${w.usedPercent}%${w.resetsAt ? `，${resetIn(w.resetsAt)} 后重置` : ''}`}
    >
      <span className="quota-label">{label}</span>
      {w.unlimited ? (
        <span className="quota-unlimited">无限</span>
      ) : (
        <>
          <span className="quota-bar">
            <span
              className={`quota-fill ${w.severity === 'critical' ? 'red' : w.severity === 'warning' ? 'yellow' : zoneClass(pct)}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </span>
          <span className="quota-pct">{pct}%</span>
        </>
      )}
      <span className="quota-reset">{w.resetsAt ? resetIn(w.resetsAt) : ''}</span>
    </div>
  )
}

/** state 不是 ok 时 UI 上该说什么。「查不到」和「用了 0%」必须是两种东西 */
/* 三种「没数」必须用不同的话说清，别共用一句含混的"暂无数据"：
   未登录能自己修（去跑一次 login），查不到只能等，字段不认识是上游变了。
   混成一句的话，用户会对着一个能修的问题干等。 */
const STATE_NOTE: Record<string, string> = {
  unconfigured: '未登录 —— 在用这个号的终端里跑一次登录命令',
  unavailable: '⚠ 这次没取到',
  'unknown-shape': '⚠ 返回的字段不认识（对方升级了？）',
  stale: '旧快照'
}

const money = (minor: number, cur: string): string => `${(minor / 100).toFixed(2)} ${cur}`

/**
 * 花钱那一行的文案。
 * 「已花」和「余额」是两个方向相反的数，**绝不能都渲染成同一个位置的裸数字** ——
 * codex 的 credits 是余额，曾被当成上限配上假的 used=0，界面上写着「0 / 766」。
 */
function spendText(sp: QuotaSpend): string {
  if (sp.enabled === false) return '未开启'
  if (typeof sp.remainingMinor === 'number') return `剩 ${money(sp.remainingMinor, sp.currency)}`
  if (typeof sp.usedMinor === 'number') {
    const limit = sp.limitMinor ? ` / ${(sp.limitMinor / 100).toFixed(0)}` : ''
    return `${(sp.usedMinor / 100).toFixed(2)}${limit} ${sp.currency}`
  }
  return '∞'
}

/**
 * 一个账号一块。
 * `usingCount` 是「画布上有几个终端在用这个号」—— 它把"终端里用的"和"账号"连起来；
 * 0 个却仍在消耗，就说明画布之外也在用这个号（这正是最容易让人困惑的情形）。
 */
function AccountBlock({
  a,
  usingCount
}: {
  a: AccountQuota
  usingCount: number
}): React.JSX.Element | null {
  /* unconfigured 分两种，不能一刀切隐藏：
     - 自动探测的系统默认号（本机压根没装 codex）→ 隐藏，那是噪音
     - **用户自己建的凭证，或正被节点引用的号** → 必须显示
       否则「未登录」这个状态在界面上永远不存在，用户只会觉得那个号凭空消失了 */
  const userMade = !a.accountId.startsWith('system:')
  if (a.state === 'unconfigured' && !userMade && usingCount === 0) return null
  const stale = a.state === 'stale' || Date.now() / 1000 - a.capturedAt > STALE_SEC
  // 只有真拿到数了才画进度条。查不到/未登录画一根空槽 = 看着就像"用了 0%"
  const hasData = (a.state === 'ok' || a.state === 'stale') && a.windows.length > 0
  return (
    <div className={`quota-account${stale ? ' stale' : ''}`} title={`${a.source}｜${a.hint ?? ''}`}>
      <div className="quota-account-head">
        <span className={`identity-provider ${a.provider}`}>{a.provider}</span>
        <span className="quota-account-name">{a.name}</span>
        {a.plan && <span className="quota-plan">{a.plan}</span>}
        <span className={`quota-using${usingCount ? ' on' : ''}`}>{usingCount} 节点</span>
      </div>
      {/* 邮箱是区分两个同 provider 订阅号的唯一可靠标识 —— planType 都叫 'pro' */}
      {a.email && <div className="quota-email">{a.email}</div>}
      {hasData ? (
        <div className="quota-provider-rows">
          {a.windows.map((w) => (
            <QuotaRow key={w.id} w={w} />
          ))}
        </div>
      ) : (
        <div className="quota-account-note">{STATE_NOTE[a.state] ?? '暂无数据'}</div>
      )}
      {/* 花钱侧不画进度条，只给金额 —— 和上面的百分比混在一起必然被读成一回事。
          enabled:false 要显式说「未开启」，藏起来等于告诉用户"没这回事" */}
      {a.spend?.map((sp) => (
        <div key={sp.label} className="quota-row">
          <span className="quota-label">{sp.label}</span>
          <span className="quota-money">{spendText(sp)}</span>
        </div>
      ))}
      {(stale || a.hint) && (
        <div className="quota-account-note">
          {stale ? `⚠ ${ago(a.capturedAt)}的数` : ''}
          {stale && a.hint ? ' · ' : ''}
          {a.hint ?? ''}
        </div>
      )}
    </div>
  )
}

/* ── HUD：额度 + 画布概览（M4，用户想法 #1）── */
interface NodeCtx {
  pct: number
  model: string
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').slice(0, 16)
}

function BoardHUD({
  nodes,
  ctxMap,
  onFocus
}: {
  nodes: BoardNode[]
  ctxMap: Record<string, NodeCtx>
  onFocus: (id: string) => void
}): React.JSX.Element | null {
  const [quota, setQuota] = useState<AccountQuota[]>([])
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => window.termscape.onQuota(setQuota), [])

  const terms = nodes.filter((n): n is TermNode => n.type === 'terminal')
  const running = terms.filter((n) => n.data.status === 'running').length
  const attention = terms.filter((n) => n.data.status === 'attention').length
  // "agent 节点" = 有 provider / 有 context 数据 / 非空闲，最多列 6 行
  const agentRows = terms
    .filter((n) => n.data.provider || ctxMap[n.id] || n.data.status !== 'idle')
    .sort((a, b) => {
      const rank = (s: string): number => (s === 'attention' ? 0 : s === 'running' ? 1 : 2)
      return rank(a.data.status) - rank(b.data.status)
    })
  const shown = agentRows.slice(0, 6)

  /* 每个账号有几个终端在用它。没绑凭证的节点算在「系统默认」头上 ——
     这一列就是把"终端里用的"和"账号"连起来的那根线。 */
  const usingCount = (a: AccountQuota): number =>
    terms.filter((n) =>
      n.data.identityId
        ? n.data.identityId === a.accountId
        : a.accountId === `system:${n.data.provider ?? 'claude'}`
    ).length

  /* 隐藏规则和 AccountBlock 保持一致：自动探测到的、没装没登录、也没人用的系统号才藏。
     用户自己建的凭证即使未登录也要占位，否则它在界面上就是凭空消失。 */
  const accounts = quota.filter(
    (a) => a.state !== 'unconfigured' || !a.accountId.startsWith('system:') || usingCount(a) > 0
  )
  if (accounts.length === 0 && agentRows.length === 0) return null

  /* 折叠态摘要。**不能无脑取 windows 的最大值** ——
     只有花钱账号（API key）或全都查不到时，那个 Math.max 会得出 0，
     折叠条上就写着一个自信的「0%」，而真相是"根本没数据"。 */
  const withData = accounts.filter((a) => (a.state === 'ok' || a.state === 'stale') && a.windows.length)
  const broken = accounts.filter((a) => a.state === 'unavailable' || a.state === 'unknown-shape').length
  const peak = withData.length
    ? Math.max(...withData.flatMap((a) => a.windows.map((w) => Math.round(w.usedPercent))))
    : null
  const summary =
    peak !== null
      ? `${withData.every((a) => a.state === 'stale') ? '~' : ''}${peak}%`
      : broken
        ? `${broken} 个查不到`
        : ''

  return (
    <div className={`quota-hud${collapsed ? ' collapsed' : ''}`}>
      <button className="hud-toggle" onClick={() => setCollapsed((c) => !c)}>
        <span className="hud-toggle-label">
          {collapsed
            ? `${summary}${
                attention > 0 ? `${summary ? ' · ' : ''}${attention} 需要你` : running > 0 ? `${summary ? ' · ' : ''}${running} 运行` : ''
              }` || '概览'
            : '用量'}
        </span>
        <span className="hud-caret">{collapsed ? '▾' : '▴'}</span>
      </button>
      {!collapsed && (
        <>
          {accounts.length > 0 && (
            <>
              {/* 写清楚这是**账号级**的量：一个号可能同时被画布外的终端/IDE 用着，
                  所以「0 节点」不代表它不会涨 —— 这正是最容易让人困惑的地方 */}
              <span className="quota-title" title="按账号统计，含画布之外在用同一个号的进程">
                账号额度
              </span>
              {accounts.map((a) => (
                <AccountBlock key={a.accountId} a={a} usingCount={usingCount(a)} />
              ))}
            </>
          )}
          {agentRows.length > 0 && (
        <>
          <div className="hud-divider" />
          <span className="quota-title">
            画布 · {terms.length} 终端
            {running > 0 && ` · ${running} 运行`}
            {attention > 0 && ` · ${attention} 需要你`}
          </span>
          {shown.map((n) => {
            const ctx = ctxMap[n.id]
            return (
              <button
                key={n.id}
                className="hud-node-row"
                title="点击聚焦节点"
                onClick={() => onFocus(n.id)}
              >
                <span className={`status-dot ${n.data.status}`} />
                <span className="hud-node-title">{n.data.title}</span>
                {ctx && (
                  <>
                    <span className="hud-node-model">{shortModel(ctx.model)}</span>
                    <span className={`ctx-meter ${ctx.pct > 80 ? 'hot' : ctx.pct > 60 ? 'warm' : ''}`}>
                      <span className="ctx-fill" style={{ width: `${ctx.pct}%` }} />
                    </span>
                    <span className="hud-node-pct">{ctx.pct}%</span>
                  </>
                )}
              </button>
            )
          })}
          {agentRows.length > shown.length && (
            <span className="hud-more">还有 {agentRows.length - shown.length} 个…</span>
          )}
        </>
      )}
        </>
      )}
    </div>
  )
}

/* ── Identity 管理面板 ── */
function IdentityPanel({
  identities,
  onChanged
}: {
  identities: IdentityMeta[]
  onChanged: (list: IdentityMeta[]) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<IdentityMeta['provider']>('claude')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState('')

  /* 一键模板：多订阅账号是这个面板最主要的用途，但没人会自己想到
     「原来隔离靠的是 CODEX_HOME」。实测过：换目录后 `codex login status`
     确实报 Not logged in，两个号互不相干。
     末尾那条空值是**删掉**继承来的 API key —— 不删的话 CLI 会优先走按量计费，
     订阅号白开，而且账单不吭声。 */
  const fillTemplate = (kind: 'codex' | 'claude'): void => {
    const n = (identities.filter((i) => i.provider === kind).length + 1).toString()
    setProvider(kind)
    setName(`${kind === 'codex' ? 'Codex' : 'Claude'} 订阅号 ${n}`)
    setEnvText(
      kind === 'codex'
        ? `CODEX_HOME=~/.codex-acct${n}\nOPENAI_API_KEY=`
        : `CLAUDE_CONFIG_DIR=~/.claude-acct${n}\nANTHROPIC_API_KEY=`
    )
  }

  const save = async (): Promise<void> => {
    const env: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq <= 0) continue
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    if (!name.trim() || Object.keys(env).length === 0) {
      setError('名称和至少一条 KEY=VALUE 必填')
      return
    }
    try {
      onChanged(await window.termscape.upsertIdentity({ name, provider, env }))
      setName('')
      setEnvText('')
      setError('')
    } catch {
      setError('保存失败（系统加密不可用？）')
    }
  }

  return (
    <div className="settings-section">
        <h3 className="settings-h">凭证管理</h3>
        <div className="identity-list">
          {identities.length === 0 && <div className="identity-empty">还没有凭证</div>}
          {identities.map((i) => (
            <div key={i.id} className="identity-row">
              <span className={`identity-provider ${i.provider}`}>{i.provider}</span>
              {/* 就地改名。以前只能删了重建 —— 而 env 值渲染层拿不到（只有 envKeys），
                  重建就得把所有密钥重新输一遍，等于根本不能改名。 */}
              <input
                className="identity-name-edit"
                defaultValue={i.name}
                title="改个名字，回车或点别处保存"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                onBlur={async (e) => {
                  const v = e.currentTarget.value.trim()
                  if (!v || v === i.name) {
                    e.currentTarget.value = i.name
                    return
                  }
                  onChanged(await window.termscape.renameIdentity(i.id, v))
                }}
              />
              <span className="identity-keys">{i.envKeys.join(' · ')}</span>
              <button
                className="identity-del"
                onClick={async () => onChanged(await window.termscape.deleteIdentity(i.id))}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="identity-form">
          <div className="identity-form-row">
            <button className="toolbar-btn" onClick={() => fillTemplate('codex')}>
              ＋ Codex 订阅号
            </button>
            <button className="toolbar-btn" onClick={() => fillTemplate('claude')}>
              ＋ Claude 订阅号
            </button>
          </div>
          <p className="settings-note">
            <b>同一台机器上挂多个订阅账号</b>：codex 认 <code>CODEX_HOME</code>、claude 认{' '}
            <code>CLAUDE_CONFIG_DIR</code>，各指一个目录就是各自独立的登录态 ——
            两个终端节点跑同一条 <code>codex</code> 命令，登的是两个号。
            <br />
            流程：上面点模板 → 保存 → 在节点的凭证下拉里选它（会重开会话）→
            在那个终端里跑一次 <code>codex login</code>（claude 则是 <code>/login</code>）。
            以后这个节点一直是这个号。
            <br />
            写 <code>KEY=</code>（等号后留空）表示<b>删掉</b>继承来的变量。模板里默认删
            <code> OPENAI_API_KEY</code> / <code>ANTHROPIC_API_KEY</code> —— 你的 shell 里
            export 过的话，CLI 会优先走按量计费，订阅号等于白开且账单不吭声。
            值支持 <code>~/</code> 与 <code>$HOME/</code> 开头（env 不过 shell，不展开会
            真的建一个叫 <code>~</code> 的目录）。
          </p>
          <div className="identity-form-row">
            <input
              placeholder="名称（留空自动叫 codex1 / claude2…）"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <select
              value={provider}
              onChange={(e) => setProvider(e.currentTarget.value as IdentityMeta['provider'])}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="gemini">gemini</option>
              <option value="custom">custom</option>
            </select>
          </div>
          <textarea
            rows={4}
            placeholder={
              '每行一条 KEY=VALUE，例如\nCODEX_HOME=~/.codex-work\nOPENAI_API_KEY=   ← 留空 = 删掉这个变量'
            }
            value={envText}
            onChange={(e) => setEnvText(e.currentTarget.value)}
          />
          {error && <div className="identity-error">{error}</div>}
          <button className="toolbar-btn" onClick={() => void save()}>
            保存凭证（Keychain 加密）
          </button>
        </div>
    </div>
  )
}

/* ── Agent 预设面板（F6）── */
function PresetPanel({
  presets,
  identities,
  onChanged
}: {
  presets: Preset[]
  identities: IdentityMeta[]
  onChanged: (list: Preset[]) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<Preset['provider']>('claude')
  const [command, setCommand] = useState('')
  const [identityId, setIdentityId] = useState('')
  const [error, setError] = useState('')

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError('名称必填')
      return
    }
    onChanged(
      await window.termscape.upsertPreset({
        name,
        provider,
        command,
        identityId: identityId || undefined
      })
    )
    setName('')
    setCommand('')
    setIdentityId('')
    setError('')
  }

  const identityName = (id?: string): string =>
    identities.find((i) => i.id === id)?.name ?? ''

  return (
    <div className="settings-section">
        <h3 className="settings-h">Agent 节点预设</h3>
        <p className="settings-note">
          预设 = 启动命令 + 身份。工具栏「Agent」按预设一键起节点，终端落在当前项目目录。
        </p>
        <div className="identity-list">
          {presets.map((p) => (
            <div key={p.id} className="identity-row">
              <span className={`identity-provider ${p.provider}`}>{p.provider}</span>
              <span className="identity-name">{p.name}</span>
              <span className="identity-keys">
                {p.command || '(纯终端)'}
                {p.identityId ? ` @ ${identityName(p.identityId)}` : ''}
              </span>
              <button
                className="identity-del"
                onClick={async () => onChanged(await window.termscape.deletePreset(p.id))}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="identity-form">
          <div className="identity-form-row">
            <input
              placeholder="名称（如 Claude 主脑）"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <select
              value={provider}
              onChange={(e) => setProvider(e.currentTarget.value as Preset['provider'])}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="gemini">gemini</option>
              <option value="custom">custom</option>
            </select>
          </div>
          <div className="identity-form-row">
            <input
              placeholder="启动命令（如 claude --model opus）"
              value={command}
              onChange={(e) => setCommand(e.currentTarget.value)}
            />
            <select value={identityId} onChange={(e) => setIdentityId(e.currentTarget.value)}>
              <option value="">默认身份</option>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          {error && <div className="identity-error">{error}</div>}
          <button className="toolbar-btn" onClick={() => void save()}>
            保存预设
          </button>
        </div>
    </div>
  )
}

function seedNodes(): BoardNode[] {
  return [
    {
      id: 't1',
      type: 'terminal',
      position: { x: 80, y: 120 },
      ...DEFAULT_SIZE,
      data: { title: 'zsh · main', status: 'idle' }
    }
  ]
}

function fromSaved(s: SavedNode): BoardNode {
  if (s.type === 'browser') {
    return {
      id: s.id,
      type: 'browser',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { url: s.url || 'about:blank', title: s.title }
    }
  }
  if (s.type === 'context') {
    return {
      id: s.id,
      type: 'context',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { title: s.title }
    }
  }
  if (s.type === 'group') {
    return {
      id: s.id,
      type: 'group',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { title: s.title, collapsed: s.collapsed }
    }
  }
  return {
    id: s.id,
    type: 'terminal',
    position: { x: s.x, y: s.y },
    width: s.width || DEFAULT_SIZE.width,
    height: s.height || DEFAULT_SIZE.height,
    parentId: s.parentId,
    extent: s.parentId ? ('parent' as const) : undefined,
    data: {
      title: s.title || s.id,
      status: 'idle',
      identityId: s.identityId,
      command: s.command,
      provider: s.provider,
      fontSize: s.fontSize,
      cwd: s.cwd
    }
  }
}

function toSaved(n: Exclude<BoardNode, WorkerNodeT>): SavedNode {
  const base = {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width: n.width ?? n.measured?.width ?? DEFAULT_SIZE.width,
    height: n.height ?? n.measured?.height ?? DEFAULT_SIZE.height,
    title:
      n.type === 'browser'
        ? (n.data.title ?? '浏览器')
        : n.type === 'credential'
          ? (n.data.title ?? '凭证')
          : n.data.title,
    type: n.type
  }
  if (n.type === 'browser') return { ...base, url: n.data.url }
  // 折叠态要持久化：不然重开后组身还是缩着、子终端却全冒出来
  if (n.type === 'group') return { ...base, collapsed: n.data.collapsed }
  if (n.type === 'context') return base
  // 凭证节点只存"指向哪个凭证"；env 值一直在主进程加密着，画布文件里绝不出现
  if (n.type === 'credential') return { ...base, identityId: n.data.identityId }
  return {
    ...base,
    parentId: n.parentId,
    identityId: n.data.identityId,
    command: n.data.command,
    provider: n.data.provider,
    fontSize: n.data.fontSize,
    cwd: n.data.cwd
  }
}

function nextIdFrom(ids: string[], prefix: string): string {
  const max = ids.reduce((m, i) => {
    if (!i.startsWith(prefix)) return m
    const num = parseInt(i.slice(prefix.length), 10)
    return Number.isFinite(num) && num > m ? num : m
  }, 0)
  return `${prefix}${max + 1}`
}

function nextId(nodes: BoardNode[], prefix: string): string {
  return nextIdFrom(
    nodes.map((n) => n.id),
    prefix
  )
}

function Board(): React.JSX.Element {
  const [nodes, setNodes] = useState<BoardNode[]>([])
  /** 最新 nodes 的同步镜像：给那些不该因 nodes 变化而重建的 callback 用 */
  const nodesRef = useRef<BoardNode[]>([])
  nodesRef.current = nodes
  const edgesRef = useRef<Edge[]>([])
  /* 撤回栈。删终端会真杀 tmux 会话 —— 进程救不回来，但布局、配置、连线和
     最后一屏内容可以，够把"手滑删掉"从灾难降级成麻烦。 */
  const undoRef = useRef<UndoEntry[]>([])
  const [undoHint, setUndoHint] = useState<UndoEntry | null>(null)
  const hintTimer = useRef(0)
  const [edges, setEdges] = useState<Edge[]>([])
  edgesRef.current = edges
  const [loaded, setLoaded] = useState(false)
  const [saveTick, setSaveTick] = useState(0)
  // 落盘失败必须让用户看见：静默失败 = 用户以为存好了，关掉就没了
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // 一次性提示（审批失效等）
  const [notice, setNotice] = useState<string | null>(null)
  /** 挂起中的工具审批（来自 Claude PermissionRequest hook，主进程把请求挂着） */
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  useEffect(() => window.termscape.onApprovals(setApprovals), [])
  const [identities, setIdentities] = useState<IdentityMeta[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [defaultIdentity, setDefaultIdentity] = useState('')
  const [defaultFontSize, setDefaultFontSize] = useState(13)
  /** tmux 可用与否决定集群能不能折叠（无 tmux 时隐藏子节点 = 杀进程） */
  const [tmuxOk, setTmuxOk] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(
    // 自检截图模式下直接展开设置面板
    new URLSearchParams(location.search).get('panel') as SettingsSection | null
  )
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    nodeId?: string
    selection?: boolean
    edgeId?: string
  } | null>(null)
  const [mapActive, setMapActive] = useState(false)
  const [canvasMode, setCanvasMode] = useState<'pan' | 'select'>('pan')
  const mapTimer = useRef(0)
  const [ctxMap, setCtxMap] = useState<Record<string, NodeCtx>>({})
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState('')
  // 非活跃项目的画布（终端不销毁 pty，tmux 会话续存，切回来自动 attach）
  const boardsRef = useRef<Record<string, SavedBoard>>({})
  const hadSaved = useRef(false)
  const viewportRef = useRef<Viewport | null>(null)
  const { setViewport, fitView } = useReactFlow()

  // HUD 画布概览用：收集各节点 context 用量（事件只在变化时来，频率低）
  useEffect(
    () =>
      window.termscape.onAgentContext((e) => {
        setCtxMap((m) => ({ ...m, [e.nodeId]: { pct: e.usedPercent, model: e.model } }))
      }),
    []
  )

  const focusNode = useCallback(
    (id: string) => {
      void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1 })
    },
    [fitView]
  )

  // 审批应答：走 Claude 的 PermissionRequest 结构化通道（主进程把那次 hook 请求挂着等这一下），
  // 不再往 pty 盲写 y —— 盲写没法保证落在正确的提示上。
  const decideApproval = useCallback((id: string, allow: boolean) => {
    void window.termscape.decideApproval(id, allow).then((r) => {
      if (!r.ok) setNotice(r.error ?? '应答失败')
    })
  }, [])

  // F7：cdx worker 状态 → 卡片节点（upsert 保留用户拖过的位置；不持久化）
  useEffect(
    () =>
      window.termscape.onWorkers((rows) => {
        setNodes((ns) => {
          const existing = new Map(
            ns.filter((n) => n.type === 'worker').map((n) => [n.id, n])
          )
          const others = ns.filter((n) => n.type !== 'worker')
          // 新卡片放到现有内容右侧一列
          const baseX =
            others.length > 0
              ? Math.max(...others.map((n) => n.position.x + (n.width ?? 580))) + 80
              : 80
          let placed = 0
          const workers: BoardNode[] = rows.map((r) => {
            const id = `w:${r.task}`
            const prev = existing.get(id)
            const data = {
              task: r.task,
              backend: r.backend,
              model: r.model,
              state: r.state,
              repo: r.repo,
              question: r.question,
              ageS: r.age_s
            }
            if (prev) return { ...prev, data } as BoardNode
            return {
              id,
              type: 'worker' as const,
              position: { x: baseX, y: 80 + placed++ * 170 },
              width: 280, // 高度随内容自适应（回复框/结果区会展开）
              data
            }
          })
          return [...others, ...workers]
        })
      }),
    []
  )

  useEffect(() => {
    void window.termscape.listIdentities().then(setIdentities)
    void window.termscape.listPresets().then(setPresets)
    void window.termscape.getSettings().then((s) => {
      const cfg = s as { defaultFontSize?: number; tmuxEnabled?: boolean } | null
      if (typeof cfg?.defaultFontSize === 'number' && cfg.defaultFontSize > 0) {
        setDefaultFontSize(cfg.defaultFontSize)
      }
      // 设置里开着还不够，本机得真装了 tmux
      void window.termscape.doctor().then((items) => {
        const tmux = items.find((d) => d.key === 'tmux')
        setTmuxOk(!!cfg?.tmuxEnabled && !!tmux?.ok)
      })
    })
  }, [])

  const applyBoard = useCallback(
    (b: SavedBoard | undefined) => {
      // 折叠的组：子节点 hidden 不进磁盘（那是派生状态），加载时按父组重算
      const collapsedGroups = new Set(
        (b?.nodes ?? []).filter((n) => n.type === 'group' && n.collapsed).map((n) => n.id)
      )
      setNodes(
        (b?.nodes ?? [])
          .map(fromSaved)
          .map((n) =>
            n.parentId && collapsedGroups.has(n.parentId) ? { ...n, hidden: true } : n
          )
      )
      setEdges(
        (b?.edges ?? []).map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          ...edgeStyle(e.kind)
        }))
      )
      viewportRef.current = b?.viewport ?? null
      if (b?.viewport) void setViewport(b.viewport)
      else setTimeout(() => void fitView({ padding: 0.25, maxZoom: 1 }), 60)
    },
    [setViewport, fitView]
  )

  // 启动恢复（含 v1 单画布 → v2 多项目迁移）
  useEffect(() => {
    let reapTimer = 0
    void window.termscape.loadWorkspace().then((raw) => {
      const ws = raw as Workspace | null
      let projs = ws?.projects
      let boards = ws?.boards
      let active = ws?.activeProjectId

      if (!projs?.length) {
        // v1 迁移：老画布收编成「默认」项目
        const def: Project = { id: 'p1', name: HOME_LABEL, cwd: '' }
        projs = [def]
        boards = {
          p1: {
            nodes:
              ws?.nodes ??
              seedNodes()
                .filter((n): n is Exclude<BoardNode, WorkerNodeT> => n.type !== 'worker')
                .map(toSaved),
            edges: ws?.edges,
            viewport: ws?.viewport
          }
        }
        active = 'p1'
      }
      hadSaved.current = true
      boardsRef.current = boards ?? {}
      setProjects(projs)
      const act = active && projs.some((p) => p.id === active) ? active : projs[0].id
      setActiveProject(act)
      applyBoard(boardsRef.current[act])
      setLoaded(true)
      // 清理孤儿 tmux 会话：全工作区所有项目的节点 id 都保留，其余杀掉。
      // 只在**确实读到**工作区时做 —— 读不到（首次启动 / 文件损坏）时 known 里只有种子节点，
      // reap 会把用户全部真会话当孤儿杀光，和 workspace 损坏组成连环丢数据。
      if (raw) {
        const known = Object.values(boardsRef.current).flatMap((b) => b.nodes.map((n) => n.id))
        // 延迟 5s，等活跃画布节点 spawn 完（它们也在 ptys 里被保护）
        reapTimer = window.setTimeout(() => void window.termscape.reapSessions(known), 5000)
      }
    })
    return () => window.clearTimeout(reapTimer)
  }, [applyBoard])

  // 当前画布快照（worker 卡片是运行时投影，不持久化）
  const snapshot = useCallback(
    (): SavedBoard => ({
      nodes: nodes
        .filter((n): n is Exclude<BoardNode, WorkerNodeT> => n.type !== 'worker')
        .map(toSaved),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        kind: (e.data?.kind as 'context' | 'delegate') ?? 'delegate'
      })),
      viewport: viewportRef.current ?? undefined
    }),
    [nodes, edges]
  )

  // 防抖落盘：当前画布写回所属项目，整个工作区一起存
  useEffect(() => {
    if (!loaded || !activeProject) return
    const t = setTimeout(() => {
      boardsRef.current[activeProject] = snapshot()
      void window.termscape
        .saveWorkspace({
          projects,
          activeProjectId: activeProject,
          boards: boardsRef.current
        })
        .then((r) => setSaveErr(r?.ok === false ? (r.error ?? '未知错误') : null))
    }, 500)
    return () => clearTimeout(t)
  }, [saveTick, loaded, activeProject, projects, snapshot])

  const switchProject = useCallback(
    (pid: string) => {
      if (pid === activeProject) return
      boardsRef.current[activeProject] = snapshot()
      setActiveProject(pid)
      applyBoard(boardsRef.current[pid])
    },
    [activeProject, snapshot, applyBoard]
  )

  const addProject = useCallback(async () => {
    const dir = await window.termscape.pickFolder()
    if (!dir) return
    const pid = `p${Date.now().toString(36)}`
    boardsRef.current[activeProject] = snapshot()
    boardsRef.current[pid] = { nodes: [], edges: [] }
    setProjects((ps) => [...ps, { id: pid, name: dir.split('/').pop() || '项目', cwd: dir }])
    setActiveProject(pid)
    applyBoard(boardsRef.current[pid])
  }, [activeProject, snapshot, applyBoard])

  const closeProject = useCallback(
    (pid: string) => {
      // 只从标签栏移除；画布记录保留（tmux 会话也还活着），重新添加同目录即恢复
      setProjects((ps) => {
        if (ps.length <= 1) return ps
        const rest = ps.filter((p) => p.id !== pid)
        if (pid === activeProject) {
          const next = rest[0].id
          setActiveProject(next)
          applyBoard(boardsRef.current[next])
        }
        return rest
      })
    },
    [activeProject, applyBoard]
  )

  const projectCwd = projects.find((p) => p.id === activeProject)?.cwd || undefined

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    []
  )

  // 连线规则：简报→终端=上下文注入；终端→终端=派活通道；终端→浏览器=允许驱动该浏览器；其余拒绝
  const onConnect = useCallback(
    (c: Connection) => {
      const src = nodes.find((n) => n.id === c.source)
      const tgt = nodes.find((n) => n.id === c.target)
      if (!src || !tgt || src.id === tgt.id) return
      /* 凭证 → 终端：这条线**不只是标注**，它会真的把该终端切到这个账号，
         而切换凭证 = 杀掉 tmux 会话重开（identityId 变更即 destroy + respawn）。
         拉一根线是很轻的手势，后果却是重启用户正在跑的活 —— 必须先确认。 */
      if (src.type === 'credential' && tgt.type === 'terminal') {
        const idn = (src.data as { identityId?: string }).identityId
        if (!idn) return
        const cred = identities.find((i) => i.id === idn)
        if (tgt.data.identityId === idn) return // 已经是它了，不用重开
        if (
          !window.confirm(
            `把「${tgt.data.title}」切到凭证「${cred?.name ?? idn}」？\n\n` +
              '会关掉这个终端当前的会话并用新账号重开，正在跑的进程会结束。\n' +
              '（凭证只负责隔离登录态，新账号第一次仍需在终端里跑一次 codex login）'
          )
        ) {
          return
        }
        // 一个终端只能有一个凭证：先摘掉指向它的旧凭证连线，再连新的
        setEdges((es) => [
          ...es.filter(
            (e) =>
              !(
                e.target === tgt.id &&
                nodesRef.current.find((n) => n.id === e.source)?.type === 'credential'
              )
          ),
          ...addEdge({ ...c, ...edgeStyle('context') }, [])
        ])
        void window.termscape.destroy(tgt.id)
        setNodes((ns) =>
          ns.map((n) =>
            n.id === tgt.id && n.type === 'terminal'
              ? { ...n, data: { ...n.data, identityId: idn } }
              : n
          )
        )
        return
      }

      let kind: 'context' | 'delegate' | null = null
      if (src.type === 'context' && tgt.type === 'terminal') kind = 'context'
      else if (src.type === 'terminal' && (tgt.type === 'terminal' || tgt.type === 'browser')) {
        kind = 'delegate'
      }
      if (!kind) return
      setEdges((es) => addEdge({ ...c, ...edgeStyle(kind) }, es))
    },
    [nodes]
  )

  /* 连线是凭证的唯一真相源之一 —— 有线连过来时把节点头部的下拉锁掉，
     否则同一件事两个入口，用户改了下拉却发现被连线覆盖，或反过来。 */
  useEffect(() => {
    const bound = new Set(
      edges
        .filter((e) => nodesRef.current.find((n) => n.id === e.source)?.type === 'credential')
        .map((e) => e.target)
    )
    setNodes((ns) => {
      let changed = false
      const next = ns.map((n) => {
        if (n.type !== 'terminal') return n
        const b = bound.has(n.id)
        if (!!n.data.credBound === b) return n
        changed = true
        return { ...n, data: { ...n.data, credBound: b } }
      })
      return changed ? next : ns
    })
  }, [edges])

  const onNodesChange = useCallback(
    (changes: NodeChange<BoardNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  )

  // agent 状态事件 → 节点 glow/胶囊（兜底策略见 ARCHITECTURE-NOTES.md §3）
  useEffect(() => {
    const doneAt = new Map<string, number>()
    const lastEventAt = new Map<string, number>()

    /* error 是进程非零退出置的，属于"这个终端已经出事了"的终态。
       迟到的 hook 事件（Stop/PostToolUse）不能把它洗回 idle/running —— 那样红框一闪就没了。
       只有明确的新一轮（SessionStart / 用户提交新 prompt）才允许覆盖。 */
    const apply = (
      nodeId: string,
      status: TermNode['data']['status'],
      canClearError = false
    ): void => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== nodeId || n.type !== 'terminal') return n
          if (n.data.status === status) return n
          if (n.data.status === 'error' && !canClearError) return n
          return { ...n, data: { ...n.data, status } }
        })
      )
    }

    const off = window.termscape.onAgentStatus((e) => {
      lastEventAt.set(e.nodeId, Date.now())
      const fresh = e.newTurn || e.event === 'SessionStart' // 新一轮才允许清 error
      if (e.state === 'working') {
        // done-holdoff 3s：并行 hook 晚到的 working 不许复活已结束的 turn
        if (!e.newTurn && Date.now() - (doneAt.get(e.nodeId) ?? 0) < 3000) return
        apply(e.nodeId, 'running', fresh)
      } else if (e.state === 'blocked' || e.state === 'waiting') {
        apply(e.nodeId, 'attention', fresh)
      } else {
        doneAt.set(e.nodeId, Date.now())
        apply(e.nodeId, 'idle', fresh)
      }
    })

    // stale-working 清扫：丢 Stop / CLI 崩溃的最后防线（30min 无事件回 idle）
    const sweep = setInterval(() => {
      const now = Date.now()
      setNodes((ns) =>
        ns.map((n) => {
          if (n.type !== 'terminal' || n.data.status === 'idle') return n
          const last = lastEventAt.get(n.id)
          return last && now - last > 30 * 60_000
            ? { ...n, data: { ...n.data, status: 'idle' as const } }
            : n
        })
      )
    }, 60_000)

    return () => {
      off()
      clearInterval(sweep)
    }
  }, [])

  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => {
    viewportRef.current = vp
    setSaveTick((t) => t + 1) // 走统一防抖保存
  }, [])

  // minimap：平移/缩放时浮现，静止 1.6s 后淡出
  const onMove = useCallback(() => {
    setMapActive(true)
    window.clearTimeout(mapTimer.current)
    mapTimer.current = window.setTimeout(() => setMapActive(false), 1600)
  }, [])

  const addTerminal = useCallback(
    (preset?: Preset) => {
      setShowAgentMenu(false)
      setNodes((ns) => {
        // id 必须全工作区唯一：它就是 tmux 会话名，跨项目撞名会串会话
        const allIds = [
          ...ns.map((n) => n.id),
          ...Object.values(boardsRef.current).flatMap((b) => b.nodes.map((n) => n.id))
        ]
        const id = nextIdFrom(allIds, 't')
        const n = ns.length
        return [
          ...ns,
          {
            id,
            type: 'terminal' as const,
            position: { x: 120 + (n % 5) * 160, y: 160 + (n % 3) * 140 },
            ...DEFAULT_SIZE,
            data: {
              title: preset ? `${preset.name} · ${id}` : `zsh · ${id}`,
              status: 'idle' as const,
              identityId: preset?.identityId || defaultIdentity || undefined,
              command: preset?.command || undefined,
              provider: preset?.provider,
              cwd: projectCwd, // 新终端落在当前项目目录
              fontSize: defaultFontSize // 设置里的默认字号（此前存了但没人读，改了不生效）
            }
          }
        ]
      })
    },
    [defaultIdentity, projectCwd, defaultFontSize]
  )

  /** 返回新节点 id：tb browser open 要靠它把「创建者即所有者」的授权落到实处 */
  const addBrowser = useCallback(
    (url?: string): string => {
      // id 在更新器外算：setNodes 的更新器不是同步跑的，拿不到返回值。
      // 同一 tick 连开两个浏览器会撞 id，但这条路径由 IPC 串行驱动，实际不会发生。
      const newId = nextId(nodesRef.current, 'b')
      setNodes((ns) => {
        if (ns.some((n) => n.id === newId)) return ns
        const n = ns.length
        return [
          ...ns,
          {
            id: newId,
            type: 'browser' as const,
            position: { x: 200 + (n % 4) * 120, y: 200 + (n % 3) * 100 },
            width: 640,
            height: 460,
            data: { url: url || 'https://www.google.com' }
          }
        ]
      })
      return newId
    },
    []
  )

  /** 凭证节点：账号在画布上的实体。同一个凭证只放一个，重复点就聚焦已有的 */
  const addCredential = useCallback((identityId: string) => {
    setNodes((ns) => {
      const existing = ns.find(
        (n) => n.type === 'credential' && n.data.identityId === identityId
      )
      if (existing) return ns.map((n) => ({ ...n, selected: n.id === existing.id }))
      const newId = nextId(ns, 'k')
      const n = ns.length
      return [
        ...ns,
        {
          id: newId,
          type: 'credential' as const,
          position: { x: 120 + (n % 4) * 60, y: 420 + (n % 3) * 80 },
          width: 220,
          height: 132,
          data: { identityId }
        }
      ]
    })
  }, [])

  // F2: 共享上下文 Hub — 无则建（一块板一个），有则聚焦。
  // id 必须带项目号：早期硬编码 'ctx-hub' 导致所有项目共用同一个磁盘文件，简报跨项目串板。
  const openContextHub = useCallback(() => {
    setNodes((ns) => {
      const existing = ns.find((n) => n.type === 'context')
      if (existing) {
        setTimeout(() => focusNode(existing.id), 0)
        return ns
      }
      return [
        ...ns,
        {
          id: `ctx-${activeProject}`,
          type: 'context' as const,
          position: { x: 40, y: 300 },
          width: 420,
          height: 320,
          data: { title: '共享上下文' }
        }
      ]
    })
  }, [focusNode, activeProject])

  // F1: 框选成组 + 自动网格排列（Shift+拖拽框选后点「成组」）
  const groupSelected = useCallback(() => {
    setNodes((ns) => {
      const sel = ns.filter(
        (n): n is TermNode => n.type === 'terminal' && !!n.selected && !n.parentId
      )
      if (sel.length < 2) return ns
      const selIds = new Set(sel.map((n) => n.id))
      const rest = ns.filter((n) => !selIds.has(n.id))
      const gid = nextId(ns, 'g')
      const cols = Math.ceil(Math.sqrt(sel.length))
      const rows = Math.ceil(sel.length / cols)
      const cellW = Math.max(...sel.map((n) => n.width ?? DEFAULT_SIZE.width))
      const cellH = Math.max(...sel.map((n) => n.height ?? DEFAULT_SIZE.height))
      const gw = GROUP_PAD * 2 + cols * cellW + (cols - 1) * GROUP_GAP
      const gh = GROUP_HEAD + GROUP_PAD + rows * cellH + (rows - 1) * GROUP_GAP + GROUP_PAD
      const minX = Math.min(...sel.map((n) => n.position.x))
      const minY = Math.min(...sel.map((n) => n.position.y))
      // 按视觉位置排序后填网格 = 整整齐齐
      const sorted = [...sel].sort(
        (a, b) => a.position.y - b.position.y || a.position.x - b.position.x
      )
      const group: GroupNodeT = {
        id: gid,
        type: 'group',
        position: { x: minX - GROUP_PAD, y: minY - GROUP_HEAD - GROUP_PAD },
        width: gw,
        height: gh,
        data: { title: `集群 ${gid.slice(1)}` }
      }
      const children = sorted.map((n, i) => ({
        ...n,
        parentId: gid,
        extent: 'parent' as const,
        selected: false,
        width: cellW,
        height: cellH,
        position: {
          x: GROUP_PAD + (i % cols) * (cellW + GROUP_GAP),
          y: GROUP_HEAD + GROUP_PAD + Math.floor(i / cols) * (cellH + GROUP_GAP)
        }
      }))
      // 父节点必须排在子节点前面（React Flow 要求）
      return [...rest, group, ...children]
    })
  }, [])

  // 所有订阅 effect 注册完之后握手：主进程收到才重推 quota/workers（防启动竞态）
  useEffect(() => {
    window.termscape.ready()
  }, [])

  // tb browser 驱动：主进程转发指令 → 操作对应 webview → 回结果
  useEffect(
    () =>
      window.termscape.onBrowserCmd(async (req) => {
        const { reqId, nodeId, action, arg } = req
        const done = (ok: boolean, result: string): void =>
          window.termscape.browserResult({ reqId, ok, result })
        // nodeId 为空 → 取第一个浏览器节点（agent 常只开一个）；
        // 但**指名了却找不到**必须报错，不能静默回退 —— 否则 goto/js 会打到另一个
        // 浏览器节点上，而那个节点里可能是用户已登录的会话。
        if (nodeId && !browserViews.has(nodeId)) {
          return done(
            false,
            `找不到浏览器节点 ${nodeId}（tb browser list 看现有节点）。已拒绝，未回退到其他节点。`
          )
        }
        const wv = nodeId
          ? (browserViews.get(nodeId) ?? null)
          : browserViews.size
            ? [...browserViews.values()][0]
            : null
        if (action === 'list') {
          return done(true, [...browserViews.keys()].join('\n') || '(画布上没有浏览器节点)')
        }
        if (action === 'open') {
          // 首行是裸 id：主进程据此把「创建者即所有者」的授权落到真实节点上，
          // agent 也能拿它做后续的 --node 参数
          const newId = addBrowser(arg)
          // 谁开的就自动连一条线：授权在画布上看得见，想撤销直接删线
          if (req.source) {
            setEdges((es) =>
              addEdge(
                {
                  source: req.source,
                  target: newId,
                  sourceHandle: null,
                  targetHandle: null,
                  ...edgeStyle('delegate')
                },
                es
              )
            )
          }
          return done(true, `${newId}\n已打开浏览器节点 ${newId}：${arg}`)
        }
        if (!wv) return done(false, '画布上没有浏览器节点，先 tb browser open <url>')
        try {
          if (action === 'goto') {
            await wv.loadURL(arg)
            return done(true, `已导航到 ${arg}`)
          }
          if (action === 'text') {
            const t = await wv.executeJavaScript('document.body.innerText')
            return done(true, String(t).slice(0, 8000))
          }
          if (action === 'js') {
            const r = await wv.executeJavaScript(arg)
            return done(true, typeof r === 'string' ? r : JSON.stringify(r ?? null))
          }
          if (action === 'shot') {
            const img = await wv.capturePage()
            // arg 为落盘路径（主进程给），data URL 转 base64 回传由主进程存文件
            return done(true, img.toDataURL())
          }
          return done(false, `未知动作 ${action}`)
        } catch (e) {
          return done(false, `执行失败：${String(e)}`)
        }
      }),
    [addBrowser]
  )

  // 把画布 agent 摘要 + 授权连线同步给主进程（tb agents / 派活 / 浏览器驱动都要用）。
  // 连线即授权：终端→终端 = 可派活，终端→浏览器 = 可驱动该浏览器。删线即撤销。
  useEffect(() => {
    window.termscape.reportAgents({
      agents: nodes
        .filter((n): n is TermNode => n.type === 'terminal')
        .map((n) => ({
          id: n.id,
          title: n.data.title,
          provider: n.data.provider,
          status: n.data.status
        })),
      links: edges
        .filter((e) => (e.data?.kind ?? 'delegate') === 'delegate')
        .map((e) => `${e.source}>${e.target}`),
      /* 上下文连线单独报：`tb context` 要按当前连线**现算**内容。
         spawn 时那份 contextNodeIds 是快照，用户改完连线不会重新传上来。 */
      ctxLinks: edges
        .filter((e) => e.data?.kind === 'context')
        .map((e) => `${e.source}>${e.target}`),
      // 现存节点全集：主进程据此撤销指向已消失节点的一次性授权（id 会被复用）
      nodeIds: nodes.filter((n) => n.type !== 'worker').map((n) => n.id),
      /* 完整画布快照，给远程 API（手机端要按同样的空间关系画出来）。
         只含布局与状态，不含任何终端内容 —— 内容走单独的 peek 接口。 */
      board: {
        projects,
        activeProjectId: activeProject,
        nodes: nodes
          .filter((n) => n.type !== 'worker')
          .map((n) => ({
            id: n.id,
            type: n.type,
            title:
              n.type === 'terminal'
                ? n.data.title
                : n.type === 'browser'
                  ? (n.data.title ?? '浏览器')
                  : n.type === 'context'
                    ? '共享上下文'
                    : n.data.title,
            status: n.type === 'terminal' ? n.data.status : undefined,
            provider: n.type === 'terminal' ? n.data.provider : undefined,
            x: n.position.x,
            y: n.position.y,
            width: n.width ?? n.measured?.width ?? 0,
            height: n.height ?? n.measured?.height ?? 0,
            parentId: n.parentId,
            hidden: !!n.hidden
          })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          kind: (e.data?.kind as string) ?? 'delegate'
        }))
      }
    })
  }, [nodes, edges, projects, activeProject])

  // 右键菜单动作
  const menuNode = menu?.nodeId ? nodes.find((n) => n.id === menu.nodeId) : undefined
  const bumpFont = useCallback(
    (delta: number) => {
      if (!menu?.nodeId) return
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== menu.nodeId || n.type !== 'terminal') return n
          const cur = n.data.fontSize ?? 13
          return { ...n, data: { ...n.data, fontSize: Math.min(24, Math.max(8, cur + delta)) } }
        })
      )
    },
    [menu]
  )
  /** 删节点必须连带删它的连线：连线就是授权图，而节点 id 会复用
      （nextIdFrom 取 max+1），留下悬空连线等于让新节点白捡旧节点的授权 */
  const dropEdgesOf = useCallback((ids: Set<string>) => {
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)))
  }, [])

  /**
   * 统一的删除入口：确认 → 收好可撤回记录 → destroy（拿回最后一屏）→ 移除节点与连线。
   * 所有删除路径都走这里，别再各写各的 —— 之前就是散在四处才漏掉了连线和子节点。
   */
  const removeNodes = useCallback(
    async (ids: string[], label: string, opts?: { skipConfirm?: boolean }): Promise<void> => {
      const gone = new Set(ids)
      const doomed = nodesRef.current.filter((n) => gone.has(n.id))
      if (!doomed.length) return
      const terms = doomed.filter((n) => n.type === 'terminal')
      if (!opts?.skipConfirm) {
        const what =
          terms.length > 0
            ? `${label}？其中 ${terms.length} 个终端的会话会被结束（跑着的进程无法恢复）。`
            : `${label}？`
        if (!window.confirm(`${what}\n\n删除后可以用 ⌘Z 撤回布局与配置。`)) return
      }
      // destroy 会返回销毁前的屏幕内容，留着撤回时回灌
      const screens: Record<string, string> = {}
      await Promise.all(
        terms.map(async (n) => {
          screens[n.id] = await window.termscape.destroy(n.id).catch(() => '')
        })
      )
      const keptEdges = edgesRef.current.filter((e) => gone.has(e.source) || gone.has(e.target))
      undoRef.current.push({ label, nodes: doomed, edges: keptEdges, screens, at: Date.now() })
      if (undoRef.current.length > 20) undoRef.current.shift()
      setNodes((ns) => ns.filter((n) => !gone.has(n.id)))
      dropEdgesOf(gone)
      setUndoHint(undoRef.current[undoRef.current.length - 1])
      window.clearTimeout(hintTimer.current)
      hintTimer.current = window.setTimeout(() => setUndoHint(null), 12_000)
    },
    [dropEdgesOf]
  )

  /** 撤回：先把屏幕内容写回快照文件，再放节点回画布（顺序反了就会先 spawn 后回灌，白屏） */
  const requestDelete = useCallback(
    (ids: string[], label: string): void => {
      void removeNodes(ids, label)
    },
    [removeNodes]
  )

  const undoDelete = useCallback(async (): Promise<void> => {
    const entry = undoRef.current.pop()
    if (!entry) return
    setUndoHint(null)
    await Promise.all(
      Object.entries(entry.screens).map(([id, text]) =>
        text ? window.termscape.seedScrollback(id, text) : Promise.resolve(false)
      )
    )
    setNodes((ns) => [...ns, ...entry.nodes.filter((n) => !ns.some((x) => x.id === n.id))])
    setEdges((es) => [...es, ...entry.edges.filter((e) => !es.some((x) => x.id === e.id))])
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        // 终端里 ⌘Z 有自己的语义，只在画布上生效
        const t = e.target as HTMLElement | null
        if (t?.closest('.term-node-body, input, textarea')) return
        e.preventDefault()
        void undoDelete()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoDelete])

  const deleteMenuNode = useCallback(() => {
    if (!menuNode) return
    const kids = nodes.filter((n) => n.parentId === menuNode.id).map((n) => n.id)
    const label =
      menuNode.type === 'group' ? `删除集群及组内 ${kids.length} 个节点` : '删除该节点'
    void removeNodes([menuNode.id, ...kids], label)
    setMenu(null)
  }, [menuNode, nodes, removeNodes])

  const selectedCount = nodes.filter(
    (n) => n.type === 'terminal' && n.selected && !n.parentId
  ).length

  return (
    <IdentityContext.Provider value={identities}>
      <TmuxContext.Provider value={tmuxOk}>
      <RequestDeleteContext.Provider value={requestDelete}>
      <div className={`h-screen w-screen mode-${canvasMode}`}>
        {settingsOpen && (
          <SettingsPanel
            initial={settingsOpen}
            onClose={() => setSettingsOpen(null)}
            renderPresets={() => (
              <PresetPanel presets={presets} identities={identities} onChanged={setPresets} />
            )}
            renderIdentities={() => (
              <IdentityPanel identities={identities} onChanged={setIdentities} />
            )}
            /* 导出取的是内存里的实时状态，不是磁盘那份 —— 磁盘那份最多落后一个 500ms 防抖周期，
               但用户点「导出」时刚拖完的节点位置就该在里面 */
            getWorkspace={() => ({
              projects,
              activeProjectId: activeProject,
              boards: { ...boardsRef.current, [activeProject]: snapshot() }
            })}
          />
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onMoveEnd={onMoveEnd}
          onMove={onMove}
          onPaneClick={() => setMenu(null)}
          onPaneContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          onNodeContextMenu={(e, n) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, nodeId: n.id })
          }}
          onSelectionContextMenu={(e) => {
            // 框选后右键：弹「成组」菜单
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, selection: true })
          }}
          onEdgeContextMenu={(e, edge) => {
            // 连线右键 → 删除。连线即授权，所以必须能撤销
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, edgeId: edge.id })
          }}
          nodeTypes={nodeTypes}
          colorMode="dark"
          minZoom={0.02} /* 真·无限：能缩到极远看全局分布 */
          translateExtent={[
            [-Infinity, -Infinity],
            [Infinity, Infinity]
          ]}
          nodeExtent={[
            [-Infinity, -Infinity],
            [Infinity, Infinity]
          ]}
          maxZoom={1.5} /* ponytail: WebGL canvas 放大是位图拉伸会糊，>1.5 不可接受；真·清晰放大需按 zoom 重设 fontSize，后续做 */
          panOnScroll
          zoomOnScroll={false}
          deleteKeyCode={null}
          panOnDrag={canvasMode === 'pan'}
          selectionOnDrag={canvasMode === 'select'}
          selectionKeyCode={canvasMode === 'pan' ? 'Shift' : null}
          edgesReconnectable={false}
          connectionLineStyle={{ stroke: '#0A84FF', strokeWidth: 2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.2}
            color="rgba(255, 255, 255, 0.22)"
            bgColor="transparent"
          />
          <Controls position="bottom-left" showInteractive={false} />
          {undoHint && !saveErr && !notice && (
            <Panel position="bottom-center" className="undo-toast">
              已{undoHint.label}
              <button
                className="undo-btn"
                onClick={() => {
                  void undoDelete()
                }}
              >
                撤回（⌘Z）
              </button>
              <button className="undo-dismiss" onClick={() => setUndoHint(null)}>
                ✕
              </button>
            </Panel>
          )}
          {(saveErr || notice) && (
            <Panel position="bottom-center" className="save-alert">
              <span className="save-alert-dot" />
              {saveErr ? `画布未能保存：${saveErr}` : notice}
              <button
                className="save-alert-retry"
                onClick={() => (saveErr ? setSaveTick((t) => t + 1) : setNotice(null))}
              >
                {saveErr ? '重试' : '知道了'}
              </button>
            </Panel>
          )}
          <Panel position="bottom-left" className="mode-switch">
            <button
              className={`mode-btn active ${canvasMode}`}
              title={
                canvasMode === 'pan'
                  ? '当前：拖拽平移（Shift 框选）· 点击切到框选'
                  : '当前：拖拽框选（空格平移）· 点击切到平移'
              }
              onClick={() => setCanvasMode((m) => (m === 'pan' ? 'select' : 'pan'))}
            >
              {canvasMode === 'pan' ? <IconHand /> : <IconCursor />}
            </button>
          </Panel>
          <MiniMap
            className={mapActive ? 'map-visible' : 'map-hidden'}
            pannable
            zoomable
            nodeColor={(n) => {
              if (n.type === 'context') return '#BF5AF2'
              if (n.type === 'browser') return '#5AC8FA'
              if (n.type === 'group') return statusColor['group']
              if (n.type === 'worker') {
                const st = (n.data as { state?: string }).state
                if (st === 'working') return statusColor['running']
                if (st === 'awaiting_reply' || st === 'stalled') return statusColor['attention']
                return statusColor['idle']
              }
              return statusColor[(n.data as { status?: string }).status ?? 'idle']
            }}
            nodeStrokeWidth={3}
          />
          {/* 右上角单一栏：额度 HUD 与消息中心竖排。两个各自的 top-right Panel
              会被绝对定位到同一点上，字直接压在一起 */}
          <Panel position="top-right" className="right-rail">
            <BoardHUD nodes={nodes} ctxMap={ctxMap} onFocus={focusNode} />
            <MessageCenter
              nodes={nodes}
              approvals={approvals}
              onFocus={focusNode}
              onDecide={decideApproval}
            />
          </Panel>
          {/* 浏览器式顶部标签条：贴顶、满宽、横向滚动 */}
          <Panel position="top-center" className="project-tabbar">
            <div className="project-tabs">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={`project-tab${p.id === activeProject ? ' active' : ''}`}
                  title={p.cwd ? shortPath(p.cwd) : '未指定目录（终端在 ~ 启动）'}
                  onClick={() => switchProject(p.id)}
                >
                  <span className="project-tab-name">{p.name}</span>
                  {p.cwd && <span className="project-tab-cwd">{shortPath(p.cwd)}</span>}
                  {projects.length > 1 && (
                    <span
                      className="project-tab-close"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeProject(p.id)
                      }}
                    >
                      ✕
                    </span>
                  )}
                </button>
              ))}
              <button className="project-tab add" title="打开项目文件夹" onClick={addProject}>
                ＋
              </button>
            </div>
          </Panel>
          <Panel position="top-left" className="board-top">
            <div className="toolbar">
            {/* 拆分按钮：最高频的「新建终端」保持一键，其余节点类型收进下拉。
                此前 4 个带文字 + 3 个纯图标混排，没有主次，视觉也乱。 */}
            <span className="agent-menu-wrap split">
              <button
                className="toolbar-btn split-main"
                title="新建终端"
                onClick={() => addTerminal()}
              >
                <IconTerminal />
                <span>新建终端</span>
              </button>
              <button
                className="toolbar-btn split-caret"
                title="新建其他节点：agent 预设 / 简报 / 浏览器"
                onClick={() => setShowAgentMenu((s) => !s)}
              >
                <IconChevron />
              </button>
              {showAgentMenu && (
                <div className="agent-menu">
                  <div className="agent-menu-label">Agent 预设</div>
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      className="agent-menu-item"
                      onClick={() => {
                        setShowAgentMenu(false)
                        addTerminal(p)
                      }}
                    >
                      <span className={`identity-provider ${p.provider}`}>{p.provider}</span>
                      {p.name}
                    </button>
                  ))}
                  <div className="ctx-menu-sep" />
                  <button
                    className="agent-menu-item"
                    onClick={() => {
                      setShowAgentMenu(false)
                      openContextHub()
                    }}
                  >
                    <IconBrief />
                    项目简报（共享上下文）
                  </button>
                  <button
                    className="agent-menu-item"
                    onClick={() => {
                      setShowAgentMenu(false)
                      addBrowser()
                    }}
                  >
                    <IconGlobe />
                    画布内浏览器
                  </button>
                  {identities.length > 0 && (
                    <>
                      <div className="ctx-menu-sep" />
                      <div className="agent-menu-label">凭证节点（连到终端 = 换账号）</div>
                      {identities.map((i) => (
                        <button
                          key={i.id}
                          className="agent-menu-item"
                          onClick={() => {
                            setShowAgentMenu(false)
                            addCredential(i.id)
                          }}
                        >
                          <span className={`identity-provider ${i.provider}`}>{i.provider}</span>
                          {i.name}
                        </button>
                      ))}
                    </>
                  )}
                  <div className="ctx-menu-sep" />
                  <button
                    className="agent-menu-item manage"
                    onClick={() => {
                      setShowAgentMenu(false)
                      setSettingsOpen('presets')
                    }}
                  >
                    管理预设…
                  </button>
                </div>
              )}
            </span>
            {selectedCount >= 2 && (
              <button className="toolbar-btn accent" onClick={groupSelected}>
                <IconGroup />
                <span>成组 {selectedCount}</span>
              </button>
            )}
            {identities.length > 0 && (
              <select
                className="identity-select"
                value={defaultIdentity}
                title="新终端使用的默认身份"
                onChange={(e) => setDefaultIdentity(e.currentTarget.value)}
              >
                <option value="">默认身份</option>
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            )}
            <span className="toolbar-sep" />
            <button
              className="toolbar-btn icon-only"
              title="缩放到全部节点"
              onClick={() => void fitView({ padding: 0.2, duration: 300 })}
            >
              <IconFit />
            </button>
            <button
              className="toolbar-btn icon-only"
              title="凭证管理"
              onClick={() => setSettingsOpen('identities')}
            >
              <IconKey />
            </button>
            <button
              className="toolbar-btn icon-only"
              title="设置"
              onClick={() => setSettingsOpen('general')}
            >
              <IconSettings />
            </button>
            <span className="toolbar-count">{nodes.length}</span>
            </div>
          </Panel>
          {menu && (
            <div
              className="ctx-menu"
              style={{ left: menu.x, top: menu.y }}
              onMouseLeave={() => setMenu(null)}
            >
              {menu.edgeId && (
                <>
                  <div className="ctx-menu-title">
                    {edges.find((e) => e.id === menu.edgeId)?.data?.kind === 'context'
                      ? '上下文注入连线'
                      : '派活 / 驱动授权连线'}
                  </div>
                  <button
                    className="ctx-menu-item danger"
                    onClick={() => {
                      setEdges((es) => es.filter((e) => e.id !== menu.edgeId))
                      setMenu(null)
                    }}
                  >
                    删除连线（撤销该授权）
                  </button>
                </>
              )}
              {menu.selection && (
                <>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      groupSelected()
                      setMenu(null)
                    }}
                  >
                    <IconGroup />
                    成组（{selectedCount}）
                  </button>
                  <button
                    className="ctx-menu-item danger"
                    onClick={() => {
                      // 选中里若有集群，子节点要一起删 —— 否则组没了、子节点还留着
                      // parentId 和 hidden:true，变成永远看不见也删不掉的孤儿
                      const selIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id))
                      const gone = nodes
                        .filter((n) => n.selected || (n.parentId && selIds.has(n.parentId)))
                        .map((n) => n.id)
                      void removeNodes(gone, `删除选中的 ${gone.length} 个节点`)
                      setMenu(null)
                    }}
                  >
                    删除选中（{selectedCount}）
                  </button>
                </>
              )}
              {!menu.nodeId && !menu.selection && !menu.edgeId && (
                <>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      addTerminal()
                      setMenu(null)
                    }}
                  >
                    <IconTerminal />
                    新建终端
                  </button>
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      className="ctx-menu-item"
                      onClick={() => {
                        addTerminal(p)
                        setMenu(null)
                      }}
                    >
                      <IconAgent />
                      新建 {p.name}
                    </button>
                  ))}
                  <div className="ctx-menu-sep" />
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      openContextHub()
                      setMenu(null)
                    }}
                  >
                    <IconBrief />
                    项目简报
                  </button>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      addBrowser()
                      setMenu(null)
                    }}
                  >
                    <IconGlobe />
                    浏览器
                  </button>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      void fitView({ padding: 0.2, duration: 300 })
                      setMenu(null)
                    }}
                  >
                    <IconFit />
                    适应全部
                  </button>
                </>
              )}
              {menu.nodeId && (
                <>
                  {menuNode?.type === 'terminal' && (
                    <>
                      <button className="ctx-menu-item" onClick={() => bumpFont(1)}>
                        字号放大
                        <span className="ctx-menu-hint">⌥滚轮</span>
                      </button>
                      <button className="ctx-menu-item" onClick={() => bumpFont(-1)}>
                        字号缩小
                        <span className="ctx-menu-hint">⌥滚轮</span>
                      </button>
                      <div className="ctx-menu-sep" />
                    </>
                  )}
                  {selectedCount >= 2 && (
                    <button
                      className="ctx-menu-item"
                      onClick={() => {
                        groupSelected()
                        setMenu(null)
                      }}
                    >
                      <IconGroup />
                      成组（{selectedCount}）
                    </button>
                  )}
                  <button className="ctx-menu-item danger" onClick={deleteMenuNode}>
                    删除
                    {menuNode?.type === 'terminal' && (
                      <span className="ctx-menu-hint">结束会话</span>
                    )}
                  </button>
                </>
              )}
            </div>
          )}
        </ReactFlow>
      </div>
      </RequestDeleteContext.Provider>
      </TmuxContext.Provider>
    </IdentityContext.Provider>
  )
}

export default function App(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <Board />
    </ReactFlowProvider>
  )
}
