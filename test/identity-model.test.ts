/**
 * 钉住凭证旧数据迁移与 IPC DTO 的密钥边界。
 *
 * 这里坏掉会让旧订阅号静默改走 API 计费，或让已保存明文越过主进程进入渲染层。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identityMeta, migrateIdentity } from '../src/main/identity-model.ts'

test('旧数据的空字符串迁移为 unset，绝不是 set 空串', () => {
  const migrated = migrateIdentity({
    id: 'old',
    name: '旧 Codex 订阅号',
    provider: 'codex',
    env: { CODEX_HOME: '~/.codex-work', OPENAI_API_KEY: '' }
  })

  assert.deepEqual(migrated.envOps, [
    { key: 'CODEX_HOME', action: 'set', value: '~/.codex-work' },
    { key: 'OPENAI_API_KEY', action: 'unset' }
  ])
  assert.equal(migrated.envOps[1]?.action, 'unset')
  assert.equal(Object.hasOwn(migrated.envOps[1] ?? {}, 'value'), false)
})

test('渲染层 DTO 的每一条环境操作都没有 value 字段', () => {
  const dto = identityMeta({
    id: 'secret',
    name: '工作 key',
    provider: 'custom',
    envOps: [
      { key: 'OPENAI_API_KEY', action: 'set', value: 'sk-DO-NOT-LEAK' },
      { key: 'ANTHROPIC_API_KEY', action: 'unset' }
    ]
  })

  assert.equal(dto.id, 'secret')
  assert.equal(dto.name, '工作 key')
  assert.equal(dto.provider, 'custom')
  assert.equal(dto.envOps.length, 2)
  for (const op of dto.envOps) {
    assert.deepEqual(Object.keys(op).toSorted(), ['action', 'key'])
    assert.equal(Object.hasOwn(op, 'value'), false)
  }
  assert.equal(JSON.stringify(dto).includes('sk-DO-NOT-LEAK'), false)
})

