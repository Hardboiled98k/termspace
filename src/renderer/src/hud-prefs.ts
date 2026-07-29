/**
 * HUD 里各区块的展开/折叠状态。
 *
 * **必须落盘**：这个面板是长期开着的，每次重启都回到默认展开等于没做折叠 ——
 * 用户折叠它就是因为嫌占地方，而"嫌占地方"不会因为重启就消失。
 *
 * 用 localStorage 而不是 settings.json：这是纯展示偏好，
 * 不值得为它多一条 IPC 往返，也不该在主进程重启时参与任何逻辑。
 */

const KEY = 'tb.hud.prefs.v1'

export interface HudPrefs {
  /** 「画布 · N 终端」那一段展开着吗 */
  board: boolean
  /** 哪几个账号卡展开着（accountId）。**默认全部精简** —— 见下 */
  accounts: string[]
}

/**
 * 默认值。
 *
 * `board: true` —— 保持原有行为，用户没要求改默认，只要求"能折叠"。
 * `accounts: []` —— **默认精简是用户明确要求的**：
 * 邮箱、「已验证登录」这类是**查证信息**，不是日常要看的；
 * 每张卡省两行，四个账号就是八行。进度条留着，那才是这个面板的看点。
 */
const DEFAULTS: HudPrefs = { board: true, accounts: [] }

export function loadHudPrefs(store: Pick<Storage, 'getItem'> = localStorage): HudPrefs {
  try {
    const raw = store.getItem(KEY)
    if (!raw) return DEFAULTS
    const v = JSON.parse(raw) as Partial<HudPrefs>
    return {
      board: typeof v.board === 'boolean' ? v.board : DEFAULTS.board,
      // 存坏了不能让整个面板炸 —— 逐字段兜底，不整份信任
      accounts: Array.isArray(v.accounts) ? v.accounts.filter((x) => typeof x === 'string') : []
    }
  } catch {
    return DEFAULTS
  }
}

export function saveHudPrefs(p: HudPrefs, store: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify(p))
  } catch {
    /* 隐私模式 / 配额满：折叠状态记不住不是错误，别让它冒泡 */
  }
}

/** 在集合里就切掉、不在就加上 */
export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}
