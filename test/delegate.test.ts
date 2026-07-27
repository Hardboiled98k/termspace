/**
 * 派活准入的 smoke test —— 这是全项目最危险的一段逻辑：
 * 判错一次就等于把任意文本当命令敲进用户的 shell。
 *
 * 跑法：npm test（Node 原生 type stripping，无需测试框架）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { delegate, noteStatus, noteTranscript, isAgentSession, dropNode, assistantText, isShellForeground } from '../src/main/delegate.ts'

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

test('放行路径：回答必须是**本轮新写入**的，不能是 transcript 里原有的旧答案', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'termscape-test-'))
  const tp = path.join(dir, 'transcript.jsonl')
  /* 关键：派活**之前**文件里就已经有一条 assistant 回答。
     老实现直接取"最后一条 assistant"，于是这条陈年旧答案会被当成本轮结果交回去 ——
     而原来的测试正是在派活前把"干完了"写好，等于把这个 bug 钉成了正确行为。 */
  const stale = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '这是上一轮的旧答案' }] }
  })
  await writeFile(tp, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n${stale}\n`)

  dropNode('n6')
  noteStatus('n6', 'session', 'SessionStart', 's-n6')
  noteStatus('n6', 'done', 'Stop', 's-n6')
  noteTranscript('n6', tp)

  const writes: string[] = []
  const d = {
    hasNode: (): boolean => true,
    writeToPty: (_id: string, data: string): void => {
      writes.push(data)
      // 模拟目标 agent：收到输入 → 开始干活 → 写下本轮回答 → 干完
      noteStatus('n6', 'working', 'UserPromptSubmit', 's-n6')
      setTimeout(() => {
        void appendFile(
          tp,
          `${JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: '本轮的新答案' }] }
          })}\n`
        ).then(() => noteStatus('n6', 'done', 'Stop', 's-n6'))
      }, 1600)
    },
    authorize: async (): Promise<boolean> => true
  }

  const r = await delegate(d, 'src', 'n6', '干活', 20_000)
  assert.equal(writes.length, 1)
  assert.equal(writes[0], '干活\r', '注入内容必须原样带一个回车')
  assert.equal(r, '本轮的新答案')
})

test('目标完成了但本轮没写正文 → 明说"没有新回答"，绝不返回旧答案', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'termscape-test-'))
  const tp = path.join(dir, 'transcript.jsonl')
  await writeFile(
    tp,
    `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '几分钟前的旧答案' }] }
    })}\n`
  )
  dropNode('n7')
  noteStatus('n7', 'session', 'SessionStart', 's-n7')
  noteStatus('n7', 'done', 'Stop', 's-n7')
  noteTranscript('n7', tp)

  const d = {
    hasNode: (): boolean => true,
    writeToPty: (): void => {
      noteStatus('n7', 'working', 'UserPromptSubmit', 's-n7')
      // 本轮只调了工具、没有文本正文
      setTimeout(() => {
        void appendFile(
          tp,
          `${JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] }
          })}\n`
        ).then(() => noteStatus('n7', 'done', 'Stop', 's-n7'))
      }, 1600)
    },
    authorize: async (): Promise<boolean> => true
  }
  const r = await delegate(d, 'src', 'n7', '干活', 20_000)
  assert.doesNotMatch(r, /旧答案/, '绝不能把上一轮的回答当成本轮结果')
  assert.match(r, /本轮没有新的文本回答/)
})

test('秒完成的任务不能被判成"不像活跃 agent"', async () => {
  /* 轮询每 1.5s 采样一次 status，一个 1 秒内跑完的任务整段错过 working，
     老实现 12s 后返回"不像活跃 agent 会话"，而它早就做完了。 */
  const dir = await mkdtemp(path.join(tmpdir(), 'termscape-test-'))
  const tp = path.join(dir, 'transcript.jsonl')
  await writeFile(tp, '')
  dropNode('n8')
  noteStatus('n8', 'session', 'SessionStart', 's-n8')
  noteStatus('n8', 'done', 'Stop', 's-n8')
  noteTranscript('n8', tp)

  const d = {
    hasNode: (): boolean => true,
    writeToPty: (): void => {
      // working 和 done 在同一拍内发生，轮询永远看不到 working
      noteStatus('n8', 'working', 'UserPromptSubmit', 's-n8')
      void appendFile(
        tp,
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '秒完成' }] }
        })}\n`
      ).then(() => noteStatus('n8', 'done', 'Stop', 's-n8'))
    },
    authorize: async (): Promise<boolean> => true
  }
  const r = await delegate(d, 'src', 'n8', '干活', 20_000)
  assert.equal(r, '秒完成')
})

// ── transcript 解析：两家格式都要认 ─────────────────────────────────────────

test('取回答认得 Claude Code 的 transcript 行', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '做完了' }] }
  })
  assert.equal(assistantText(line), '做完了')
})

test('取回答认得 codex 的 rollout 行', () => {
  /* 真实形状（取自 ~/.codex/sessions/.../rollout-*.jsonl）。
     只认 Claude 那套时，claude → codex 派活会"注入成功、完成检测成功、
     但取不回答案"—— 半通的链路比不通更难查 */
  const line = JSON.stringify({
    timestamp: '2026-07-27T05:19:43.746Z',
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_0c2',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'codex 干完了' }]
    }
  })
  assert.equal(assistantText(line), 'codex 干完了')
})

test('取回答跳过工具调用块，只要文本', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } },
        { type: 'text', text: '正文' }
      ]
    }
  })
  assert.equal(assistantText(line), '正文')
})

test('取回答对 user 行 / 撕裂行返回空，不误当成答案', () => {
  assert.equal(assistantText(JSON.stringify({ type: 'user', message: { content: '问题' } })), '')
  assert.equal(assistantText('{"type":"assis'), '')
  assert.equal(assistantText(''), '')
  // codex 的非 assistant response_item（工具输出等）也不能当答案
  assert.equal(
    assistantText(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } })),
    ''
  )
})

// ── 注入前的前台进程闸（P0：SessionEnd 丢了就往 shell 里执行任务）─────────────

test('前台是普通 shell 时拒绝注入 —— 一个字都不能写进去', async () => {
  /* 复现路径：agent 退出 → SessionEnd 的 curl 失败（hook 是 fail-open 的）
     → 主进程仍认为 live=true,status=done → 老实现直接把任务写进 pty，
     而 pane 里是 zsh，那一行就是被执行的命令。实测过 `rm -rf …\r` 真的写进去了。 */
  dropNode('sh1')
  noteStatus('sh1', 'session', 'SessionStart', 's-sh1')
  noteStatus('sh1', 'done', 'Stop', 's-sh1')
  const writes: string[] = []
  const r = await delegate(
    {
      hasNode: (): boolean => true,
      writeToPty: (_id: string, d: string): void => {
        writes.push(d)
      },
      foreground: async (): Promise<string> => 'zsh',
      authorize: async (): Promise<boolean> => true
    },
    'src',
    'sh1',
    'rm -rf /tmp/DEMO',
    3000
  )
  assert.equal(writes.length, 0, '被拒时绝不能有任何注入')
  assert.match(r, /普通 shell/)
})

test('查不到前台进程时不一刀切拒（没开 tmux 的用户还要能用）', async () => {
  dropNode('sh2')
  noteStatus('sh2', 'session', 'SessionStart', 's-sh2')
  noteStatus('sh2', 'done', 'Stop', 's-sh2')
  const writes: string[] = []
  await delegate(
    {
      hasNode: (): boolean => true,
      writeToPty: (_id: string, d: string): void => {
        writes.push(d)
      },
      foreground: async (): Promise<string> => '', // 查不到
      authorize: async (): Promise<boolean> => true
    },
    'src',
    'sh2',
    '干活',
    2000
  )
  assert.equal(writes.length, 1)
})

test('认不出的进程名放行（agent 的进程名列不全，别误拦新 CLI）', () => {
  for (const shell of ['zsh', '-zsh', '/bin/bash', 'fish', 'SH']) {
    assert.equal(isShellForeground(shell), true, `${shell} 应判成 shell`)
  }
  for (const agent of ['claude', 'codex', 'node', 'python3', 'bun', 'aider']) {
    assert.equal(isShellForeground(agent), false, `${agent} 不该被当成 shell`)
  }
})
