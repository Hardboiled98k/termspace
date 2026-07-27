/**
 * 远程 token 表。
 *
 * 这是"多人"的地基，必须在第二个人进来之前就正确：
 * 原来是一把共享 token，踢掉一个人 = 换 token = 把所有人一起踢掉，
 * 而且服务端不知道"谁是谁"，没法只读、没法审计、没法按人撤销。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ensureOwnerToken,
  issueToken,
  loadTokens,
  matchToken,
  revokeToken,
  toMeta,
  VIEWER_TTL_MS
} from '../src/main/remote-tokens.ts'

const tmpFile = async (): Promise<string> =>
  path.join(await mkdtemp(path.join(tmpdir(), 'rt-')), 'remote-token')

test('老格式（一行裸 token）要能吃下，且升格成 owner', async () => {
  /* 用户的手机已经用那把 token 配过对了，升级后让它失效
     等于无声地把人踢下线 */
  const f = await tmpFile()
  await writeFile(f, 'abcdef0123456789abcdef0123456789')
  const list = await loadTokens(f)
  assert.equal(list.length, 1)
  assert.equal(list[0]?.role, 'owner')
  assert.equal(list[0]?.token, 'abcdef0123456789abcdef0123456789')
})

test('老 token 升级后仍然认得（手机不用重新配对）', async () => {
  const f = await tmpFile()
  await writeFile(f, 'abcdef0123456789abcdef0123456789')
  const list = await ensureOwnerToken(f)
  assert.ok(matchToken(list, 'abcdef0123456789abcdef0123456789'))
})

test('首次启动自动建一把 owner', async () => {
  const f = await tmpFile()
  const list = await ensureOwnerToken(f)
  assert.equal(list.length, 1)
  assert.equal(list[0]?.role, 'owner')
  assert.ok((list[0]?.token.length ?? 0) >= 32)
  // 落盘的是 JSON 表，不是裸字符串
  assert.ok((await readFile(f, 'utf8')).trim().startsWith('['))
})

test('签发 viewer 默认带有效期 —— 永不过期的分享链接是负债', async () => {
  const f = await tmpFile()
  await ensureOwnerToken(f)
  const { issued } = await issueToken(f, 'viewer', '给老王')
  assert.equal(issued.role, 'viewer')
  assert.ok(issued.expiresAt)
  assert.ok(issued.expiresAt! - Date.now() > VIEWER_TTL_MS - 5000)
})

test('过期的 viewer 认不出来', async () => {
  const f = await tmpFile()
  await ensureOwnerToken(f)
  const { list, issued } = await issueToken(f, 'viewer', 'x', 1000)
  assert.ok(matchToken(list, issued.token), '没过期时应该认得')
  assert.equal(matchToken(list, issued.token, Date.now() + 5000), null, '过期后必须认不出')
})

test('撤销一个人不影响别人 —— 这正是单 token 做不到的事', async () => {
  const f = await tmpFile()
  await ensureOwnerToken(f)
  const a = (await issueToken(f, 'viewer', '甲')).issued
  const b = (await issueToken(f, 'viewer', '乙')).issued
  const after = await revokeToken(f, a.token)
  assert.equal(matchToken(after, a.token), null, '甲应被踢掉')
  assert.ok(matchToken(after, b.token), '乙不该受影响')
})

test('最后一把 owner 撤不掉（撤了就再也连不上，包括撤销别人的入口）', async () => {
  const f = await tmpFile()
  const list = await ensureOwnerToken(f)
  const owner = list[0]!
  const after = await revokeToken(f, owner.token)
  assert.ok(matchToken(after, owner.token), 'owner 必须还在')
})

test('认不出的 token 返回 null，不抛', async () => {
  const f = await tmpFile()
  const list = await ensureOwnerToken(f)
  assert.equal(matchToken(list, ''), null)
  assert.equal(matchToken(list, 'short'), null)
  assert.equal(matchToken(list, 'x'.repeat(64)), null)
})

test('给渲染层的元数据里绝不能有 token 本身', async () => {
  const f = await tmpFile()
  const { issued } = await issueToken(f, 'viewer', '给老王')
  const meta = toMeta(issued)
  const raw = JSON.stringify(meta)
  assert.ok(!raw.includes(issued.token), `元数据里漏了 token：${raw}`)
  assert.equal(meta.hint.length, 6, '只给前 6 位够认出是哪条')
})

test('文件损坏时返回空表，不把坏内容当 token', async () => {
  const f = await tmpFile()
  await writeFile(f, '{ 不是 JSON')
  assert.deepEqual(await loadTokens(f), [])
  // 短到不可能是 token 的内容也不收
  await writeFile(f, 'abc')
  assert.deepEqual(await loadTokens(f), [])
})

test('表里混进畸形条目时只丢那一条', async () => {
  const f = await tmpFile()
  await writeFile(
    f,
    JSON.stringify([
      { token: 'good0123456789abcdef0123456789ab', role: 'owner', label: 'ok', createdAt: 1 },
      { token: 'short', role: 'owner', label: 'bad', createdAt: 1 },
      { token: 'good1123456789abcdef0123456789ab', role: 'nope', label: 'bad', createdAt: 1 }
    ])
  )
  const list = await loadTokens(f)
  assert.equal(list.length, 1)
  assert.equal(list[0]?.label, 'ok')
})
