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

test('目录名 = 好认的前缀 + hash，同一分支每次一致', () => {
  assert.match(worktreeDirName('feat-x'), /^feat-x-[0-9a-f]{12}$/)
  assert.match(worktreeDirName('fix_123.v2'), /^fix_123\.v2-[0-9a-f]{12}$/)
  assert.equal(worktreeDirName('feat/x'), worktreeDirName('feat/x'))
})

test('输出名本身当分支名喂回去，也不会撞（老实现的反例）', () => {
  /* 老实现是"只有转义过才加 hash"：`feat/x` → `feat-x-79b4cc`，
     而 `feat-x-79b4cc` 是合法分支名、不需转义、原样返回 —— 两者同一个目录。
     注释当时还写着"两者永不相等"。codex 对手方审查逮到的。 */
  const a = worktreeDirName('feat/x')
  assert.notEqual(a, worktreeDirName(a), `${a} 和它自己当分支名时撞了`)
})

test('批量：一千个相近分支名，目录名互不相同', () => {
  const names = []
  for (let i = 0; i < 250; i++) {
    names.push(`feat/x${i}`, `feat-x${i}`, `feat.x${i}`, `feat x${i}`.replace(' ', '/'))
  }
  const dirs = new Set(names.map(worktreeDirName))
  assert.equal(dirs.size, new Set(names).size, '有分支名映射到了同一个目录')
})

test('超长分支名不会造出超长目录（前缀截断，唯一性靠 hash）', () => {
  const long = 'feat/' + 'a'.repeat(300)
  const d = worktreeDirName(long)
  assert.ok(d.length <= 53, `目录名太长：${d.length}`)
  assert.notEqual(d, worktreeDirName(long + 'b'), '截断之后仍要互不相同')
})

test('worktree 落在仓库旁边的 <仓库名>.worktrees/ 里', () => {
  assert.match(
    worktreePath('/Users/me/code/proj', 'feat-a'),
    /^\/Users\/me\/code\/proj\.worktrees\/feat-a-[0-9a-f]{12}$/
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
  const { existsSync, realpathSync } = await import('node:fs')

  const base = await mkdtemp(path.join(tmpdir(), 'wt-'))
  // 用例里 mkdtemp 出来的仓库要收干净，否则每跑一次测试就在临时目录多留一个仓库
  try {
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
    /* ⚠️ 这条原来写的是 `assert.equal(probe.repoRoot, existsSync(repo) ? probe.repoRoot : '')`
       —— 等价于 `assert.equal(x, x)`，probeRepo 返回任意字符串都能通过。
       codex 对手方审查逮到的。要和**真的仓库路径**比，且两边都 realpath：
       macOS 的 /var 是 /private/var 的符号链接，git 吐的是解析后的路径。 */
    assert.equal(realpathSync(probe.repoRoot), realpathSync(repo), 'repoRoot 必须就是那个仓库')
    assert.equal(probe.worktrees.length, 1, '一开始只有主仓库这一棵')

    // 建一棵
    const made = await createWorktree(probe.repoRoot, 'feat/iso')
    assert.ok(made.ok, `建 worktree 失败：${made.error}`)
    assert.ok(made.path && existsSync(made.path), 'worktree 目录应当真的存在')
    assert.match(made.path, /repo\.worktrees\/feat-iso-[0-9a-f]{12}$/, '路径要落在仓库旁边且带 hash')

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
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('端到端：不合法的分支名根本不会走到 git', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')

  const { rm } = await import('node:fs/promises')
  const base = await mkdtemp(path.join(tmpdir(), 'wt2-'))
  try {
      const repo = path.join(base, 'repo')
      execFileSync('/usr/bin/git', ['init', '-q', repo])

      const r = await createWorktree(repo, '-b')
      assert.equal(r.ok, false)
      assert.match(r.error ?? '', /分支名不合法/, '要在自己的闸上失败，不是让 git 把 -b 当成选项')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('端到端：非 git 目录 probeRepo 返回 null（UI 据此完全隐藏该功能）', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { rm } = await import('node:fs/promises')
  const dir = await mkdtemp(path.join(tmpdir(), 'notgit-'))
  try {
      assert.equal(await probeRepo(dir), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('端到端：删除只认该仓库列出的 worktree，且不许删主仓库', async () => {
  /* removeWorktree 是这四个 IPC 里唯一破坏性的那个，入参却是一条裸路径。
     不做归属校验的话，传错/被构造的路径会让 git 去动一棵不相干的树 ——
     git 大多会自己拒，但"大多"不是判据。codex 对手方审查提的。 */
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')

  const base = await mkdtemp(path.join(tmpdir(), 'wt3-'))
  try {
    const repo = path.join(base, 'repo')
    execFileSync('/usr/bin/git', ['init', '-q', repo])
    execFileSync('/usr/bin/git', ['commit', '-q', '--allow-empty', '-m', 'i'], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 'a@b' }
    })
    const made = await createWorktree(repo, 'feat/z')
    assert.ok(made.ok && made.path)

    // 主仓库本身不是可删的 worktree
    const main = await removeWorktree(repo)
    assert.equal(main.ok, false)
    assert.match(main.error ?? '', /主仓库/)

    // 相对路径直接拒（不给 git 机会按进程 cwd 解析）
    const rel = await removeWorktree('repo')
    assert.equal(rel.ok, false)
    assert.match(rel.error ?? '', /路径不合法/)

    // 真的那棵删得掉
    assert.ok((await removeWorktree(made.path as string)).ok)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
