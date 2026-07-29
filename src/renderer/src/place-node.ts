/**
 * 新节点落在哪。
 *
 * 老实现是**画布绝对坐标的固定网格**（`120 + (n%5)*160`）——
 * 于是你把画布拖到别处、或缩放之后新建一个终端，它出现在几千像素外，
 * 每次都要满画布找。用户实测报的就是这个。
 *
 * 新判据：**落在当前视口正中**，且已经有节点占着中心时按对角线错开。
 *
 * 两件容易写错的：
 *
 * 1. **要减掉节点自身尺寸的一半**。视口中心是节点的**中心**该在的位置，
 *    不是它左上角该在的位置 —— 直接用中心点当 position，节点会偏右下半个身位。
 * 2. **错开要按「占没占」判，不能按节点总数**。按总数（`n % 5`）在删掉几个之后
 *    又会回到已占位置；而画布上本来就可能有节点恰好在中心附近。
 */

export interface Rect {
  x: number
  y: number
  width?: number
  height?: number
}

/** 判定"这个位置已经被占了"的距离阈值。比它近就认为会叠在一起 */
const NEAR = 40
/** 每次错开的步长与上限。超过上限就不再找了，直接叠着放（总比丢到视口外好） */
const STEP = 34
const MAX_TRIES = 24

/**
 * @param center 视口中心在**画布坐标系**里的位置（调用方用 screenToFlowPosition 换算）
 * @param size 新节点尺寸
 * @param existing 画布上已有节点（只用 position/尺寸）
 */
export function placeNewNode(
  center: { x: number; y: number },
  size: { width: number; height: number },
  existing: Rect[] = []
): { x: number; y: number } {
  const base = { x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2) }

  /**
   * 「这个位置不能用」有**两个**判据，缺一条都会真出问题：
   *
   * 1. **中心贴太近** —— 同尺寸节点严丝合缝地盖住，等于看不见新开的那个。
   * 2. **新节点会被完全罩住** —— 比中心那条更阴：小节点落在大节点里，
   *    两者中心相距很远（不触发判据 1），但新节点**一个像素都露不出来**。
   *    实测过的原数：终端 600×400 在视口中心，再建凭证 220×132 →
   *    落点 `(-42, 2)`，**完全落在终端内部**。上一版只比中心，这条漏掉了。
   *
   * 判据 2 特意用"完全包含"而不是"矩形相交"：
   * 相交就算占用的话，同尺寸节点错开 34px 仍然相交 → 会一路推到 600 多像素外，
   * 把有意为之的 macOS 层叠手感毁掉。而**层叠永远不会造成完全包含**
   * （新节点总从右下角露出来），所以这两条判据不打架。
   */
  const taken = (p: { x: number; y: number }): boolean =>
    existing.some((e) => {
      const ew = e.width ?? size.width
      const eh = e.height ?? size.height
      const centersNear =
        Math.abs(e.x + ew / 2 - (p.x + size.width / 2)) < NEAR &&
        Math.abs(e.y + eh / 2 - (p.y + size.height / 2)) < NEAR
      const swallowed =
        p.x >= e.x && p.y >= e.y && p.x + size.width <= e.x + ew && p.y + size.height <= e.y + eh
      return centersNear || swallowed
    })

  let p = base
  for (let i = 0; i < MAX_TRIES && taken(p); i++) {
    // 往右下错开：和 macOS 新窗口的层叠方向一致，人对这个方向有预期
    p = { x: base.x + (i + 1) * STEP, y: base.y + (i + 1) * STEP }
  }
  /* **试满了还是被占，就回到 base。**
     一个 2400×2000 的大组能把 24 次全部吃掉，那时 p 已经在 base 右下 816px 外 ——
     **仍然被完全包住，却离视口中心更远了**，两头不讨好。
     回到 base 至少保证"出现在你正看着的地方"，那是这个函数存在的全部理由。 */
  return taken(p) ? base : p
}

/**
 * 视口中心的画布坐标。
 *
 * `viewport.x/y` 是**画布原点在屏幕上的偏移**（已乘过 zoom），所以反算要先减再除。
 * 单独抽出来是为了能测 —— 这个换算方向写反了不会报错，只会让节点稳定地
 * 出现在错误的地方，而"错误的地方"在缩放 1.0、平移 0 时恰好是对的。
 */
export function viewportCenter(
  viewport: { x: number; y: number; zoom: number },
  screen: { width: number; height: number }
): { x: number; y: number } {
  const z = viewport.zoom || 1
  return {
    x: (-viewport.x + screen.width / 2) / z,
    y: (-viewport.y + screen.height / 2) / z
  }
}
