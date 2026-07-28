/**
 * 任务布局模板。
 *
 * 这东西的全部意义是**能发给别人**，所以三条判据错一条就等于不能用：
 *
 * 1. **不含凭证**。identityId 是本机 id，留着它 = 导入方的节点静默绑上他自己的账号
 * 2. **相对 cwd**。存绝对路径的模板只在作者机器上有意义，还泄漏用户名和目录结构
 * 3. **命令默认不跑**。今天刚修过一个 P0：外部文件里的 `command` 会在重启后
 *    自动进登录 shell。模板必须从字段名上就和那条路分开
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toTemplate, fromTemplate } from '../src/main/layout-template.ts'

const ROOT = '/Users/me/proj'

const NODES = [
  {
    id: 't1',
    type: 'terminal',
    position: { x: 10, y: 20 },
    width: 600,
    height: 400,
    data: {
      title: '前端 agent',
      command: 'claude',
      provider: 'claude',
      cwd: '/Users/me/proj/web',
      identityId: 'i-secret',
      status: 'running'
    }
  },
  {
    id: 't2',
    type: 'terminal',
    position: { x: 700, y: 20 },
    data: { title: '测试', cwd: '/Users/me/proj', command: 'npm test' }
  },
  {
    id: 't3',
    type: 'terminal',
    position: { x: 0, y: 900 },
    data: { title: '别处的终端', cwd: '/Users/me/别的项目' }
  },
  { id: 'b1', type: 'browser', position: { x: 100, y: 500 }, data: { title: '预览', url: 'https://x.test' } }
]
const EDGES = [{ source: 'ctx1', target: 't1', data: { kind: 'context' } }]

test('**导出绝不带 identityId**（凭证是本机的，带出去就是静默绑账号）', () => {
  const t = toTemplate('全栈', NODES, EDGES, ROOT)
  const raw = JSON.stringify(t)
  assert.ok(!raw.includes('i-secret'), `凭证进了模板：${raw}`)
  assert.ok(!/identityId/.test(raw))
})

test('cwd 转成相对根目录；根目录本身写成 `.`', () => {
  const t = toTemplate('x', NODES, EDGES, ROOT)
  assert.equal(t.nodes.find((n) => n.ref === 't1')?.cwd, 'web')
  assert.equal(t.nodes.find((n) => n.ref === 't2')?.cwd, '.')
})

test('**根目录外的 cwd 整个丢掉**，不保留绝对路径', () => {
  /* 保留的话，模板发给别人只会让终端起在家目录，
     还顺手泄漏了作者的用户名和目录结构 */
  const t = toTemplate('x', NODES, EDGES, ROOT)
  const n = t.nodes.find((x) => x.ref === 't3')
  assert.equal(n?.cwd, undefined)
  assert.ok(!JSON.stringify(t).includes('别的项目'))
})

test('命令导出成 suggestedCommand —— **字段名和自动执行那条路必须不同**', () => {
  /* 导入侧读的字段和 spawn 自动执行读的字段（command）不是同一个，
     这样"忘了处理"的默认结果是不跑，而不是跑。 */
  const t = toTemplate('x', NODES, EDGES, ROOT)
  const raw = JSON.stringify(t)
  assert.ok(!/"command"/.test(raw), '模板里不该出现 command 字段')
  assert.equal(t.nodes.find((n) => n.ref === 't1')?.suggestedCommand, 'claude')
})

test('运行态不进模板（状态、尺寸之外的东西）', () => {
  const t = toTemplate('x', NODES, EDGES, ROOT)
  assert.ok(!JSON.stringify(t).includes('running'))
})

test('连线只保留两端都在模板里的那些', () => {
  // ctx1 不在 NODES 里 → 这条边是悬空的，带出去会指向不存在的节点
  const t = toTemplate('x', NODES, EDGES, ROOT)
  assert.deepEqual(t.edges, [])
})

// ── 导入侧：这是外部文件的入口 ──

test('导入把相对 cwd 展开成绝对路径', () => {
  const t = toTemplate('x', NODES, EDGES, ROOT)
  const r = fromTemplate(t, '/Users/other/work')
  assert.ok(r.ok)
  assert.equal(r.nodes?.find((n) => n.ref === 't1')?.absCwd, '/Users/other/work/web')
  assert.equal(r.nodes?.find((n) => n.ref === 't2')?.absCwd, '/Users/other/work')
})

test('**绝对路径和 .. 逃逸一律拒**（模板可以来自任何人）', () => {
  const bad = (cwd: string): unknown => ({
    kind: 'termspace-layout',
    version: 1,
    name: 'x',
    nodes: [{ ref: 'a', type: 'terminal', title: 'a', cwd, x: 0, y: 0 }],
    edges: []
  })
  assert.equal(fromTemplate(bad('/etc'), ROOT).ok, false)
  assert.equal(fromTemplate(bad('../../../etc'), ROOT).ok, false)
  assert.equal(fromTemplate(bad('a/../../b'), ROOT).ok, false)
})

test('不是模板 / 版本不对 / 节点太多 → 明确拒绝', () => {
  assert.equal(fromTemplate({ nodes: [] }, ROOT).ok, false)
  assert.equal(fromTemplate({ kind: 'termspace-layout', version: 9, nodes: [] }, ROOT).ok, false)
  const many = {
    kind: 'termspace-layout',
    version: 1,
    name: 'x',
    nodes: Array.from({ length: 61 }, (_, i) => ({ ref: `n${i}`, type: 'terminal', title: 'x', x: 0, y: 0 })),
    edges: []
  }
  assert.equal(fromTemplate(many, ROOT).ok, false)
})

test('不认识的节点类型整个丢，不兜底成终端', () => {
  const r = fromTemplate(
    {
      kind: 'termspace-layout',
      version: 1,
      name: 'x',
      nodes: [
        { ref: 'a', type: 'wormhole', title: 'a', x: 0, y: 0 },
        { ref: 'b', type: 'terminal', title: 'b', x: 0, y: 0 }
      ],
      edges: []
    },
    ROOT
  )
  assert.deepEqual(r.nodes?.map((n) => n.ref), ['b'])
})

test('导入报告有几个节点带建议命令（确认框要说清它们不会自动跑）', () => {
  const t = toTemplate('x', NODES, EDGES, ROOT)
  assert.equal(fromTemplate(t, ROOT).withCommands, 2)
})

test('往返：导出再导入，布局结构不变', () => {
  const t = toTemplate('全栈', NODES, EDGES, ROOT)
  const r = fromTemplate(JSON.parse(JSON.stringify(t)), ROOT)
  assert.ok(r.ok)
  assert.deepEqual(
    r.nodes?.map((n) => `${n.ref}:${n.type}:${n.x},${n.y}`).toSorted(),
    ['b1:browser:100,500', 't1:terminal:10,20', 't2:terminal:700,20', 't3:terminal:0,900']
  )
})
