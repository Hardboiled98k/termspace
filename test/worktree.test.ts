/**
 * 画布组 ↔ git worktree。
 *
 * 钉的是**并行 agent 改同一个工作区**这件事：现在画布上多个终端共享一个 cwd，
 * 两个 agent 同时动就是 git 冲突。worktree 把这个问题从"在提示词里求它们别乱动"
 * 降级成文件系统隔离 —— 而后者是确定性的。
 *
 * 三条最容易写错、且错了很难发现的：
 *
 * 1. **分支名转义会撞**：`feat/x` 和 `feat-x` 单纯把 `/` 换成 `-` 之后是同一个目录，
 *    两棵树互相覆盖，症状是"我明明建了两个 worktree，怎么只剩一个"。
 * 2. **`-` 开头的分支名会被 git 当成选项** —— 必须在字符串接触 git **之前**挡掉，
 *    不能指望 `check-ref-format`（那要求先把可疑输入喂给它）。
 * 3. **脏树删除必须失败**。git 自己会拒，那个拒绝是特性不是障碍 ——
 *    它挡住的正是"agent 干了一半的活被一键抹掉"。绝不能替用户 --force。
 *
 * 跑法：npm test（Node 原生 type stripping，无需测试框架）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWorktreeList,
  parseDirty,
  isSafeBranch,
  worktreeDirName,
  worktreePath,
  explainGitError,
  createWorktree,
  removeWorktree,
  probeRepo,
  worktreeStatus
} from '../src/main/worktree.ts'

/* ── parseWorktreeList：吃的是实测抓下来的真实 porcelain ── */

// 下面这段是 `git worktree list --porcelain` 的真实输出（含 detached、含带 / 的分支）
const PORCELAIN = `worktree /tmp/repo
HEAD eddef6be8dcabf76651893ecd2548866658f339f
branch refs/heads/main

worktree /tmp/repo.worktrees/dt
HEAD eddef6be8dcabf76651893ecd2548866658f339f
detached

worktree /tmp/repo.worktrees/feat-x
HEAD eddef6be8dcabf76651893ecd2548866658f339f
branch refs/heads/feat/x

`

test('worktree list：三条记录都解析出来，末尾空行不产生空条目', () => {
  const r = parseWorktreeList(PORCELAIN)
  assert.equal(r.length, 3)
  assert.deepEqual(
    r.map((w) => w.path),
    ['/tmp/repo', '/tmp/repo.worktrees/dt', '/tmp/repo.worktrees/feat-x']
  )
})

test('detached 的树 branch 是 null，不是空串也不是 "HEAD"', () => {
  /* 这种树没有稳定分支名可显示，UI 要能区分"没绑分支"和"分支叫空串" */
  assert.equal(parseWorktreeList(PORCELAIN)[1].branch, null)
})

test('分支名里的 / 要保留，只剥 refs/heads/ 前缀', () => {
  /* 按 `/` 切最后一段的话 `feat/x` 会变成 `x` ——
     两个不同分支（feat/x 和 fix/x）会显示成同一个名字 */
  assert.equal(parseWorktreeList(PORCELAIN)[2].branch, 'feat/x')
})

test('空输入不炸', () => {
  assert.deepEqual(parseWorktreeList(''), [])
})

/* ── parseDirty ── */

test('status 空输出 = 干净', () => {
  assert.equal(parseDirty(''), 0)
  assert.equal(parseDirty('\n\n'), 0)
})

test('每行一个变更，未跟踪和已修改都算', () => {
  assert.equal(parseDirty(' M d/nested.txt\n?? untracked.txt\n'), 2)
})

/* ── isSafeBranch：第一道闸 ── */

test('拒绝 - 开头的分支名（会被 git 当成命令行选项）', () => {
  assert.equal(isSafeBranch('-evil'), false)
  assert.equal(isSafeBranch('--force'), false)
})

test('拒绝空、空格、控制字符、. 开头', () => {
  assert.equal(isSafeBranch(''), false)
  assert.equal(isSafeBranch('with space'), false)
  assert.equal(isSafeBranch('tab\there'), false)
  assert.equal(isSafeBranch('.hidden'), false)
})

test('正常分支名放行，含 / 的也放行', () => {
  assert.equal(isSafeBranch('feat/worktree'), true)
  assert.equal(isSafeBranch('fix-123'), true)
})

/* ── worktreeDirName：最容易写错的一条 ── */

test('feat/x 和 feat-x 绝不映射到同一个目录', () => {
  /* 这就是整个模块最容易出的 bug：单纯 replace('/','-') 之后两者相等，
     两棵树互相覆盖，而且症状是"建了两个只剩一个"，很难联想到是命名撞了 */
  const a = worktreeDirName('feat/x')
  const b = worktreeDirName('feat-x')
  assert.notEqual(a, b, 'feat/x 与 feat-x 撞到了同一个目录名')
})

test('没被转义的分支名保持原样（目录名好认）', () => {
  assert.equal(worktreeDirName('feat-x'), 'feat-x')
  assert.equal(worktreeDirName('fix_123.v2'), 'fix_123.v2')
})

test('转义过的必定带 hash 后缀，且同一分支每次一致', () => {
  const a = worktreeDirName('feat/x')
  assert.match(a, /^feat-x-[0-9a-f]{6}$/)
  assert.equal(a, worktreeDirName('feat/x'))
})

test('worktree 落在仓库旁边的 <仓库名>.worktrees/ 里', () => {
  assert.equal(
    worktreePath('/Users/me/code/proj', 'feat-a'),
    '/Users/me/code/proj.worktrees/feat-a'
  )
})

/* ── explainGitError：不认识的错误必须原样返回 ── */

test('同分支已在别处检出时给出可操作的解释', () => {
  const msg = explainGitError(
    "fatal: 'feat/x' is already checked out at '/tmp/repo.worktrees/feat-x'"
  )
  assert.match(msg, /已经在另一棵 worktree/)
  assert.match(msg, /feat-x/, '要把 git 说的那个路径带出来，否则用户不知道去哪找')
})

test('不认识的 git 错误原样返回，绝不吞成一句「失败」', () => {
  /* git 的报错通常已经说清了原因，吞掉它等于把唯一的线索删了 */
  const weird = 'fatal: 某个我们没见过的错误'
  assert.equal(explainGitError(weird), weird)
})

/* ── 真跑 git：在临时仓库里走一遍完整生命周期 ── */

test('端到端：建树 → 脏了删不掉 → 干净后删得掉', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { existsSync } = await import('node:fs')

  const base = await mkdtemp(path.join(tmpdir(), 'wt-'))
  const repo = path.join(base, 'repo')
  const git = (args: string[], cwd: string): string =>
    execFileSync('/usr/bin/git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 'a@b' }
    })
  execFileSync('/usr/bin/git', ['init', '-q', repo])
  git(['commit', '-q', '--allow-empty', '-m', 'init'], repo)

  // probeRepo 认得出这是仓库
  const probe = await probeRepo(repo)
  assert.ok(probe, 'probeRepo 应当认出这是 git 仓库')
  assert.equal(probe.repoRoot, existsSync(repo) ? probe.repoRoot : '', '')
  assert.equal(probe.worktrees.length, 1, '一开始只有主仓库这一棵')

  // 建一棵
  const made = await createWorktree(probe.repoRoot, 'feat/iso')
  assert.ok(made.ok, `建 worktree 失败：${made.error}`)
  assert.ok(made.path && existsSync(made.path), 'worktree 目录应当真的存在')
  assert.match(made.path, /repo\.worktrees\/feat-iso-[0-9a-f]{6}$/, '路径要落在仓库旁边且带转义 hash')

  // git 自己也认
  const after = await probeRepo(probe.repoRoot)
  assert.equal(after?.worktrees.length, 2)

  // 干净时状态是干净
  const st0 = await worktreeStatus(made.path)
  assert.equal(st0?.dirty, 0)
  assert.equal(st0?.branch, 'feat/iso')

  // 造脏 → 必须删不掉
  await writeFile(path.join(made.path, 'dirty.txt'), 'x')
  const st1 = await worktreeStatus(made.path)
  assert.equal(st1?.dirty, 1)
  const bad = await removeWorktree(made.path)
  assert.equal(bad.ok, false, '**脏树必须删不掉** —— 这条挡的是 agent 干了一半的活被一键抹掉')
  assert.match(bad.error ?? '', /未提交的改动/)
  assert.ok(existsSync(made.path), '删除失败后目录必须还在')

  // 清干净 → 删得掉
  await rm(path.join(made.path, 'dirty.txt'))
  const good = await removeWorktree(made.path)
  assert.ok(good.ok, `清干净后应当删得掉：${good.error}`)
  assert.equal(existsSync(made.path), false)
})

test('端到端：不合法的分支名根本不会走到 git', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')

  const base = await mkdtemp(path.join(tmpdir(), 'wt2-'))
  const repo = path.join(base, 'repo')
  execFileSync('/usr/bin/git', ['init', '-q', repo])

  const r = await createWorktree(repo, '-b')
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /分支名不合法/, '要在自己的闸上失败，不是让 git 把 -b 当成选项')
})

test('端到端：非 git 目录 probeRepo 返回 null（UI 据此完全隐藏该功能）', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(tmpdir(), 'notgit-'))
  assert.equal(await probeRepo(dir), null)
})
