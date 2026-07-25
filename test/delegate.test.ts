/**
 * 派活准入的 smoke test —— 这是全项目最危险的一段逻辑：
 * 判错一次就等于把任意文本当命令敲进用户的 shell。
 *
 * 跑法：npm test（Node 原生 type stripping，无需测试框架）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { delegate, noteStatus, noteTranscript, isAgentSession, dropNode } from '../src/main/delegate.ts'

/** 记录所有注入，便于断言"到底写没写进去" */
function deps(authorize = true): {
  writes: string[]
  d: Parameters<typeof delegate>[0]
} {
  const writes: string[] = []
  return {
    writes,
    d: {
      hasNode: () => true,
      writeToPty: (_id, data) => writes.push(data),
      authorize: async () => authorize
    }
  }
}

test('普通 shell（没有任何 hook 上报）一律拒绝注入', async () => {
  const { writes, d } = deps()
  const r = await delegate(d, 'src', 'shell1', 'rm -rf /tmp/x', 500)
  assert.match(r, /派活被拒/)
  assert.equal(writes.length, 0, '绝不能往未确认的会话里写任何东西')
})

test('SessionEnd 之后迟到的事件不得复活会话', async () => {
  dropNode('n1')
  noteStatus('n1', 'session', 'SessionStart', 's-1')
  assert.equal(isAgentSession('n1'), true)

  noteStatus('n1', 'session', 'SessionEnd', 's-1')
  assert.equal(isAgentSession('n1'), false)

  // 并行 hook 晚到：同一个 session 的 PostToolUse 在 SessionEnd 之后才到
  noteStatus('n1', 'working', 'PostToolUse', 's-1')
  assert.equal(isAgentSession('n1'), false, '迟到事件复活会话 = 往普通 shell 注入')

  const { writes, d } = deps()
  const r = await delegate(d, 'src', 'n1', 'echo hi', 500)
  assert.match(r, /派活被拒/)
  assert.equal(writes.length, 0)
})

/* ── 以下三条是 codex review 实际复现出来的绕过（都真的产生了注入写入），
      作为回归用例钉死。改 delegate 状态机时它们必须一直是绿的。 ── */

test('绕过 1：s1 End → s2 Start → 迟到的 s1 Stop，不得把节点判成可注入', async () => {
  dropNode('b1')
  noteStatus('b1', 'session', 'SessionStart', 's1')
  noteStatus('b1', 'session', 'SessionEnd', 's1')
  noteStatus('b1', 'session', 'SessionStart', 's2')
  noteStatus('b1', 'working', 'PreToolUse', 's2') // s2 正在干活
  noteStatus('b1', 'done', 'Stop', 's1') // 迟到的旧会话 Stop

  const { writes, d } = deps()
  const r = await delegate(d, 'src', 'b1', 'DANGEROUS', 500)
  assert.match(r, /派活被拒/)
  assert.equal(writes.length, 0, '旧会话的迟到 Stop 不能把正在干活的新会话洗成 done')
})

test('绕过 2：dropNode 之后旧会话的迟到事件不得复活节点', async () => {
  dropNode('b2')
  noteStatus('b2', 'session', 'SessionStart', 's1')
  noteStatus('b2', 'done', 'Stop', 's1')
  dropNode('b2') // 节点被删/PTY 结束
  noteStatus('b2', 'done', 'Stop', 's1') // 迟到事件；此时同 id 可能已是普通 shell

  assert.equal(isAgentSession('b2'), false)
  const { writes, d } = deps()
  const r = await delegate(d, 'src', 'b2', 'DANGEROUS', 500)
  assert.match(r, /派活被拒/)
  assert.equal(writes.length, 0)
})

test('绕过 3：无 session_id 时，授权等待期间 End→Start 必须使本次派活作废', async () => {
  dropNode('b3')
  noteStatus('b3', 'session', 'SessionStart')
  noteStatus('b3', 'done', 'Stop')

  const writes: string[] = []
  const d = {
    hasNode: (): boolean => true,
    writeToPty: (_id: string, data: string): void => void writes.push(data),
    // 授权期间目标换了会话
    authorize: async (): Promise<boolean> => {
      noteStatus('b3', 'session', 'SessionEnd')
      noteStatus('b3', 'session', 'SessionStart')
      return true
    }
  }
  const r = await delegate(d, 'src', 'b3', 'DANGEROUS', 500)
  assert.match(r, /换了会话/)
  assert.equal(writes.length, 0, '批准的是旧会话，不能打进新会话')
})

test('新会话可以正常复活', () => {
  dropNode('n2')
  noteStatus('n2', 'session', 'SessionStart', 's-n2')
  noteStatus('n2', 'session', 'SessionEnd', 's-n2')
  assert.equal(isAgentSession('n2'), false)
  noteStatus('n2', 'session', 'SessionStart', 's-n2b')
  assert.equal(isAgentSession('n2'), true)
})

test('非接单状态一律拒绝（fail-closed，不是只拒 working）', async () => {
  for (const state of ['working', 'blocked', 'waiting']) {
    dropNode('n3')
    noteStatus('n3', 'session', 'SessionStart', 's-n3')
    noteStatus('n3', state, 'PreToolUse', 's-n3')
    const { writes, d } = deps()
    const r = await delegate(d, 'src', 'n3', 'ls', 500)
    assert.match(r, /派活被拒/, `${state} 应该被拒`)
    assert.equal(writes.length, 0, `${state} 状态下不该有注入`)
  }
})

test('未授权时不注入', async () => {
  dropNode('n4')
  noteStatus('n4', 'session', 'SessionStart', 's-n4')
  noteStatus('n4', 'done', 'Stop', 's-n4')
  const { writes, d } = deps(false)
  const r = await delegate(d, 'src', 'n4', 'ls', 500)
  assert.match(r, /未获授权/)
  assert.equal(writes.length, 0)
})

test('不能派给自己', async () => {
  const { writes, d } = deps()
  const r = await delegate(d, 'same', 'same', 'ls', 500)
  assert.match(r, /不能派给自己/)
  assert.equal(writes.length, 0)
})

test('空任务拒绝', async () => {
  dropNode('n5')
  noteStatus('n5', 'session', 'SessionStart', 's-n5')
  noteStatus('n5', 'done', 'Stop', 's-n5')
  const { writes, d } = deps()
  const r = await delegate(d, 'src', 'n5', '   ', 500)
  assert.match(r, /任务为空/)
  assert.equal(writes.length, 0)
})

test('放行路径：注入任务，等到新的 Stop 后取回 transcript 末条回答', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'termscape-test-'))
  const tp = path.join(dir, 'transcript.jsonl')
  await writeFile(
    tp,
    [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '干完了' }] } })
    ].join('\n')
  )

  dropNode('n6')
  noteStatus('n6', 'session', 'SessionStart', 's-n6')
  noteStatus('n6', 'done', 'Stop', 's-n6')
  noteTranscript('n6', tp)

  const writes: string[] = []
  const d = {
    hasNode: (): boolean => true,
    writeToPty: (_id: string, data: string): void => {
      writes.push(data)
      // 模拟目标 agent：收到输入 → 开始干活 → 干完
      noteStatus('n6', 'working', 'UserPromptSubmit', 's-n6')
      setTimeout(() => noteStatus('n6', 'done', 'Stop', 's-n6'), 1600)
    },
    authorize: async (): Promise<boolean> => true
  }

  const r = await delegate(d, 'src', 'n6', '干活', 20_000)
  assert.equal(writes.length, 1)
  assert.equal(writes[0], '干活\r', '注入内容必须原样带一个回车')
  assert.equal(r, '干完了')
})
