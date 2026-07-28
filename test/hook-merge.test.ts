/**
 * hook 配置的摘除。
 *
 * 钉的是一个**会伤到用户数据**的行为：安装托管 hook 时，老实现按
 * "这个 group 里有没有一条是我们的"整组过滤 —— 于是用户放在同一个 matcher group
 * 里的格式化 / 审计 / 安全 hook 会被一起删掉，而且不会有任何提示。
 *
 * 卸载路径一直是逐条摘的，安装路径一度不是。两条路现在共用这一个函数，
 * 所以这里只需要钉住这一个函数的行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripOurHandlers, isOurs } from '../src/main/hook-merge.ts'

const ours = { type: 'command', command: 'sh "/Users/x/Library/Application Support/termboard/hook.sh" Stop' }
const theirs = { type: 'command', command: 'prettier --write $CLAUDE_FILE' }
const theirs2 = { type: 'command', command: 'my-audit-log.sh' }

test('同组里用户自己的 handler 必须留下（整组删是数据损坏）', () => {
  const out = stripOurHandlers([{ matcher: 'Edit', hooks: [theirs, ours, theirs2] }])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].hooks, [theirs, theirs2])
  assert.equal(out[0].matcher, 'Edit', 'matcher 不能丢')
})

test('只有我们那一条的组整个消失（不留空壳）', () => {
  assert.deepEqual(stripOurHandlers([{ matcher: '', hooks: [ours] }]), [])
})

test('完全没我们的组原样不动', () => {
  const arr = [{ matcher: 'Write', hooks: [theirs] }]
  assert.deepEqual(stripOurHandlers(arr), arr)
})

test('本来就空的组原样留着（那是用户的结构，不替他清理）', () => {
  assert.deepEqual(stripOurHandlers([{ matcher: 'X' }]), [{ matcher: 'X' }])
  assert.deepEqual(stripOurHandlers([{ matcher: 'X', hooks: [] }]), [{ matcher: 'X', hooks: [] }])
})

test('不改入参 —— 调用方可能还要拿原数组比对有没有变化', () => {
  const g = { matcher: 'Edit', hooks: [theirs, ours] }
  stripOurHandlers([g])
  assert.equal(g.hooks.length, 2)
})

test('marker 认的是路径里的 termboard，不是命令名里随便一个词', () => {
  assert.equal(isOurs(ours.command), true)
  assert.equal(isOurs(theirs.command), false)
  assert.equal(isOurs(undefined), false)
  assert.equal(isOurs(123), false)
})
