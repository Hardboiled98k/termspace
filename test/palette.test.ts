/**
 * Cmd+K 检索。
 *
 * 两条判据错了都不会报错，只会"用起来别扭"，所以要钉住：
 *
 * 1. **零输入时先列「需要你」**。打开 Cmd+K 最常见的意图是"谁在等我"，
 *    按字母序或创建时间排就把这个主用途冲掉了。
 * 2. **多个词之间是「与」**。用户记得住的往往是"哪个 provider 在哪个项目"，
 *    而不是完整标题；`codex 客户` 必须两个都命中才算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPaletteItems,
  filterItems,
  scoreItem,
  shortPath,
  type PaletteNode,
  type PaletteProject
} from '../src/renderer/src/palette.ts'

const NODES: PaletteNode[] = [
  { id: 't-aaa', type: 'terminal', data: { title: 'zsh · t-aaa', status: 'idle', cwd: '/proj/web' } },
  {
    id: 't-bbb',
    type: 'terminal',
    data: { title: 'Codex · t-bbb', status: 'attention', provider: 'codex', cwd: '/proj/api' }
  },
  {
    id: 't-ccc',
    type: 'terminal',
    data: { title: 'Claude · t-ccc', status: 'running', provider: 'claude', cwd: '/proj/web' }
  },
  { id: 'b-ddd', type: 'browser', data: { title: 'Google', status: 'idle' } },
  {
    id: 'g-eee',
    type: 'group',
    data: { title: '重构组', worktree: { branch: 'feat/split' } }
  }
]

const PROJECTS: PaletteProject[] = [
  { id: 'p1', name: 'web', cwd: '/proj/web' },
  { id: 'p2', name: '客户项目表', cwd: '/Users/me/Desktop/客户' }
]

const ITEMS = buildPaletteItems(NODES, PROJECTS)

test('零输入时「需要你」排第一（Cmd+K 的主用途）', () => {
  const first = filterItems(ITEMS, '')[0]
  assert.equal(first.id, 't-bbb', `第一条应该是那个在等你的，实际 ${first.id}`)
})

test('紧急度顺序：需要你 > 出错 > 运行中 > 空闲 > 项目', () => {
  const ranks = filterItems(ITEMS, '').map((i) => i.rank)
  assert.deepEqual(ranks, ranks.toSorted((a, b) => a - b), '顺序乱了')
})

test('搜得到节点 id —— tb ask 要用它，而它最难记', () => {
  const r = filterItems(ITEMS, 't-ccc')
  assert.equal(r[0].id, 't-ccc')
})

test('搜得到 cwd、provider、分支名、状态', () => {
  assert.ok(filterItems(ITEMS, '/proj/api').some((i) => i.id === 't-bbb'), 'cwd')
  assert.ok(filterItems(ITEMS, 'codex').some((i) => i.id === 't-bbb'), 'provider')
  assert.ok(filterItems(ITEMS, 'feat/split').some((i) => i.id === 'g-eee'), '分支名')
  assert.ok(filterItems(ITEMS, 'attention').some((i) => i.id === 't-bbb'), '状态')
})

test('**多个词是「与」不是「或」**', () => {
  // claude 只在 t-ccc，/proj/web 在 t-aaa 和 t-ccc → 交集只有 t-ccc
  const r = filterItems(ITEMS, 'claude /proj/web')
  assert.deepEqual(r.map((i) => i.id), ['t-ccc'])
  // 有一个词谁都不命中 → 空结果，而不是退化成或
  assert.deepEqual(filterItems(ITEMS, 'claude 不存在的词'), [])
})

test('项目也能搜到（中文）', () => {
  const r = filterItems(ITEMS, '客户')
  assert.equal(r[0].kind, 'project')
  assert.equal(r[0].id, 'p2')
})

test('有查询时按相关度排，不再被紧急度压住', () => {
  /* 搜 "t-aaa" 时那个空闲节点必须排第一 —— 否则"我明明搜了它"却要往下翻，
     这正是零输入排序和有输入排序必须用两套规则的原因 */
  assert.equal(filterItems(ITEMS, 't-aaa')[0].id, 't-aaa')
})

test('实跑的 agent 参与检索（手敲起来的 claude 也搜得到）', () => {
  const items = buildPaletteItems(NODES, [], { 't-aaa': 'claude' })
  assert.ok(filterItems(items, 'claude').some((i) => i.id === 't-aaa'))
})

test('不匹配返回 0 分，调用方据此过滤', () => {
  assert.equal(scoreItem(ITEMS[0], '绝不存在'), 0)
  assert.ok(scoreItem(ITEMS[0], '') > 0, '空查询要全留下')
})

test('长路径从左边截，保留能认出来的那一截', () => {
  const p = '/Users/me/Desktop/客户项目/AI活动包配置/权益数据核对/权益实时_2026'
  const s = shortPath(p, 20)
  assert.ok(s.startsWith('…'), '省略号要在左边')
  assert.ok(p.endsWith(s.slice(1)), '保留的必须是原串的结尾')
  assert.equal(s.length, 20)
  assert.equal(shortPath('/short', 20), '/short', '够短就别动它')
})

test('同为空闲时终端排在浏览器/简报前面', () => {
  const items = filterItems(ITEMS, '')
  const term = items.findIndex((i) => i.id === 't-aaa')
  const brow = items.findIndex((i) => i.id === 'b-ddd')
  assert.ok(term < brow, 'Cmd+K 的主用途是跳到 agent，别让浏览器节点抢在前面')
})
