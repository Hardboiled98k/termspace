/**
 * Cmd+K 全局检索。
 *
 * 画布解决的是**态势感知**（缩到全景看颜色分布即知谁在等你），
 * 它解决不了**精确检索** —— 几十个节点、多个项目时，你仍然要缩放、拖画布、
 * 找那个短 id，再去执行动作。这两件事需要两种界面。
 *
 * 两条设计判据：
 *
 * 1. **空查询时先列「需要你」**，不是按字母序也不是按创建时间。
 *    打开 Cmd+K 最常见的意图是"谁在等我"，那应该零输入就看得见。
 * 2. **能搜的字段要覆盖用户脑子里的所有指认方式**：标题、节点 id
 *    （`tb ask` 要用它）、provider、cwd、分支名、状态。用户记得住哪个就用哪个。
 *
 * 打分不用模糊匹配库：子串命中 + 位置加权就够，而且结果可预测 ——
 * 模糊匹配会把 `t9` 匹到一堆不相干的东西上，反而更慢。
 */

export type PaletteKind = 'node' | 'project'

export interface PaletteItem {
  id: string
  kind: PaletteKind
  /** 主标题 */
  title: string
  /** 副标题（cwd / 分支 / provider 之类） */
  detail: string
  /** 排序用的紧急度：0 = 需要你，越大越不急 */
  rank: number
  /** 参与搜索的所有字段（已小写） */
  haystack: string
  /** 节点状态，UI 上画小圆点 */
  status?: string
}

export interface PaletteNode {
  id: string
  type?: string
  data: {
    title?: string
    status?: string
    provider?: string
    cwd?: string
    worktree?: { branch?: string }
  }
}

export interface PaletteProject {
  id: string
  name: string
  cwd?: string
}

/** 紧急度：需要你 > 出错 > 运行中 > 空闲。和画布上的颜色语义保持一致 */
const STATUS_RANK: Record<string, number> = { attention: 0, error: 1, running: 2, idle: 3 }

/** 长路径**从左边截**：右边那截（项目名/子目录）才是能认出来的部分。
    用 JS 截而不是 CSS `direction: rtl` —— 后者在中英混排的路径上会把标点重排，
    实测截图里那一行看着像是乱序的。 */
export function shortPath(p: string, max = 44): string {
  return p.length <= max ? p : `…${p.slice(p.length - max + 1)}`
}

const TYPE_LABEL: Record<string, string> = {
  terminal: '终端',
  group: '集群',
  browser: '浏览器',
  context: '共享上下文',
  credential: '凭证'
}

export function buildPaletteItems(
  nodes: PaletteNode[],
  projects: PaletteProject[],
  liveAgents: Record<string, string> = {}
): PaletteItem[] {
  const items: PaletteItem[] = []
  for (const n of nodes) {
    const kind = TYPE_LABEL[n.type ?? 'terminal'] ?? n.type ?? ''
    // provider 取"此刻真在跑的"优先 —— 和额度计数同一个道理（见 quota-usage.ts）
    const provider = liveAgents[n.id] ?? n.data.provider ?? ''
    const branch = n.data.worktree?.branch ?? ''
    const detail = [kind, provider, branch && `⎇ ${branch}`, n.data.cwd && shortPath(n.data.cwd)]
      .filter(Boolean)
      .join(' · ')
    items.push({
      id: n.id,
      kind: 'node',
      title: n.data.title || n.id,
      detail,
      /* 同为空闲时，**终端排在浏览器/简报/凭证前面** —— Cmd+K 的主用途是
         "跳到某个 agent"，让共享上下文按字母序抢到第一条只是噪音。 */
      rank: (STATUS_RANK[n.data.status ?? 'idle'] ?? 3) + (n.type && n.type !== 'terminal' ? 0.5 : 0),
      status: n.data.status,
      haystack: [n.id, n.data.title, kind, provider, branch, n.data.cwd, n.data.status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
    })
  }
  for (const p of projects) {
    items.push({
      id: p.id,
      kind: 'project',
      title: p.name,
      detail: ['项目', p.cwd && shortPath(p.cwd)].filter(Boolean).join(' · '),
      // 项目排在节点后面：Cmd+K 的第一意图是找那个在等你的 agent
      rank: 4,
      haystack: [p.name, p.cwd, '项目', 'project'].filter(Boolean).join(' ').toLowerCase()
    })
  }
  return items.toSorted((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
}

/**
 * 打分。**返回 0 = 不匹配**（调用方据此过滤）。
 *
 * 多个词之间是「与」：`codex 客户` 要两个都命中。这比整串匹配有用得多 ——
 * 用户记得住的往往是"哪个 provider 在哪个项目"，而不是完整标题。
 */
export function scoreItem(item: PaletteItem, query: string): number {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return 1 // 空查询：全都留下，靠 rank 排序
  let score = 0
  for (const t of terms) {
    const at = item.haystack.indexOf(t)
    if (at < 0) return 0 // 有一个词没命中就整个不算
    // 越靠前越像"用户想的那个"；id 和标题都在 haystack 开头
    score += 100 - Math.min(90, at)
  }
  return score
}

export function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const scored = items
    .map((i) => ({ i, s: scoreItem(i, query) }))
    .filter((x) => x.s > 0)
    /* 有查询时按分数排，没查询时保持 rank 序 —— 否则"谁在等我"这条
       零输入的主用途会被字母序冲掉 */
    .toSorted((a, b) => (query.trim() ? b.s - a.s || a.i.rank - b.i.rank : a.i.rank - b.i.rank))
  return scored.map((x) => x.i)
}
