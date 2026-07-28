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
import {
  fromSaved,
  toSaved,
  newNodeId,
  NODE_ID_RE,
  SAVED_TYPES,
  type BoardNode
} from '../src/renderer/src/board-serde.ts'

const pos = { position: { x: 10, y: 20 }, width: 300, height: 200 }

const SAMPLES: Record<string, BoardNode> = {
  terminal: {
    id: 't1',
    type: 'terminal',
    ...pos,
    data: { title: 'zsh', status: 'idle', identityId: 'i1', provider: 'codex', cwd: '/tmp' }
  } as BoardNode,
  /* group 样本**必须带 worktree**：这个字段决定组内终端落在哪棵树上，
     漏了它往返测试就抓不到"存了没读回来"——而症状是重启后隔离静默失效，
     两个 agent 又回到同一个工作区里打架。同「凭证样本故意投毒」是一个道理。 */
  group: {
    id: 'g1',
    type: 'group',
    ...pos,
    data: {
      title: '组',
      collapsed: true,
      worktree: { repo: '/r', branch: 'feat/x', path: '/r.worktrees/feat-x-ab12cd' }
    }
  } as BoardNode,
  context: { id: 'ctx1', type: 'context', ...pos, data: { title: '共享上下文' } } as BoardNode,
  browser: {
    id: 'b1',
    type: 'browser',
    ...pos,
    data: { title: '页面', url: 'https://example.com' }
  } as BoardNode,
  /* 凭证样本**故意投毒**：原来只有 `{ identityId }`，根本没有 env 字段可漏 ——
     那条"存盘里绝不能出现 env 值"的用例结构上就抓不到它要防的事。
     将来有人给节点 data 加了 env 并在 toSaved 里顺手带上，也照样绿。 */
  credential: {
    id: 'c1',
    type: 'credential',
    ...pos,
    data: { identityId: 'i9', envKeys: ['OPENAI_API_KEY'], env: { OPENAI_API_KEY: 'sk-LEAK' } }
  } as unknown as BoardNode
}

test('每个可存盘的节点类型都有样本（加了新类型就来补）', () => {
  assert.deepEqual(Object.keys(SAMPLES).toSorted(), [...SAVED_TYPES].toSorted())
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

test('组绑定的 worktree 要整个活着回来（丢了 = 隔离静默失效）', () => {
  /* **这条是补出来的**：光在 SAMPLES 里加 worktree 字段没用 ——
     上面那个 for 循环只断言 type/id/position，字段级断言在这个文件里是逐条单写的。
     加了样本却没加断言，去掉 toSaved 里的 worktree 测试照样全绿（实测过）。
     而症状是重启后组的隔离没了，两个 agent 又回到同一个工作区里打架，
     没有任何报错 —— 正是这个文件开头说的那类"静默且危险"。 */
  const d = fromSaved(toSaved(SAMPLES.group as never)).data as Record<string, unknown>
  assert.deepEqual(d.worktree, {
    repo: '/r',
    branch: 'feat/x',
    path: '/r.worktrees/feat-x-ab12cd'
  })
})

test('组的折叠态要持久化（不然重开组身缩着、子终端全冒出来）', () => {
  const d = fromSaved(toSaved(SAMPLES.group as never)).data as Record<string, unknown>
  assert.equal(d.collapsed, true)
})

test('凭证节点存盘里**绝不能**出现 env 值', () => {
  // 渲染层本来就拿不到值，但这条用例是防将来有人"顺手"把它带过来
  const raw = JSON.stringify(toSaved(SAMPLES.credential as never))
  assert.ok(!raw.includes('sk-LEAK'), `env 值进了存盘：${raw}`)
  assert.ok(!/env|token|key|secret/i.test(raw), `存盘内容混进了敏感字段：${raw}`)
})

// ── 节点 id 不可复用 ─────────────────────────────────────────────────────────

test('新 id 不会复用：删掉再建不会拿到同一个', () => {
  /* 老实现是 max+1，删掉 t7 再建一个还叫 t7。而 nodeId 同时是 tmux 会话名、
     scrollback 文件名、上下文文件名、hook token 文件名、pty 表的键、授权图的键 ——
     一复用这六条链路一起串台。 */
  const seen = new Set<string>()
  let ids: string[] = []
  for (let i = 0; i < 500; i++) {
    const id = newNodeId('t', ids)
    assert.ok(!seen.has(id), `第 ${i} 次生成了重复 id：${id}`)
    seen.add(id)
    ids.push(id)
    // 模拟"删掉一半再继续建"——老实现在这里就会开始发重复号
    if (i % 50 === 0) ids = ids.slice(-5)
  }
})

test('新 id 必须能过主进程的字符校验', () => {
  // 生成一个主进程会拒收的 id，症状是终端**静默起不来**
  for (let i = 0; i < 200; i++) {
    const id = newNodeId('t')
    assert.ok(NODE_ID_RE.test(id), `${id} 过不了 NODE_ID_RE`)
  }
})

test('新 id 当 tmux 会话名时不会被改写', () => {
  /* tmux 会话名是 `tb-<id>`，src/main/tmux.ts 的 sessionName 会把
     [^a-zA-Z0-9_-] 换成下划线。**若 id 被改写，两个不同的 id 可能映射到同一个会话名** */
  for (let i = 0; i < 200; i++) {
    const id = newNodeId('b')
    assert.equal(id.replace(/[^a-zA-Z0-9_-]/g, '_'), id, `${id} 会被 sessionName 改写`)
  }
})

test('避开已存在的 id（含老工作区里的 t1/b3 那种）', () => {
  const legacy = ['t1', 't2', 'b3', 'g1', 'ctx-p1']
  for (let i = 0; i < 100; i++) {
    assert.ok(!legacy.includes(newNodeId('t', legacy)))
  }
})

test('各前缀互不干扰，且看得出是哪类节点', () => {
  // id 是用户和 agent 要念出来的东西（tb ask <节点id> <任务>），不能是一串 UUID
  assert.match(newNodeId('t'), /^t-[a-z0-9]{1,8}$/)
  assert.match(newNodeId('b'), /^b-[a-z0-9]{1,8}$/)
  assert.ok(newNodeId('t').length <= 12, 'id 要短到能让人念出来')
})
