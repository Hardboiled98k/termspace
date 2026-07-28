/**
 * 原子写的权限窗口。
 *
 * hooks.ts 里 `writeAtomic` + 随后 `chmod` 的老写法有一个真实窗口：
 * `writeFile` 用默认权限（umask 022 → **0644**）创建临时文件，rename 之后、
 * chmod 之前，那个文件是**全局可读**的。而 `bin/tb-peer` 的脚本正文里
 * 带着完整的 peer token —— 别的用户在那一瞬读走它，就能打本机回环的
 * `/tb/peer` 往任意活着的 agent 里注入任务。
 *
 * 窗口只有几毫秒，但它是可被守候的（监听目录事件即可），所以不能靠"太短了没事"。
 *
 * 这里复刻两种写法直接对比 —— hooks.ts 依赖 electron 进不来，
 * 而要钉住的性质（"权限必须在创建那一刻就生效"）是文件系统层面的，复刻得出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, stat, rename, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeAtomic } from '../src/main/write-atomic.ts'

const mode = async (f: string): Promise<number> => (await stat(f)).mode & 0o777

test('创建时不给 mode，文件会有一段全局可读的窗口', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wa-'))
  const tmp = path.join(dir, `x.${randomUUID().slice(0, 8)}.tmp`)
  await writeFile(tmp, 'SECRET')
  const before = await mode(tmp)
  await chmod(tmp, 0o600)

  // 这就是老写法的窗口：chmod 之前它不是 0600
  assert.notEqual(before, 0o600, `期望看到默认权限（通常 0644），实际 ${before.toString(8)}`)
  assert.ok((before & 0o077) !== 0, `其他用户在这个窗口里读得到：${before.toString(8)}`)
})

test('创建时就给 mode，任何时刻都不是全局可读', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wa-'))
  const tmp = path.join(dir, `y.${randomUUID().slice(0, 8)}.tmp`)
  const final = path.join(dir, 'y')

  await writeFile(tmp, 'SECRET', { mode: 0o600 })
  assert.equal(await mode(tmp), 0o600, '创建那一刻就该是 0600')
  await chmod(tmp, 0o600) // 兜底（文件已存在时 writeFile 不改权限）
  await rename(tmp, final)
  // rename 保留 inode 和权限，所以落地时也是 0600
  assert.equal(await mode(final), 0o600, 'rename 之后仍然是 0600')
})

test('可执行的 helper 同理：0700 要在创建时生效', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wa-'))
  const f = path.join(dir, 'tb-peer')
  await writeFile(f, '#!/bin/sh\necho hi\n', { mode: 0o700 })
  const m = await mode(f)
  assert.equal(m & 0o077, 0, `别的用户不该有任何权限：${m.toString(8)}`)
  assert.ok(m & 0o100, '自己要能执行')
})

/* 上面三条钉的是**文件系统的性质**（复刻两种写法对比）。下面这条跑的是
   真正在用的那个函数 —— 它现在被 hooks.ts 和 remote-tokens.ts 共用。

   ⚠️ 说实话：这条测不出"创建那一刻"与"写完再 chmod"的差别，那是个时间窗口，
   落地结果一模一样。它能钉住的是：调用方给了 mode，落地文件就必须是那个 mode
   （曾经 remote-tokens 根本没走这个函数），且不留 .tmp 残骸。 */
test('真的 writeAtomic：给了 mode 就落地成那个 mode，且不留临时文件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wa-'))
  const f = path.join(dir, 'tokens.json')
  await writeAtomic(f, '{"token":"SECRET"}', 0o600)
  assert.equal(await mode(f), 0o600)
  assert.equal(await readFile(f, 'utf8'), '{"token":"SECRET"}')
  assert.deepEqual(
    (await readdir(dir)).filter((n) => n.endsWith('.tmp')),
    [],
    '临时文件没清干净'
  )
})

test('真的 writeAtomic：覆盖已存在的文件也要收紧权限', async () => {
  // 老文件可能是 0644（升级前写的），覆盖时必须顺手收紧，不能沿用
  const dir = await mkdtemp(path.join(tmpdir(), 'wa-'))
  const f = path.join(dir, 'tokens.json')
  await writeFile(f, 'old', { mode: 0o644 })
  await writeAtomic(f, 'new', 0o600)
  assert.equal(await mode(f), 0o600)
})
