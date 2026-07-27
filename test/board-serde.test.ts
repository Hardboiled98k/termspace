/**
 * 画布节点存盘 → 读回 的往返。
 *
 * 钉的是一个**已经上线过的 P0**：`toSaved` 会写 `type:'credential'`，
 * 而 `fromSaved` 没有对应分支 → 掉进 terminal 兜底 → 重启后凭证节点变成一个终端，
 * 还拿着 identityId 真去 spawn 一个 pty。
 *
 * 兜底分支是 terminal，**静默且危险**：类型上完全合法、typecheck 全绿、
 * 界面上就是多了个终端。所以这里逐类型往返，任何新节点类型忘了补分支都会炸。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromSaved, toSaved, SAVED_TYPES, type BoardNode } from '../src/renderer/src/board-serde.ts'

const pos = { position: { x: 10, y: 20 }, width: 300, height: 200 }

const SAMPLES: Record<string, BoardNode> = {
  terminal: {
    id: 't1',
    type: 'terminal',
    ...pos,
    data: { title: 'zsh', status: 'idle', identityId: 'i1', provider: 'codex', cwd: '/tmp' }
  } as BoardNode,
  group: { id: 'g1', type: 'group', ...pos, data: { title: '组', collapsed: true } } as BoardNode,
  context: { id: 'ctx1', type: 'context', ...pos, data: { title: '共享上下文' } } as BoardNode,
  browser: {
    id: 'b1',
    type: 'browser',
    ...pos,
    data: { title: '页面', url: 'https://example.com' }
  } as BoardNode,
  credential: { id: 'c1', type: 'credential', ...pos, data: { identityId: 'i9' } } as BoardNode
}

test('每个可存盘的节点类型都有样本（加了新类型就来补）', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...SAVED_TYPES].sort())
})

for (const kind of SAVED_TYPES) {
  test(`${kind} 存盘再读回，type 不能变`, () => {
    const back = fromSaved(toSaved(SAMPLES[kind] as never))
    // 这一条就是那个 P0：credential 曾经在这里变成 terminal
    assert.equal(back.type, kind)
    assert.equal(back.id, SAMPLES[kind]?.id)
    assert.deepEqual(back.position, { x: 10, y: 20 })
  })
}

test('凭证节点带着 identityId 回来（丢了就等于连线白拉）', () => {
  const back = fromSaved(toSaved(SAMPLES.credential as never))
  assert.equal((back.data as { identityId?: string }).identityId, 'i9')
})

test('终端的 identityId / provider / cwd 都要活着回来', () => {
  const d = fromSaved(toSaved(SAMPLES.terminal as never)).data as Record<string, unknown>
  assert.equal(d.identityId, 'i1')
  assert.equal(d.provider, 'codex')
  assert.equal(d.cwd, '/tmp')
})

test('组的折叠态要持久化（不然重开组身缩着、子终端全冒出来）', () => {
  const d = fromSaved(toSaved(SAMPLES.group as never)).data as Record<string, unknown>
  assert.equal(d.collapsed, true)
})

test('凭证节点存盘里**绝不能**出现 env 值', () => {
  // 渲染层本来就拿不到值，但这条用例是防将来有人"顺手"把它带过来
  const raw = JSON.stringify(toSaved(SAMPLES.credential as never))
  assert.ok(!/env|token|key|secret/i.test(raw), `存盘内容混进了敏感字段：${raw}`)
})
