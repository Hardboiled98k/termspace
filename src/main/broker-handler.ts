import type { BrokerProfile, BrokerResult } from './broker'

interface BrokerSettings {
  brokers: Array<Omit<BrokerProfile, 'target'>>
}

type LedgerState = 'done' | 'failed' | 'timeout' | 'rejected'

interface LedgerMeta {
  source: string
  target: string
  task: string
  branch?: string
  classify?: (text: string) => LedgerState
}

export interface BrokerHandlerDeps {
  getSettings: () => Promise<BrokerSettings>
  getBrokerTarget: (id: string) => Promise<string | null>
  authorize: (source: string, target: string, what: string, detail: string) => Promise<boolean>
  run: (profile: BrokerProfile, payload: string) => Promise<BrokerResult>
  withLedger: (meta: LedgerMeta, run: () => Promise<string>) => Promise<string>
  branchOfNode: (source: string) => string | undefined
}

const redact = (text: string, secret: string): string =>
  secret ? text.split(secret).join('«已隐去»') : text

const DENIED = '已拒绝：'
const FAILED = '执行失败：'

/**
 * 代理连接结果 → 账本状态。
 *
 * **必须自带这一份**：`classifyDelegateResult` 认的是 `派活被拒` / `派活失败` 前缀，
 * 那是 delegate 的话术。这里的「执行失败：」「已拒绝：」一个都匹配不上，
 * 用默认分类会把**所有失败的代理调用都记成 done** —— 账本的失败优先排序
 * 对 `tb db` / `tb ssh` 整条链路静默失效。
 */
export function classifyBrokerResult(text: string): LedgerState {
  if (text.startsWith(DENIED)) return 'rejected'
  if (text.startsWith(FAILED)) return 'failed'
  return 'done'
}

/**
 * `tb db` / `tb ssh` 的主进程落点。
 *
 * 凭证先在主进程闭包内取出，再做最后一次授权；授权和 `run` 调用之间没有 await，
 * 避免授权后状态漂移，也避免为同一次操作连续弹两次窗。
 *
 * **记账从授权之前就开始**（与 `tb ask` 那条路一致：它的 withLedger 也包住了
 * delegate 内部的 authorize）。被拒的调用同样要留痕 —— "agent 想动生产库、我拦了"
 * 恰恰是这本账最该记的一条。
 */
export async function handleBroker(
  deps: BrokerHandlerDeps,
  source: string,
  kind: string,
  name: string,
  payload: string
): Promise<string> {
  /* 授权 key 必须带 kind。`db` 和 `ssh` 各有一个都叫 `prod` 的连接是完全合法的
     （`find` 就是按 name + kind 两个条件匹配的），key 只用 name 的话，
     用户给 `tb db prod` 点的那次「本次运行内不再询问」会把 `tb ssh prod` 一起放行。 */
  const profileLabel = `broker:${kind}:${name}`

  if (!source) {
    // 拿不到调用方就没法授权 —— fail-closed，且**在读连接串之前**就返回
    return `${DENIED}调用方节点未知，未获授权使用 ${profileLabel}。`
  }

  const cfg = await deps.getSettings()
  const prof = cfg.brokers.find((b) => b.name === name && b.kind === kind)
  if (!prof) {
    const avail = cfg.brokers.filter((b) => b.kind === kind).map((b) => b.name)
    return `没有名为「${name}」的${kind}连接。${avail.length ? `可用：${avail.join('、')}` : '去设置 → 代理连接里加一个。'}`
  }
  const authTarget = `${profileLabel}#${prof.id.slice(0, 8)}`

  const target = await deps.getBrokerTarget(prof.id)
  if (!target) return `连接「${name}」还没配连接串（设置 → 代理连接）`

  const safePayload = redact(payload, target)

  return deps.withLedger(
    {
      source,
      target: authTarget,
      task: safePayload.slice(0, 200),
      branch: deps.branchOfNode(source),
      classify: classifyBrokerResult
    },
    async () => {
      const ok = await deps.authorize(
        source,
        authTarget,
        '使用代理连接',
        `类型：${kind}\n连接名：${name}\n模式：${prof.readOnly ? '只读' : '可写'}\n将执行：${safePayload.slice(0, 300)}`
      )
      if (!ok) return `${DENIED}${source} 未获授权使用 ${authTarget}。`

      const r = await deps.run({ ...prof, kind: prof.kind, target }, payload)
      if (!r.ok) return `${FAILED}${redact(r.error ?? '未知错误', target)}`
      return redact(r.output || '（无输出）', target)
    }
  )
}
