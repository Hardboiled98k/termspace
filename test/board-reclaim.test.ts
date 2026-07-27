/**
 * 关掉标签页 → 重新添加同目录 → 拿回原来的画布。
 *
 * 钉的是一个**实测发现的真泄漏**：`closeProject` 的注释写着
 * 「画布记录保留（tmux 会话也还活着），重新添加同目录即恢复」，
 * 而 `addProject` 每次都 `newNodeId('p', …)` 铸一个新 pid ——
 * 于是旧 board 连同里面**还在跑的终端**永久孤儿化。
 *
 * 危险的地方在于它不报错也不丢数据，反而是"数据留得太好"：
 * reap 认的是"所有 board 里出现过的节点 id"，所以那些 tmux 会话会一直活着，
 * 界面上看不见、关不掉，只能去命令行 `tmux -L termboard kill-session`。
 * 用户机器上实测到 4 个孤儿 board，其中一个装着两个从三天前活到现在的终端。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reclaimBoardId, pruneEmptyBoards } from '../src/renderer/src/board-serde.ts'

const board = (cwd: string | undefined, n = 0) => ({
  cwd,
  nodes: Array.from({ length: n }, (_, i) => ({ id: `t${i}` }))
})

test('关掉的项目：同目录再加时认领回原 pid', () => {
  const boards = { 'p-abc': board('/Users/me/proj', 2) }
  assert.equal(reclaimBoardId(boards, [], '/Users/me/proj'), 'p-abc')
})

test('正在用的 board 不能被劫持', () => {
  // 同一个目录开着两个标签页是合法的，新加的那个必须是独立画布 ——
  // 否则两个标签页会指向同一块 board，互相覆盖对方的节点
  const boards = { 'p-abc': board('/Users/me/proj', 2) }
  assert.equal(reclaimBoardId(boards, ['p-abc'], '/Users/me/proj'), null)
})

test('目录不同不认领', () => {
  const boards = { 'p-abc': board('/Users/me/proj', 2) }
  assert.equal(reclaimBoardId(boards, [], '/Users/me/other'), null)
})

test('空 cwd 不参与匹配', () => {
  /* v1 迁移来的「默认」项目 cwd 是空串。若参与匹配，
     任何一次 pickFolder 返回空都会认领到用户的主画布上去 */
  const boards = { p1: board('', 3) }
  assert.equal(reclaimBoardId(boards, [], ''), null)
  // 没有 cwd 字段的老 board 同理
  assert.equal(reclaimBoardId({ p1: board(undefined, 3) }, [], ''), null)
})

test('多个孤儿里只认 cwd 对得上的那个', () => {
  const boards = {
    'p-1': board('/a', 1),
    'p-2': board('/b', 5),
    'p-3': board('/c', 1)
  }
  assert.equal(reclaimBoardId(boards, [], '/b'), 'p-2')
})

test('pruneEmptyBoards 只清空壳，有节点的一律留着', () => {
  /* 节点 id 一旦从 boards 里消失，reap 就把对应的 tmux 会话当孤儿杀掉。
     所以这个清理必须保守到近乎无用 —— 宁可留垃圾，不可杀会话。 */
  const boards = {
    open: board('/a', 0), // 有项目在用，空的也留
    orphanWithNodes: board('/b', 2), // 孤儿但有节点 —— 里面可能有活着的终端
    orphanEmpty: board('/c', 0) // 真空壳，清掉
  }
  const out = pruneEmptyBoards(boards, ['open'])
  assert.deepEqual(Object.keys(out).toSorted(), ['open', 'orphanWithNodes'])
})

test('pruneEmptyBoards 不改原对象', () => {
  const boards = { a: board('/a', 0) }
  pruneEmptyBoards(boards, [])
  assert.ok('a' in boards, '不能就地删 —— boardsRef.current 在别处还被读着')
})

test('认领后原 board 的节点原样还在（不是搬家）', () => {
  /* pid 决定上下文节点的文件名，所以认领的是 pid 本身。
     若改成"把节点搬到新 pid"，上下文文件会对不上。 */
  const boards = { 'p-abc': board('/Users/me/proj', 2) }
  const pid = reclaimBoardId(boards, [], '/Users/me/proj')
  assert.equal(pid, 'p-abc')
  assert.equal(boards[pid!].nodes.length, 2)
})
