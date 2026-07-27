/**
 * 画布节点 ↔ 磁盘格式。
 *
 * 独立成文件是为了能被 `node --test` 直接跑 —— App.tsx 带着 React 和 React Flow
 * 进不去，而这里正是**已经出过事**的地方：`toSaved` 写了 `credential`，
 * `fromSaved` 却没有对应分支，于是重启后凭证节点掉进 terminal 兜底，
 * 变成一个终端，还拿着 identityId 真去 spawn 一个 pty。
 *
 * **兜底分支是 terminal，静默且危险** —— 每加一种节点类型都必须在 fromSaved 里补一支，
 * board-serde.test.ts 的 round-trip 用例会在忘记时炸掉。
 */
import type { TermNode } from './nodes/TerminalNode'
import type { GroupNodeT } from './nodes/GroupNode'
import type { WorkerNodeT } from './nodes/WorkerNode'
import type { ContextNodeT } from './nodes/ContextNode'
import type { BrowserNodeT } from './nodes/BrowserNode'
import type { CredentialNodeType } from './nodes/CredentialNode'

export type BoardNode =
  | TermNode
  | GroupNodeT
  | WorkerNodeT
  | ContextNodeT
  | BrowserNodeT
  | CredentialNodeType

export const DEFAULT_SIZE = { width: 580, height: 380 }

/** 画布上所有可持久化的节点类型。加新类型时这里和 fromSaved 都要动 */
export const SAVED_TYPES = ['terminal', 'group', 'context', 'browser', 'credential'] as const

/**
 * 主进程对 nodeId 的字符白名单。**这里必须和 src/main/index.ts 的 NODE_ID_RE 一致** ——
 * 生成一个主进程会拒收的 id，症状是终端静默起不来。
 */
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 新节点 id。**不可复用**，这是它存在的全部理由。
 *
 * 原来是 `max + 1`（`t1` `t2` …），删掉 `t7` 再建一个还叫 `t7`。而 nodeId 同时是：
 * tmux 会话名 `tb-<id>`、scrollback 快照文件名、上下文文件名、hook token 文件名、
 * pty 表的键、连线授权图的键。**id 一复用，这六条链路一起串台** ——
 * 新节点白捡旧节点的授权、回灌到别人的历史、顶着别人的身份上报。
 * 代码里为此写过四处补偿逻辑，它们的共同前提是"复用发生在删除之后"；
 * 一旦有第二个客户端，就变成"复用发生在同时"，四处全部失效。
 *
 * **没用完整 UUID**：nodeId 是用户和 agent 要念出来的东西（`tb ask <节点id> <任务>`），
 * 36 位 UUID 会让这个招牌功能变得没法用。6 位 base36 = 22 亿，
 * 单张画布撞的概率可以忽略，而 `t-7k3f9a` 还看得出是个终端。
 */
export function newNodeId(prefix: string, existing: Iterable<string> = []): string {
  const taken = new Set(existing)
  for (let i = 0; i < 50; i++) {
    const buf = new Uint32Array(2)
    crypto.getRandomValues(buf)
    const suffix = `${buf[0]!.toString(36)}${buf[1]!.toString(36)}`.slice(0, 6)
    const id = `${prefix}-${suffix}`
    // 撞了就重摇。也挡住和老 id（t1/b3/g2）重名的极端情况
    if (!taken.has(id) && NODE_ID_RE.test(id)) return id
  }
  // 50 次都撞几乎不可能；真到了就用时间戳兜底，绝不返回一个可能重复的 id
  return `${prefix}-${Date.now().toString(36)}`
}

export interface SavedNode {
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

export function fromSaved(s: SavedNode): BoardNode {
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
  /* 凭证节点。**漏了这个分支的后果不是"少一个节点"**：它会掉进下面的 terminal
     兜底，重启后凭证节点变成一个终端，还拿着 identityId 真去 spawn 一个 pty。
     每加一种节点类型都要在这里补一支 —— 兜底分支是 terminal，静默且危险。 */
  if (s.type === 'credential') {
    return {
      id: s.id,
      type: 'credential',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { identityId: s.identityId ?? '' }
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

export function toSaved(n: Exclude<BoardNode, WorkerNodeT>): SavedNode {
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
