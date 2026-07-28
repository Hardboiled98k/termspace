/**
 * 远程访问的 token 表。
 *
 * 原来是**一把共享 token**（文件里就一行字符串）。单用户单机时那是够的 ——
 * "轮换那把 token 就是撤销"。但一旦有第二个人：
 * **踢掉一个人 = 换 token = 把所有人一起踢掉**，而且服务端根本不知道"谁是谁"，
 * 没法做只读、没法审计、没法按人撤销。
 *
 * 所以升级成表，每条带角色和有效期。这是"多人"的地基，必须在第二个人进来**之前**落地，
 * 否则第一版就带着一个撤销不了的口子。
 *
 * 单独成文件是为了能被 `node --test` 覆盖 —— 它只依赖 fs，不碰 electron。
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeAtomic } from './write-atomic.ts'
import { existsSync } from 'node:fs'

export type RemoteRole = 'owner' | 'viewer'

export interface RemoteToken {
  token: string
  role: RemoteRole
  /** 给人看的名字（"我的 iPhone" / "给老王看一眼"） */
  label: string
  createdAt: number
  /** unix 毫秒。owner 不过期；viewer 默认给期限 —— 永不过期的分享链接是负债 */
  expiresAt?: number
}

/** viewer 链接的默认有效期。宁可让人再要一次，也不要留一条忘了收回的口子 */
export const VIEWER_TTL_MS = 24 * 60 * 60 * 1000

const newSecret = (): string => `${randomUUID()}${randomUUID()}`.replace(/-/g, '')

/**
 * 读 token 表。
 *
 * **必须能吃下老格式**（文件里一行裸 token）：用户的手机已经用那把 token 配过对了，
 * 升级后让它失效等于无声地把人踢下线。老 token 原样升格成 owner。
 */
export async function loadTokens(file: string): Promise<RemoteToken[]> {
  if (!existsSync(file)) return []
  let raw = ''
  try {
    raw = (await readFile(file, 'utf8')).trim()
  } catch {
    return []
  }
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw) as unknown
      if (!Array.isArray(arr)) return []
      return arr.filter(
        (t): t is RemoteToken =>
          !!t &&
          typeof (t as RemoteToken).token === 'string' &&
          (t as RemoteToken).token.length >= 16 &&
          ((t as RemoteToken).role === 'owner' || (t as RemoteToken).role === 'viewer')
      )
    } catch {
      return []
    }
  }
  // 老格式：一行裸 token
  if (raw.length >= 16) {
    return [{ token: raw, role: 'owner', label: '本机（升级前配对的）', createdAt: Date.now() }]
  }
  return []
}

/* **权限必须在创建那一刻就给**，不能"先写完再 chmod"：writeFile 用默认权限
   （umask 022 → 0644），到 chmod 之前那个文件是全局可读的。这张表里的 owner token
   能看所有终端、在开关允许时写入和批准 —— 同机另一个用户守着目录事件就能拿走。
   窗口只有几毫秒，但这条判据在 hooks.ts 那边已经踩过一次，不该在这里重犯。 */
async function save(file: string, list: RemoteToken[]): Promise<void> {
  await writeAtomic(file, JSON.stringify(list, null, 2), 0o600)
}

/** 保证至少有一把 owner token（首次启动 / 老文件损坏时） */
export async function ensureOwnerToken(file: string): Promise<RemoteToken[]> {
  const list = await loadTokens(file)
  if (list.some((t) => t.role === 'owner')) return list
  const next: RemoteToken[] = [
    ...list,
    { token: newSecret(), role: 'owner', label: '本机', createdAt: Date.now() }
  ]
  await save(file, next)
  return next
}

export async function issueToken(
  file: string,
  role: RemoteRole,
  label: string,
  ttlMs = role === 'viewer' ? VIEWER_TTL_MS : undefined
): Promise<{ list: RemoteToken[]; issued: RemoteToken }> {
  const list = await loadTokens(file)
  const issued: RemoteToken = {
    token: newSecret(),
    role,
    label: label.trim().slice(0, 40) || (role === 'viewer' ? '只读分享' : '本机'),
    createdAt: Date.now(),
    ...(ttlMs ? { expiresAt: Date.now() + ttlMs } : {})
  }
  const next = [...list, issued]
  await save(file, next)
  return { list: next, issued }
}

export async function revokeToken(file: string, token: string): Promise<RemoteToken[]> {
  const list = await loadTokens(file)
  const next = list.filter((t) => t.token !== token)
  /* **最后一把 owner 不许撤**：撤掉就再也连不上了（包括撤销别人的入口），
     只能删文件重来 —— 那会连手机端配对一起废掉。 */
  if (!next.some((t) => t.role === 'owner')) return list
  await save(file, next)
  return next
}

/**
 * 认证。返回命中的那条，认不出返回 null。
 *
 * 用 timingSafeEqual 逐条比。长度不同先短路 —— 这只泄漏长度，
 * 而我们发的 token 长度是固定的，没有信息量。
 */
export function matchToken(
  list: RemoteToken[],
  presented: string,
  now = Date.now()
): RemoteToken | null {
  const given = Buffer.from(presented)
  for (const t of list) {
    const buf = Buffer.from(t.token)
    if (buf.length !== given.length) continue
    if (!timingSafeEqual(buf, given)) continue
    // 过期的当不存在。**判过期要在命中之后**，否则等于告诉对方"这把 token 存在过"
    if (t.expiresAt && now > t.expiresAt) return null
    return t
  }
  return null
}

/** 渲染层可见的元数据：**绝不含 token 本身**（除了刚签发的那一次） */
export interface RemoteTokenMeta {
  label: string
  role: RemoteRole
  createdAt: number
  expiresAt?: number
  /** 前 6 位，够用户在列表里认出是哪条 */
  hint: string
}

export const toMeta = (t: RemoteToken): RemoteTokenMeta => ({
  label: t.label,
  role: t.role,
  createdAt: t.createdAt,
  ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
  hint: t.token.slice(0, 6)
})

/**
 * 给 viewer 看的画布快照。
 *
 * **默认不给终端内容，也不给绝对路径。**
 * 项目的 `cwd` 是 `/Users/<用户名>/...`，一发出去就暴露了用户名和目录结构；
 * 而这个产品的卖点（"缩到全景看颜色分布即知谁在等你"）**一个字段都不需要它们**。
 *
 * 逐字段构造，不是 spread-then-delete —— 将来给画布加字段时，
 * 默认是**不外发**而不是"忘了删就漏出去"。审批脱敏那条已经栽过一次了。
 */
export function redactBoardForViewer(board: unknown): unknown {
  const b = board as
    | {
        projects?: { id?: string; name?: string }[]
        activeProjectId?: string
        nodes?: Record<string, unknown>[]
        edges?: Record<string, unknown>[]
      }
    | null
    | undefined
  if (!b || typeof b !== 'object') return null
  return {
    // 只留 id 和名字，**不留 cwd**
    projects: (b.projects ?? []).map((p) => ({ id: p.id, name: p.name })),
    activeProjectId: b.activeProjectId,
    nodes: (b.nodes ?? []).map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      status: n.status,
      provider: n.provider,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      parentId: n.parentId,
      hidden: n.hidden
    })),
    edges: (b.edges ?? []).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind
    }))
  }
}
