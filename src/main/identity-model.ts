/**
 * 凭证持久化模型与迁移。
 *
 * 这里不依赖 Electron，测试才能真的调用迁移与 DTO 函数。最重要的边界是：
 * 渲染层只知道某个键会 set/unset，永远拿不到保存过的 value。
 */
export type EnvOp =
  | { key: string; action: 'set'; value: string }
  | { key: string; action: 'unset' }

export type EnvOpMeta = { key: string; action: EnvOp['action'] }

export interface StoredIdentity {
  id: string
  name: string
  provider: string
  envOps: EnvOp[]
}

interface LegacyIdentity {
  id: string
  name: string
  provider: string
  env?: Record<string, string>
  envOps?: EnvOp[]
}

/** 旧的空字符串本来表示删除变量；迁移时绝不能漂成 set 空串。 */
export function migrateIdentity(raw: LegacyIdentity): StoredIdentity {
  // envOps 出现前没有任何版本会同时写 env；新格式又不写 env，所以优先 envOps 不会丢掉有效旧数据。
  const envOps = Array.isArray(raw.envOps)
    ? raw.envOps
    : Object.entries(raw.env ?? {}).map(([key, value]): EnvOp =>
        value === '' ? { key, action: 'unset' } : { key, action: 'set', value }
      )
  return {
    id: raw.id,
    name: raw.name,
    provider: raw.provider,
    envOps
  }
}

/** 逐字段构造，不使用 spread/delete，避免以后新增字段时把 secret 顺手带出去。 */
export function identityMeta(i: StoredIdentity): {
  id: string
  name: string
  provider: string
  envOps: EnvOpMeta[]
} {
  return {
    id: i.id,
    name: i.name,
    provider: i.provider,
    envOps: i.envOps.map((op) => ({ key: op.key, action: op.action }))
  }
}
