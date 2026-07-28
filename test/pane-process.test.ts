/**
 * 钉的是普通 zsh 里手敲 codex 后仍只计到一个终端。
 * pane_current_command 会报 Python/node；必须沿 pane PID 子孙的 argv 找包装器脚本。
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

test('Python 和 Node 包装器的脚本路径能识别已知 CLI', () => {
  assert.equal(providerFromProcessCommand('/usr/bin/Python /opt/tools/codex/main.py'), 'codex')
  assert.equal(providerFromProcessCommand('/opt/homebrew/bin/node /pkg/antigravity-cli/agy.js'), 'antigravity')
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

test('argv 查询目标只包含 pane 子孙 PID', () => {
  const links = parseProcessLinks('101 100\n102 101\n202 200\n')
  assert.deepEqual(descendantPids(100, links).toSorted((a, b) => a - b), [101, 102])
})

test('参数正文提到 codex 不会被误判', () => {
  assert.equal(providerFromProcessCommand('/bin/zsh -c echo-codex'), null)
})
