/**
 * 钉住旧格式凭证迁移重写失败时被误判成“库读不出来”的 bug：
 * 内存中的凭证不能在首次启动消失，后续读取和真实写入也不能被永久锁死。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

test('迁移重写失败后仍返回全部凭证，并允许下一次写入补落新格式', async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'termspace-identity-migrate-'))
  try {
    const projectRoot = path.resolve(import.meta.dirname, '..')
    const source = await readFile(path.join(projectRoot, 'src/main/identity-store.ts'), 'utf8')
    const isolatedSource = source
      .replace("from 'electron'", "from './electron-stub.ts'")
      .replaceAll("from './identity-env'", "from './identity-env.ts'")
      .replace("from './login-status.ts'", "from './login-status.ts'")

    await Promise.all([
      writeFile(path.join(fixtureDir, 'identity-store.ts'), isolatedSource),
      writeFile(
        path.join(fixtureDir, 'identity-model.ts'),
        await readFile(path.join(projectRoot, 'src/main/identity-model.ts'), 'utf8')
      ),
      writeFile(
        path.join(fixtureDir, 'electron-stub.ts'),
        `import path from 'node:path'
export const app = { getPath: () => ${JSON.stringify(fixtureDir)} }
let encryptCalls = 0
export const safeStorage = {
  decryptString: (buf: Buffer) => buf.toString('utf8'),
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => {
    encryptCalls++
    if (encryptCalls === 1) throw new Error('模拟迁移写盘失败')
    return Buffer.from(text)
  }
}
`
      ),
      writeFile(
        path.join(fixtureDir, 'identity-env.ts'),
        `export type ResolvedEnv = Record<string, string>
export const applyIdentityEnv = () => ({})
export const billingKind = () => 'subscription'
export const isReservedEnvKey = () => false
export const materializeEnvOps = () => []
export const materializeEnv = () => ({})
`
      ),
      writeFile(
        path.join(fixtureDir, 'login-status.ts'),
        `export type LoginStatus = unknown
export const parseClaudeAuth = () => null
export const parseCodexLogin = () => null
`
      )
    ])

    const legacy = [
      { id: 'claude-1', name: 'Claude 主号', provider: 'claude', env: { CLAUDE_CONFIG_DIR: '/a' } },
      { id: 'codex-1', name: 'Codex 主号', provider: 'codex', env: { CODEX_HOME: '/b' } }
    ]
    await writeFile(path.join(fixtureDir, 'identities.bin'), JSON.stringify(legacy))

    const store = await import(`${pathToFileURL(path.join(fixtureDir, 'identity-store.ts')).href}?case=migrate`)
    const first = await store.listIdentities()
    assert.deepEqual(
      first.map((identity: { id: string }) => identity.id),
      ['claude-1', 'codex-1'],
      '迁移重写失败不能让启动时的凭证列表变空'
    )

    const second = await store.listIdentities()
    assert.deepEqual(
      second.map((identity: { id: string }) => identity.id),
      ['claude-1', 'codex-1'],
      '缓存短路后仍应返回同一批真实凭证'
    )

    const updated = await store.upsertIdentity({
      name: '新增账号',
      provider: 'custom',
      envOps: [{ key: 'CUSTOM_TOKEN', action: 'set', value: 'secret' }]
    })
    assert.equal(updated.length, 3, '迁移重写失败不能把凭证库永久锁成只读')

    const onDisk = JSON.parse(await readFile(path.join(fixtureDir, 'identities.bin'), 'utf8'))
    assert.equal(onDisk.length, 3, '下一次真实写入必须把迁移后的完整列表补落盘')
    assert.equal('env' in onDisk[0], false, '补落盘后必须使用 envOps 新格式')
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})
