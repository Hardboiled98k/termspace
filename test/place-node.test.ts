/**
 * 新节点落点。
 *
 * 用户实测报的问题：新建窗口不出现在当前视角正中，每次都要满画布找。
 * 根因是老实现用**画布绝对坐标的固定网格**，和视口没有关系。
 *
 * 两条判据错了都不会报错、只会"稳定地出现在错误的地方"：
 *
 * 1. 视口中心是节点**中心**该在的位置 —— 忘了减半个尺寸，节点偏右下半个身位
 * 2. `viewport.x/y` 是画布原点在屏幕上的偏移（已乘过 zoom），反算方向写反时，
 *    **在缩放 1.0、平移 0 的默认状态下恰好是对的** —— 一动画布才暴露
 * 3. 混合尺寸只比较左上角时，小节点会完整落进已有大节点内部。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeNewNode, viewportCenter } from '../src/renderer/src/place-node.ts'

const SIZE = { width: 600, height: 400 }

test('空画布：节点**中心**落在视口中心', () => {
  const p = placeNewNode({ x: 1000, y: 800 }, SIZE)
  assert.deepEqual(p, { x: 700, y: 600 }, '要减掉自身尺寸的一半')
  assert.equal(p.x + SIZE.width / 2, 1000)
  assert.equal(p.y + SIZE.height / 2, 800)
})

test('中心被占了就往右下错开，不叠在一起', () => {
  const first = placeNewNode({ x: 0, y: 0 }, SIZE)
  const second = placeNewNode({ x: 0, y: 0 }, SIZE, [first])
  assert.notDeepEqual(second, first)
  assert.ok(second.x > first.x && second.y > first.y, '错开方向要和 macOS 新窗口一致（右下）')
})

test('**用真实的凭证尺寸**：小节点绝不能完整落进已有终端内部', () => {
  /* 这条用例的**上一版用的是 420×320**，而标题说的是"凭证" ——
     凭证节点真实尺寸是 220×132。420×320 恰好能过，220×132 过不了：
     实测落点 (-42, 2)，**一个像素都露不出来**。
     教训：用例里的数字要跟被声称的场景对得上，凑一个能过的尺寸等于没测。 */
  const TERM = { x: -300, y: -200, width: 600, height: 400 }
  const CRED = { width: 220, height: 132 }
  const p = placeNewNode({ x: 0, y: 0 }, CRED, [TERM])
  const swallowed =
    p.x >= TERM.x && p.y >= TERM.y &&
    p.x + CRED.width <= TERM.x + TERM.width &&
    p.y + CRED.height <= TERM.y + TERM.height
  assert.equal(swallowed, false, `凭证完整落在终端内部：${JSON.stringify(p)}`)
})

test('层叠手感不能被"防吞没"毁掉：同尺寸节点仍然只错开一点点', () => {
  /* 判据 2 如果写成"矩形相交就算占用"，同尺寸节点错开 34px 仍然相交，
     会一路推到 600 多像素外 —— 那是另一种坏。所以判据 2 必须是**完全包含**，
     而层叠永远不会造成完全包含（新节点总从右下角露出来）。 */
  const a = placeNewNode({ x: 0, y: 0 }, SIZE)
  const b = placeNewNode({ x: 0, y: 0 }, SIZE, [{ ...a, ...SIZE }])
  assert.ok(b.x - a.x > 0 && b.x - a.x < 200, `层叠推太远了：${b.x - a.x}px`)
  assert.equal(b.x - a.x, b.y - a.y, '要沿对角线')
})

test('大节点落在小节点上不算被吞（方向不能反）', () => {
  const p = placeNewNode({ x: 0, y: 0 }, { width: 600, height: 400 }, [
    { x: -110, y: -66, width: 220, height: 132 }
  ])
  // 中心几乎重合 → 判据 1 会让它错开；但绝不能因为"包含"判反而无限推
  assert.ok(Math.abs(p.x) < 400, `被推太远：${JSON.stringify(p)}`)
})

test('**错开按"占没占"判，不按节点总数**', () => {
  /* 老实现按 `n % 5` 算位置：删掉几个之后又会回到已占位置。
     这里连开三个，三个位置必须互不相同。 */
  const placed: { x: number; y: number }[] = []
  for (let i = 0; i < 3; i++) placed.push(placeNewNode({ x: 0, y: 0 }, SIZE, placed))
  const keys = new Set(placed.map((p) => `${p.x},${p.y}`))
  assert.equal(keys.size, 3, `三个节点落在了同一处：${JSON.stringify(placed)}`)
})

test('画布上远处的节点不影响落点', () => {
  const far = [{ x: 9000, y: 9000 }]
  assert.deepEqual(placeNewNode({ x: 0, y: 0 }, SIZE, far), placeNewNode({ x: 0, y: 0 }, SIZE))
})

test('叠得再多也不会跑到视口外（有上限，宁可叠着）', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ x: i * 34 - 300, y: i * 34 - 200 }))
  const p = placeNewNode({ x: 0, y: 0 }, SIZE, many)
  assert.ok(Math.abs(p.x) < 1200 && Math.abs(p.y) < 1200, `跑太远了：${JSON.stringify(p)}`)
})

// ── 视口换算：方向写反时在默认状态下恰好是对的，所以必须测非默认状态 ──

test('默认状态（未平移未缩放）：中心 = 屏幕中心', () => {
  assert.deepEqual(viewportCenter({ x: 0, y: 0, zoom: 1 }, { width: 1600, height: 900 }), {
    x: 800,
    y: 450
  })
})

test('**平移之后**：中心跟着画布走', () => {
  /* 把画布往右拖 400px（viewport.x = 400）意味着画布原点右移，
     于是视口中心对应的画布坐标**变小**。方向写反会得到 1200。 */
  assert.deepEqual(viewportCenter({ x: 400, y: 200, zoom: 1 }, { width: 1600, height: 900 }), {
    x: 400,
    y: 250
  })
})

test('**缩放之后**：屏幕像素要除以 zoom', () => {
  // 放大 2 倍时，同样的屏幕中心对应的画布距离只有一半
  assert.deepEqual(viewportCenter({ x: 0, y: 0, zoom: 2 }, { width: 1600, height: 900 }), {
    x: 400,
    y: 225
  })
  // 缩小到 0.5 时相反
  assert.deepEqual(viewportCenter({ x: 0, y: 0, zoom: 0.5 }, { width: 1600, height: 900 }), {
    x: 1600,
    y: 900
  })
})

test('zoom 为 0 / 缺失时不产生 Infinity', () => {
  const p = viewportCenter({ x: 0, y: 0, zoom: 0 }, { width: 800, height: 600 })
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
})
