/**
 * git worktree —— 并行 agent 的**物理隔离**。
 *
 * 画布上一个组 = 一棵 worktree。多个 agent 同时改一个仓库时，与其在提示词里
 * 求它们别乱动，不如让它们根本看不见彼此的工作树。这是把"让 AI 别乱改"
 * 从提示词工程问题降级成文件系统问题 —— 而后者是确定性的。
 *
 * 本文件分两层：**纯解析函数**（可测，无副作用）+ 薄薄一层 `execFile` 封装。
 * 判据全在纯函数里，子进程那层只负责跑命令和翻译错误。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import path from 'node:path'

export interface WorktreeEntry {
  path: string
  head: string
  /** detached HEAD 时为 null —— 这种树不该被绑到组上（没有稳定的分支名可显示） */
  branch: string | null
}

/* ─────────────────── 纯函数 ─────────────────── */

/**
 * 解析 `git worktree list --porcelain`。
 *
 * 格式是**空行分隔的记录**（末尾也有一个空行）：
 *
 *     worktree /path/to/repo
 *     HEAD eddef6be…
 *     branch refs/heads/main
 *     ⏎
 *     worktree /path/to/repo.worktrees/dt
 *     HEAD eddef6be…
 *     detached
 *
 * ⚠️ `branch` 的值是**全 ref**（`refs/heads/feat/x`），要剥掉前缀；
 * 而分支名本身可以含 `/`，所以只能剥前缀，不能按 `/` 切最后一段
 * —— 那样 `feat/x` 会变成 `x`，两个不同分支显示成同一个名字。
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  for (const block of porcelain.split(/\n\s*\n/)) {
    let p = '',
      head = '',
      branch: string | null = null
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) p = line.slice(9)
      else if (line.startsWith('HEAD ')) head = line.slice(5)
      else if (line.startsWith('branch ')) branch = line.slice(7).replace(/^refs\/heads\//, '')
    }
    if (p) out.push({ path: p, head, branch })
  }
  return out
}

/**
 * `git status --porcelain` 的脏文件数。每行一个变更（`?? 未跟踪` / ` M 已改`）。
 * 空输出 = 干净。**只数行不解析状态** —— UI 只需要"脏不脏、脏几个"。
 */
export function parseDirty(porcelain: string): number {
  return porcelain.split('\n').filter((l) => l.trim() !== '').length
}

/**
 * 分支名能不能安全地交给 git。
 *
 * **这是第一道闸，必须在字符串接触 git 之前判**：`-` 开头的名字会被 git 当成
 * 命令行选项。虽然 `git check-ref-format --branch` 也会拒，但那要求先把这个
 * 字符串传进去 —— 判据不能建立在"把可疑输入喂给它自己"上。
 *
 * 剩下的合法性（`~^:?*[`、`.lock` 结尾、连续 `..` 等一长串规则）交给
 * `git check-ref-format --branch`，别在这儿重写一份必然落后于 git 的正则。
 */
export function isSafeBranch(name: string): boolean {
  if (!name || name.length > 200) return false
  if (name.startsWith('-')) return false // 会被当成选项
  if (name.startsWith('.')) return false // git 也禁，但这条影响目录名，自己也要挡
  if (/[\s\x00-\x1f\x7f]/.test(name)) return false // 空白与控制字符
  return true
}

/**
 * 分支名 → 目录名。
 *
 * **最容易写错的一条**：分支名可以含 `/`，直接拿来当目录会建出嵌套结构；
 * 而单纯把 `/` 换成 `-` 又会让 `feat/x` 和 `feat-x` **撞进同一个目录** ——
 * 两棵不同的树互相覆盖，症状是"我明明建了两个 worktree，怎么只有一个"。
 *
 * 第一版是"只有转义过才加 hash"，并在注释里写了"两者永不相等" —— **那是错的**：
 * `worktreeDirName('feat/x')` 得到 `feat-x-79b4cc`，而 `feat-x-79b4cc` 本身
 * 是个合法分支名、不需要转义、原样返回 —— 两者撞在同一个目录上。
 * （codex 对手方审查逮到的：一个"看起来严谨、实际有反例"的判据。）
 *
 * 现在**一律加 hash**。目录名丑一点，但这是个不变量而不是一个大概率成立的启发式：
 * 前缀只负责好认，唯一性完全由 hash 承担。12 hex（48 bit）足够 ——
 * 一个仓库里的分支数量级下碰撞概率可以忽略。
 */
export function worktreeDirName(branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40)
  return `${safe}-${createHash('sha256').update(branch).digest('hex').slice(0, 12)}`
}

/**
 * worktree 的落地路径：`<仓库父目录>/<仓库名>.worktrees/<目录名>`。
 *
 * 放仓库旁边而不是 app 的数据目录：worktree 是一份**真实工作副本**，
 * 用户会想用编辑器打开它、会想 `cd` 进去。
 * `~/Library/Application Support/` 是带空格的隐藏深路径，那些都做不了。
 *
 * 这个目录在主仓库**之外**，所以不需要动 `.gitignore`。
 */
export function worktreePath(repoRoot: string, branch: string): string {
  const parent = path.dirname(repoRoot)
  const base = path.basename(repoRoot)
  return path.join(parent, `${base}.worktrees`, worktreeDirName(branch))
}

/**
 * 把 git 的 stderr 翻译成用户能看懂的话。
 *
 * **不认识的错误原样返回**，绝不吞成一句"创建失败" —— git 的报错通常已经
 * 说清了原因（比如"该分支已在别处检出"），吞掉它等于把唯一的线索删了。
 */
export function explainGitError(stderr: string): string {
  const s = stderr.trim()
  if (/is already checked out at/.test(s)) {
    const at = /is already checked out at '([^']+)'/.exec(s)?.[1]
    return `这个分支已经在另一棵 worktree 里检出了${at ? `：${at}` : ''}。git 不允许同一分支同时检出两处 —— 换个分支名，或者直接用那棵树。`
  }
  if (/already exists/.test(s)) return `目标目录已经存在：${s}`
  if (/contains modified or untracked files/.test(s)) {
    return '这棵 worktree 里有未提交的改动。先提交或丢弃它们再删 —— 不会替你 --force。'
  }
  if (/not a git repository/.test(s)) return '这个目录不是 git 仓库。'
  if (/Permission denied/i.test(s)) return `没有写权限：${s}`
  return s || '未知错误'
}

/* ─────────────────── 子进程层 ─────────────────── */

/** Finder 启动不继承登录 shell 的 PATH —— 和 codex 采集踩过的是同一个坑 */
const gitBin = (): string | null =>
  ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find(existsSync) ?? null

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

function runGit(args: string[], cwd?: string, timeout = 15_000): Promise<GitResult> {
  const bin = gitBin()
  if (!bin) return Promise.resolve({ ok: false, stdout: '', stderr: '本机没找到 git' })
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' })
    )
  })
}

export interface RepoProbe {
  repoRoot: string
  branch: string | null
  worktrees: WorktreeEntry[]
}

/**
 * 这个目录是不是 git 仓库；是的话它的根、当前分支、以及全部 worktree。
 * **不是仓库就返回 null** —— UI 据此把整个功能藏起来，而不是显示一个禁用的按钮。
 */
export async function probeRepo(cwd: string): Promise<RepoProbe | null> {
  if (!cwd || !existsSync(cwd)) return null
  const root = await runGit(['rev-parse', '--show-toplevel'], cwd)
  if (!root.ok) return null
  const repoRoot = root.stdout.trim()
  if (!repoRoot) return null
  const [br, list] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    runGit(['worktree', 'list', '--porcelain'], repoRoot)
  ])
  const branch = br.ok ? br.stdout.trim() : ''
  return {
    repoRoot,
    branch: branch && branch !== 'HEAD' ? branch : null,
    worktrees: list.ok ? parseWorktreeList(list.stdout) : []
  }
}

/** 一棵树的分支与脏文件数。路径不存在（被外部删了）时返回 null */
export async function worktreeStatus(
  wtPath: string
): Promise<{ branch: string | null; dirty: number } | null> {
  if (!wtPath || !existsSync(wtPath)) return null
  const [br, st] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath),
    runGit(['status', '--porcelain'], wtPath)
  ])
  if (!st.ok) return null
  const branch = br.ok ? br.stdout.trim() : ''
  return { branch: branch && branch !== 'HEAD' ? branch : null, dirty: parseDirty(st.stdout) }
}

export interface CreateResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * 建一棵 worktree。分支不存在就顺带建（`-b`）；已存在就检出它。
 *
 * 两道校验都在把字符串交给 git **之前**：`isSafeBranch` 挡掉 `-` 开头和控制字符，
 * `check-ref-format` 挡掉 git 自己那一长串规则。
 */
export async function createWorktree(repoRoot: string, branch: string): Promise<CreateResult> {
  if (!isSafeBranch(branch)) {
    return { ok: false, error: '分支名不合法（不能为空、以 - 或 . 开头、含空格或控制字符）' }
  }
  const fmt = await runGit(['check-ref-format', '--branch', branch])
  if (!fmt.ok) return { ok: false, error: `git 不接受这个分支名：${branch}` }

  const dest = worktreePath(repoRoot, branch)
  if (existsSync(dest)) return { ok: false, error: `目标目录已经存在：${dest}` }

  /* 父目录可写先判掉。不判的话 git 会报一句原始的 mkdir 错误，
     而用户看到的是"创建失败"外加一串路径，很难联想到是权限问题。 */
  const parent = path.dirname(path.dirname(dest))
  try {
    await access(parent, constants.W_OK)
  } catch {
    return { ok: false, error: `没有写权限，建不了 worktree 目录：${parent}` }
  }

  // 分支已存在就不能再 -b
  const exists = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)
  const args = exists.ok
    ? ['worktree', 'add', dest, branch]
    : ['worktree', 'add', '-b', branch, dest]
  const r = await runGit(args, repoRoot, 60_000)
  return r.ok ? { ok: true, path: dest } : { ok: false, error: explainGitError(r.stderr) }
}

/**
 * 删一棵 worktree。
 *
 * **绝不自动 `--force`**：git 在工作树脏时会拒绝，那个拒绝是特性不是障碍 ——
 * 它挡住的正是"agent 干了一半的活被一键抹掉"。把 git 的原话翻译给用户，
 * 让他自己决定提交还是丢弃。
 */
export async function removeWorktree(wtPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!wtPath || !path.isAbsolute(wtPath) || wtPath.includes('\0')) {
    return { ok: false, error: '路径不合法' }
  }
  if (!existsSync(wtPath)) return { ok: false, error: '这个路径不存在' }

  /* **必须从主仓库里执行**。不给 cwd 的话 git 在**进程的当前目录**解析仓库 ——
     那是 Termspace 自己的目录，跟目标 worktree 毫无关系，报的是一句
     `is not a working tree`，而真正的问题是"你站错地方了"。
     测试端到端跑一遍才抓到，只看代码很难发现。 */
  const common = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], wtPath)
  if (!common.ok) return { ok: false, error: explainGitError(common.stderr) }
  const mainRepo = path.dirname(common.stdout.trim()) // <主仓库>/.git → <主仓库>

  /* **归属校验**：这是唯一一个破坏性操作，而入参是一个裸路径。
     要求 canonical 路径确实出现在该仓库的 worktree 列表里、且**不是主树** ——
     否则一个传错/被构造的路径就能让 git 去动一棵不相干的树，或者把主仓库当成
     worktree 去删。git 自己大多会拒，但"大多"不是判据。 */
  const list = await runGit(['worktree', 'list', '--porcelain'], mainRepo)
  if (!list.ok) return { ok: false, error: explainGitError(list.stderr) }
  const trees = parseWorktreeList(list.stdout)
  const real = realpathSync.native(wtPath)
  const isMain = trees.length > 0 && realpathSync.native(trees[0].path) === real
  const known = trees.some((w) => existsSync(w.path) && realpathSync.native(w.path) === real)
  if (!known) return { ok: false, error: '这个路径不是该仓库的 worktree' }
  if (isMain) return { ok: false, error: '这是主仓库本身，不是可以删的 worktree' }

  const r = await runGit(['worktree', 'remove', wtPath], mainRepo, 30_000)
  return r.ok ? { ok: true } : { ok: false, error: explainGitError(r.stderr) }
}
