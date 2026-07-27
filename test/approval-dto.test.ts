/**
 * 审批记录出主进程前的脱敏。
 *
 * 这条曾经真的漏过：脱敏只写在 listApprovals 里，而实时推送走 publish → onApprovals
 * 那条路，直接吐了完整记录 —— 完整 tool_input（可能含文件正文、命令、密钥）
 * 进了 renderer，还从 /api/events 出了网。所以这里钉的是**字段白名单**：
 * 将来给 PendingApprovalFull 加字段，默认不外泄，这个用例会先炸。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toPublicApproval, type PendingApprovalFull } from '../src/main/approval-dto.ts'

const full: PendingApprovalFull = {
  id: 'a1',
  nodeId: 't1',
  toolName: 'Write',
  summary: '/Users/x/proj/.env …',
  toolUseId: 'tu_1',
  createdAt: 1,
  sessionId: 's1',
  cwd: '/Users/x/proj',
  inputHash: 'deadbeef',
  rawInput: { file_path: '/Users/x/proj/.env', content: 'OPENAI_KEY=sk-SECRET-DO-NOT-LEAK' },
  permissionMode: 'default'
}

test('脱敏后的字段是固定白名单，多一个都不行', () => {
  assert.deepEqual(Object.keys(toPublicApproval(full)).toSorted(), [
    'createdAt',
    'cwd',
    'id',
    'inputHash',
    'nodeId',
    'sessionId',
    'summary',
    'toolName',
    'toolUseId'
  ])
})

test('序列化后不含 rawInput / permissionMode / 任何密钥字面量', () => {
  const s = JSON.stringify(toPublicApproval(full))
  assert.ok(!s.includes('rawInput'), 'rawInput 泄露了')
  assert.ok(!s.includes('permissionMode'), 'permissionMode 泄露了')
  assert.ok(!s.includes('SECRET-DO-NOT-LEAK'), '工具输入正文泄露了')
})

test('未来新增的字段默认不外泄（逐字段构造，不是 spread）', () => {
  const withExtra = { ...full, someFutureSecret: 'nope' } as PendingApprovalFull
  assert.ok(!JSON.stringify(toPublicApproval(withExtra)).includes('nope'))
})
