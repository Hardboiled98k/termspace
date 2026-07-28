/**
 * 终端在窄节点里的字号自适应 —— 纯函数，独立成文件才跑得到测试
 * （`.tsx` 里的 JSX 过不了 Node 的 type stripping）。
 */
const FONT_MIN = 8

/**
 * 节点窄到放不下这么多列时，**自动缩字号**而不是一味减列。
 *
 * 为什么要这条：agent 的 TUI（claude / codex 的框、diff、表格）是按 80 列画的，
 * 列数掉到六七十时它们会折行折到没法读 —— 而画布的常态就是把节点缩小了扫一眼。
 * 浏览器节点已经按同样的思路做了（`REF_WIDTH` 那段），终端这边一直没有，
 * 所以缩小节点时"内容不自适应"。
 *
 * 判据是**先按用户设的字号量一次，不够 80 列才缩**，缩到 FONT_MIN 为止：
 * - 一次成型，不迭代 —— 迭代式的"缩一点再量"会在拖拽时来回抖
 * - 每次都从 base 重新量，所以节点重新拉宽时会自己还原（不会一路缩下去回不来）
 * - 用户设的字号是**上限**，不是固定值。他调大字号 = 想看得更清楚，
 *   在放得下的时候照做；放不下时可读性优先
 */
const TARGET_COLS = 80

export function fitToNode(
  term: { options: { fontSize?: number }; cols: number },
  fit: { fit: () => void },
  base: number
): void {
  // 先以用户设定量一次：这一步让"变宽后还原"自然成立
  term.options.fontSize = base
  fit.fit()
  if (term.cols >= TARGET_COLS) return
  const want = Math.max(FONT_MIN, Math.floor((base * term.cols) / TARGET_COLS))
  if (want >= base) return
  term.options.fontSize = want
  fit.fit()
}
