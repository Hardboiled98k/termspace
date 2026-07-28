/**
 * 终端在窄节点里的字号自适应。
 *
 * 钉的是用户报的第 4 个 UI 问题：**画布里的终端缩小后内容不自适应**。
 * agent 的 TUI（claude / codex 的框、diff、表格）按 80 列画，列数掉到六七十
 * 就折行折到没法读 —— 而"把节点缩小扫一眼"正是这张画布的常态用法。
 *
 * 两个只在拖拽时才暴露、静态看代码看不出来的失败模式：
 *
 * 1. **抖动**：迭代式"缩一点再量一次"会在拖拽过程中来回跳字号。
 * 2. **缩下去回不来**：如果每次都在**当前**字号基础上再缩，节点重新拉宽后
 *    字号永远回不到用户设的值 —— 而用户只会觉得"字怎么越用越小"。
 *
 * 所以判据必须是"每次都从 base 重新量"。这里用一个假的 term/fit 把
 * 宽度→列数的关系模拟出来（列数 ∝ 宽度 / 字号），验的是这条判据本身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitToNode } from '../src/renderer/src/fit-to-node.ts'

/** 假终端：列数 = 节点宽 / (字号 * 0.6)，和真实等宽字体的比例接近 */
function fakeTerm(widthPx: number) {
  const term = { options: { fontSize: 13 } as { fontSize?: number }, cols: 0 }
  const fit = {
    fit: (): void => {
      term.cols = Math.max(1, Math.floor(widthPx / ((term.options.fontSize ?? 13) * 0.6)))
    }
  }
  return { term, fit }
}

test('节点够宽时不动用户设的字号', () => {
  const { term, fit } = fakeTerm(900) // 13px 下约 115 列
  fitToNode(term, fit, 13)
  assert.equal(term.options.fontSize, 13)
  assert.ok(term.cols >= 80)
})

test('节点窄到放不下 80 列时缩字号，而不是一路减列', () => {
  const { term, fit } = fakeTerm(420) // 13px 下只有 53 列
  fitToNode(term, fit, 13)
  assert.ok((term.options.fontSize ?? 13) < 13, '字号该缩下来')
  assert.ok(term.cols > 53, `缩完列数要变多，实际 ${term.cols}`)
})

test('缩到下限就停，不会缩成看不见的字', () => {
  const { term, fit } = fakeTerm(60)
  fitToNode(term, fit, 13)
  assert.equal(term.options.fontSize, 8, '下限是 FONT_MIN=8')
})

test('**同一宽度重复调用结果稳定**（拖拽时不抖）', () => {
  const { term, fit } = fakeTerm(420)
  fitToNode(term, fit, 13)
  const first = term.options.fontSize
  for (let i = 0; i < 10; i++) fitToNode(term, fit, 13)
  assert.equal(term.options.fontSize, first, '重复调用把字号越缩越小 = 拖拽时会抖')
})

test('**节点重新拉宽后字号回到用户设的值**（缩下去要回得来）', () => {
  const narrow = fakeTerm(420)
  fitToNode(narrow.term, narrow.fit, 13)
  assert.ok((narrow.term.options.fontSize ?? 13) < 13)

  /* 关键：拉宽是同一个 term 换了宽度。这里用同一个 options 对象接到宽的 fit 上，
     模拟"节点被拉宽后又调了一次" —— 判据若是"在当前字号上再算"，这里就回不去。 */
  const wide = {
    term: narrow.term,
    fit: {
      fit: (): void => {
        narrow.term.cols = Math.floor(900 / ((narrow.term.options.fontSize ?? 13) * 0.6))
      }
    }
  }
  fitToNode(wide.term, wide.fit, 13)
  assert.equal(narrow.term.options.fontSize, 13, '拉宽后没还原 = 字越用越小')
})

test('用户把字号调大：放得下就照做，放不下时可读性优先', () => {
  const big = fakeTerm(1600)
  fitToNode(big.term, big.fit, 20)
  assert.equal(big.term.options.fontSize, 20, '够宽就该听用户的')

  const small = fakeTerm(420)
  fitToNode(small.term, small.fit, 20)
  assert.ok((small.term.options.fontSize ?? 20) < 20, '放不下时字号是上限不是固定值')
})
