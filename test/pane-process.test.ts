/**
 * 钉的是普通工具参数中的 provider 文件名曾被误判，以及 DFS 覆盖命中导致同层结果依赖行序的 bug。
 * 解释器包装脚本和直接启动的 CLI 仍须识别，子孙选择则以离 pane 最近、同层最低 PID 为确定合同。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  descendantProvider,
  descendantPids,
  parseProcessLinks,
  parseProcessTable,
  providerFromProcessCommand
} from '../src/main/pane-process.ts'

test('解释器包装器的脚本路径能识别已知 CLI', () => {
  assert.equal(providerFromProcessCommand('/usr/bin/Python /opt/tools/codex/main.py'), 'codex')
  assert.equal(providerFromProcessCommand('/opt/homebrew/bin/node /pkg/antigravity-cli/agy.js'), 'antigravity')
  assert.equal(providerFromProcessCommand('python3 /x/codex_wrapper.py'), 'codex')
  assert.equal(providerFromProcessCommand('node /path/gemini.js'), 'gemini')
})

test('直接启动的 Antigravity CLI 能被识别', () => {
  assert.equal(providerFromProcessCommand('agy --dangerously-skip-permissions'), 'antigravity')
})

test('从 pane PID 的多层子孙识别 codex，不读取无关进程', () => {
  const rows = parseProcessTable(`
  101  100 -zsh
  102  101 /usr/bin/Python /opt/codex/main.py
  202  200 /usr/local/bin/claude
`)
  assert.equal(descendantProvider(100, rows), 'codex')
  assert.equal(descendantProvider(200, rows), 'claude')
})

test('同父的 provider 兄弟进程在正反行序下都选择最低 PID', () => {
  const forward = parseProcessTable(`
  101  100 /usr/local/bin/codex
  102  100 /usr/local/bin/claude
`)
  const reversed = [...forward].reverse()
  assert.equal(descendantProvider(100, forward), 'codex')
  assert.equal(descendantProvider(100, reversed), 'codex')
})

test('不同深度都有 provider 时选择离 pane 最近的进程', () => {
  const rows = parseProcessTable(`
  101  100 /bin/zsh
  102  101 /usr/local/bin/codex
  103  102 /usr/local/bin/claude
`)
  assert.equal(descendantProvider(100, rows), 'codex')
})

test('argv 查询目标只包含 pane 子孙 PID', () => {
  const links = parseProcessLinks('101 100\n102 101\n202 200\n')
  assert.deepEqual(descendantPids(100, links).toSorted((a, b) => a - b), [101, 102])
})

test('普通工具的文件参数提到 provider 名不会被误判', () => {
  assert.equal(providerFromProcessCommand('/bin/cat /tmp/codex.log'), null)
  assert.equal(providerFromProcessCommand('vim /Users/x/notes/claude.md'), null)
  assert.equal(providerFromProcessCommand('less /tmp/gemini-out.txt'), null)
})
