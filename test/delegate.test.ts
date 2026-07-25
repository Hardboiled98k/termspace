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

test('新会话可以正常复活', () => {
  dropNode('n2')
  noteStatus('n2', 'session', 'SessionStart', 's-1')
  noteStatus('n2', 'session', 'SessionEnd', 's-1')
  assert.equal(isAgentSession('n2'), false)
  noteStatus('n2', 'session', 'SessionStart', 's-2')
  assert.equal(isAgentSession('n2'), true)
})

test('非接单状态一律拒绝（fail-closed，不是只拒 working）', async () => {
  for (const state of ['working', 'blocked', 'waiting']) {
    dropNode('n3')
    noteStatus('n3', state, 'PreToolUse', 's-1')
    const { writes, d } = deps()
    const r = await delegate(d, 'src', 'n3', 'ls', 500)
    assert.match(r, /派活被拒/, `${state} 应该被拒`)
    assert.equal(writes.length, 0, `${state} 状态下不该有注入`)
  }
})

test('未授权时不注入', async () => {
  dropNode('n4')
  noteStatus('n4', 'done', 'Stop', 's-1')
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
  noteStatus('n5', 'done', 'Stop', 's-1')
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
  noteStatus('n6', 'done', 'Stop', 's-1')
  noteTranscript('n6', tp)

  const writes: string[] = []
  const d = {
    hasNode: (): boolean => true,
    writeToPty: (_id: string, data: string): void => {
      writes.push(data)
      // 模拟目标 agent：收到输入 → 开始干活 → 干完
      noteStatus('n6', 'working', 'UserPromptSubmit', 's-1')
      setTimeout(() => noteStatus('n6', 'done', 'Stop', 's-1'), 1600)
    },
    authorize: async (): Promise<boolean> => true
  }

  const r = await delegate(d, 'src', 'n6', '干活', 20_000)
  assert.equal(writes.length, 1)
  assert.equal(writes[0], '干活\r', '注入内容必须原样带一个回车')
  assert.equal(r, '干完了')
})
