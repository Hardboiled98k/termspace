/**
 * 额度的统一数据模型。
 *
 * 归属单位是**账号**，不是 provider 也不是节点 —— 见 docs/QUOTA.md。
 * 同时挂两个 codex 订阅 + 一把 API key 时，那就是三个 AccountQuota。
 */

/**
 * 采集状态。
 * 「查不到」和「用了 0%」在这里就是两个 state，UI 无从混淆 ——
 * 这个项目栽过两次静默失败，这条是防线的第一层。
 */
export type QuotaState =
  | 'ok' // 有新鲜数据
  | 'stale' // 有数据但太旧（UI 灰显 + 标时间）
  | 'unconfigured' // 没装 / 没登录 / 没填 key → 整块不渲染
  | 'unavailable' // 装了也登录了，这次拿不到（超时 / 网络 / 401）
  | 'unknown-shape' // 拿到了但字段不认识（上游改 schema）→ 绝不显示 0%

/** 一个限额窗口 */
export interface QuotaWindow {
  /** 稳定 key，如 `codex:codex:primary` */
  id: string
  label: string
  /** 0-100，保留小数（API 给 9.0，别 parseInt 掉精度） */
  usedPercent: number
  /**
   * 窗口时长（分钟）。**语义只能靠它推，永远不许按数组位置认「5h/周」** ——
   * 实测本机 codex 的 primary 是 10080min（周），按位置认就会标成 5h。
   * 缺失时这一行隐藏，不显示 0。
   */
  windowMinutes?: number
  /** unix 秒。采集器统一归一化（API 给 ISO 的自己转） */
  resetsAt?: number
  severity?: 'normal' | 'warning' | 'critical'
  /** 按模型细分的桶（codex 的 GPT-5.3-Codex-Spark 之类） */
  scopeModel?: string
  /** true → 显示 ∞，不画条 */
  unlimited?: boolean
}

/** 花钱侧。和 windows **分开显示** —— 混在一起用户必然误读 */
export interface QuotaSpend {
  label: string
  /** 最小货币单位（分）。别用浮点存钱 */
  usedMinor: number
  limitMinor?: number
  currency: string
  /** false → 显示「未开启」而不是 0 */
  enabled?: boolean
}

export interface AccountQuota {
  /** identity id；系统默认用 `system:<provider>` */
  accountId: string
  provider: string
  /** 用户起的名字，或「系统默认」 */
  name: string
  state: QuotaState
  /** 采集时刻（unix 秒）。UI 统一用它算陈旧度 */
  capturedAt: number
  /** 数据来源，悬浮提示里如实写（'官方 API' / 'rollout 快照（可能低报）'） */
  source: string
  /** 'Max 5x' / 'pro' 之类 */
  plan?: string
  /**
   * 账号邮箱。**区分两个同 provider 订阅号的唯一可靠标识** ——
   * planType 只给 'pro'，看不出 20x，两个 pro 号长得一模一样。
   */
  email?: string
  windows: QuotaWindow[]
  spend?: QuotaSpend[]
  /** state != 'ok' 时给用户的人话，**必须能指出下一步动作** */
  hint?: string
}

/** 一个采集器：一个账号一次采集。永远 resolve，绝不 reject */
export interface Collector {
  accountId: string
  provider: string
  name: string
  collect(): Promise<AccountQuota>
}

export const now = (): number => Math.floor(Date.now() / 1000)

/** 窗口时长 → 人能读的标签。**从分钟数推，不从位置推** */
export function windowLabel(mins?: number): string {
  if (!mins) return '?'
  if (mins >= 10000) return '周'
  if (mins >= 1400) return `${Math.round(mins / 1440)}天`
  if (mins >= 60) return `${Math.round(mins / 60)}h`
  return `${mins}m`
}
