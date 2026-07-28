import { memo, useContext, useEffect, useState } from 'react'
import { useReactFlow, useStore, type Node, type NodeProps } from '@xyflow/react'
import { TmuxContext, RequestDeleteContext } from '../identity-context'

/** 组绑定的 git worktree。绑了之后组内新建的终端 cwd 落在 path 上 —— 这就是隔离本身 */
export interface GroupWorktree {
  /** 主仓库根目录（删树时要从这儿执行 git worktree remove） */
  repo: string
  branch: string
  path: string
}
export type GroupNodeT = Node<
  { title: string; collapsed?: boolean; worktree?: GroupWorktree },
  'group'
>

/* 组状态取组内最高优先级 error > attention > running > idle
   —— 缩到全景时一个色块就要说清"这组里最糟的情况是什么" */
const COLLAPSED_H = 46

function GroupNodeImpl({ id, data }: NodeProps<GroupNodeT>): React.JSX.Element {
  const { setNodes, getNodes } = useReactFlow()
  const [bcast, setBcast] = useState<string | null>(null)
  /** 建树进行中：按钮要禁用，否则双击会建出两棵、其中一棵成孤儿 */
  const [binding, setBinding] = useState(false)
  const tmuxOk = useContext(TmuxContext)
  const requestDelete = useContext(RequestDeleteContext)

  // 聚合子节点状态（返回字符串保证 selector 相等性）
  const counts = useStore((s) => {
    const c: Record<string, number> = { running: 0, attention: 0, error: 0, idle: 0 }
    let total = 0
    // 群发只发空闲的**终端**（见 sendBroadcast）—— 浏览器/简报节点不算目标
    let idleTerms = 0
    for (const n of s.nodes) {
      if (n.parentId !== id) continue
      total++
      const st = String((n.data as { status?: string }).status ?? 'idle')
      if (st in c) c[st]++
      if (n.type === 'terminal' && st === 'idle') idleTerms++
    }
    return `${total}|${c.running}|${c.attention}|${c.error}|${idleTerms}`
  })
  const [total, running, attention, error, idleCount] = counts.split('|').map(Number)
  const worst = error > 0 ? 'error' : attention > 0 ? 'attention' : running > 0 ? 'running' : 'idle'

  const kids = (): Node[] => getNodes().filter((n) => n.parentId === id)
  const terms = (): Node[] => kids().filter((n) => n.type === 'terminal')

  /* worktree：组 = 一棵树。**只在组内终端的 cwd 确实是 git 仓库时才出现** ——
     用户的项目目录大多不是仓库（实测他 4 个标签页一个都不是），
     对非仓库显示一个禁用按钮只是噪音。 */
  const [repo, setRepo] = useState<{ repoRoot: string } | null>(null)
  const [wtStat, setWtStat] = useState<{ branch: string | null; dirty: number } | null>(null)
  const wt = data.worktree

  /* 组内终端的 cwd 列表（稳定序列化，当 effect 依赖）。
     **不能只依赖成员数量**：终端改了 cwd、同数量换了成员、顺序变了，
     数量都不变 —— 于是 `repo` 会一直是旧值，随后"隔离"可能在一个
     已经不属于这个组的仓库里建树。 */
  const cwdKey = useStore((s) =>
    s.nodes
      .filter((n) => n.parentId === id && n.type === 'terminal')
      .map((n) => String((n.data as { cwd?: string }).cwd ?? ''))
      .toSorted()
      .join('\u0000')
  )

  useEffect(() => {
    const cwds = [...new Set(cwdKey.split('\u0000').filter(Boolean))]
    if (!cwds.length) {
      setRepo(null)
      return
    }
    let alive = true
    void Promise.all(cwds.map((c) => window.termspace.gitProbe(c))).then((rs) => {
      if (!alive) return
      const roots = [...new Set(rs.map((r) => r?.repoRoot).filter(Boolean))]
      /* **组员分属不同仓库时不给绑**：一棵树只能属于一个仓库，
         这种情况下"在哪建"没有正确答案，宁可不出这个按钮。 */
      setRepo(roots.length === 1 && rs.every(Boolean) ? { repoRoot: roots[0] as string } : null)
    })
    return () => {
      alive = false
    }
  }, [cwdKey])

  useEffect(() => {
    if (!wt) {
      setWtStat(null)
      return
    }
    let alive = true
    let timer = 0
    /* **一次完成再排下一次**，不用 setInterval：runGit 单次可以跑到 15 秒
       （网络盘、海量未跟踪文件、git 锁竞争），定时器不等上一次结束就会
       并发堆叠多个 git status，几个组一起放大。`alive` 只挡 setState，
       拦不住已经起来的子进程。 */
    const pull = (): void => {
      void window.termspace.gitWorktreeStatus(wt.path).then((s) => {
        if (!alive) return
        setWtStat(s)
        timer = window.setTimeout(pull, 5000)
      })
    }
    pull()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [wt?.path])

  const bindWorktree = async (): Promise<void> => {
    if (!repo || binding) return
    const existing = terms()
    const branch = window.prompt(
      `在「${data.title}」上开一棵 worktree\n\n` +
        `仓库：${repo.repoRoot}\n` +
        '输入分支名（不存在会新建）。目录落在 <仓库名>.worktrees/ 下。' +
        (existing.length
          ? `\n\n组里现有 ${existing.length} 个终端，建好后会问你要不要把它们一起迁过去。`
          : ''),
      ''
    )
    if (!branch) return
    /* **in-flight 锁**：按钮在 await 期间不禁用的话，双击会建出两棵树，
       后返回的那次覆盖 data.worktree，先建的那棵成为磁盘上没人认领的孤儿。 */
    setBinding(true)
    let r: { ok: boolean; path?: string; error?: string }
    try {
      r = await window.termspace.gitCreateWorktree(repo.repoRoot, branch)
    } finally {
      setBinding(false)
    }
    if (!r.ok || !r.path) {
      window.alert(`建不了：${r.error ?? '未知错误'}`)
      return
    }
    const wtPath = r.path
    /* await 期间组可能已经被删/解组了。这时候直接 setNodes 会静默什么都不做，
       而磁盘上那棵树已经建出来了 —— 必须告诉用户它在哪，别让它变成看不见的孤儿。 */
    if (!getNodes().some((n) => n.id === id)) {
      window.alert(`组已经不在了，但 worktree 已经建好：\n${wtPath}\n\n不需要的话请手工删除。`)
      return
    }

    /* **只挂徽标不算隔离**。绑定之前组里已有的终端，其 cwd 和正在跑的 tmux 会话
       都还在原来的工作树上 —— 界面显示 `⎇ 分支`、按钮写着"物理隔离"，
       而 agent 其实还在共享目录里改文件。这是最危险的那种假成功，
       所以这里必须明确问一次，并把两种语义都说清楚。 */
    const migrate =
      existing.length > 0 &&
      window.confirm(
        `worktree 已建好：\n${wtPath}\n\n` +
          `把组里现有的 ${existing.length} 个终端也迁到这棵树上？\n` +
          '会结束它们当前的会话，再用新目录重开（跑着的进程会停）。\n\n' +
          '选「取消」= 只有**以后**在这个组里新建的终端落在新树上，现有的不动。'
      )

    setNodes((ns) =>
      ns.map((n) => {
        if (n.id === id) {
          return { ...n, data: { ...n.data, worktree: { repo: repo.repoRoot, branch, path: wtPath } } }
        }
        if (!migrate || n.parentId !== id || n.type !== 'terminal') return n
        return {
          ...n,
          data: {
            ...n.data,
            cwd: wtPath,
            status: 'idle',
            restartTick: ((n.data as { restartTick?: number }).restartTick ?? 0) + 1
          }
        }
      })
    )
    if (migrate) for (const n of existing) void window.termspace.destroy(n.id)
  }

  const unbindWorktree = (): void => {
    /* **解绑不删树**。和 closeProject 保留画布同一哲学：
       磁盘上那棵树可能有 agent 干了一半的活，删除必须是另一个显式动作。 */
    if (
      !window.confirm(
        `解除「${data.title}」和 worktree 的绑定？\n\n` +
          `磁盘上的 ${wt?.path} **不会**被删除，里面的改动都还在。\n` +
          '组内已有的终端不受影响（它们的 cwd 已经定了），只是之后新建的终端不再落在那棵树上。'
      )
    ) {
      return
    }
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, worktree: undefined } } : n)))
  }

  /**
   * 真删这棵树。**和解绑是两个动作** —— 解绑只去引用，这个动作动磁盘。
   *
   * 两道闸都在这儿：
   * - 组里还有活着的终端时不给删（git 不管有没有进程把它当 cwd，
   *   删完那个 shell 就悬在一个不存在的目录里）
   * - 脏树由 git 自己拒，**绝不替用户 --force** —— 那个拒绝挡的正是
   *   "agent 干了一半的活被一键抹掉"。把 git 的原话原样显示给用户
   */
  const deleteWorktree = async (): Promise<void> => {
    if (!wt) return
    const live = terms()
    if (live.length) {
      window.alert(
        `组里还有 ${live.length} 个终端在用这棵树。\n先关掉它们（或解组）再删 ——\n` +
          '删完那些 shell 会悬在一个不存在的目录里。'
      )
      return
    }
    const dirty = wtStat?.dirty ?? 0
    if (
      !window.confirm(
        `删除 worktree？\n${wt.path}\n\n` +
          (dirty
            ? `⚠️ 这棵树里有 ${dirty} 个未提交的改动 —— git 会拒绝删除，不会替你 --force。\n\n`
            : '') +
          '分支本身不会被删，只删这份工作副本。'
      )
    ) {
      return
    }
    const r = await window.termspace.gitRemoveWorktree(wt.path)
    if (!r.ok) {
      window.alert(`删不掉：${r.error ?? '未知错误'}`)
      return
    }
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, worktree: undefined } } : n)))
  }

  const ungroup = (): void => {
    setNodes((ns) => {
      const g = ns.find((n) => n.id === id)
      if (!g) return ns
      return ns
        .filter((n) => n.id !== id)
        .map((n) =>
          n.parentId === id
            ? {
                ...n,
                parentId: undefined,
                extent: undefined,
                hidden: false,
                position: {
                  x: g.position.x + n.position.x,
                  y: g.position.y + n.position.y
                }
              }
            : n
        )
    })
  }

  /**
   * 折叠：子节点 hidden → React Flow 不再渲染 → TerminalNode cleanup 释放 PTY 客户端。
   * 只有存在 tmux 会话时里面的进程才活得下来；**没有 tmux 时折叠就是把进程杀了**，
   * 所以无 tmux 一律禁用折叠（按钮置灰并说明原因）。
   */
  const toggleCollapse = (): void => {
    if (!tmuxOk) return
    const next = !data.collapsed
    setNodes((ns) => {
      // 展开时按子节点实际范围回算高度，不用额外存旧高度
      const extent = ns.reduce(
        (m, n) => (n.parentId === id ? Math.max(m, n.position.y + (n.height ?? 380)) : m),
        0
      )
      return ns.map((n) => {
        if (n.id === id) {
          return {
            ...n,
            height: next ? COLLAPSED_H : Math.max(240, extent + 20),
            data: { ...n.data, collapsed: next }
          }
        }
        return n.parentId === id ? { ...n, hidden: next } : n
      })
    })
  }

  const closeBcast = (): void => {
    setBcast(null)
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, zIndex: undefined } : n)))
  }

  /**
   * 群发。
   *
   * **同一串字在 agent prompt、shell、TUI 选择器里是三件完全不同的事** ——
   * 某个 agent 恰好退出到 shell 时，你想发给模型的那句话就变成了一条 shell 命令。
   * tmux 的 synchronize-panes 至少还要求你人在那些 pane 前面；这里的节点
   * 可能正折叠着、可能在画布另一头，出了事根本看不见。
   *
   * 所以发送前把目标摊开给用户看，并**默认排除正忙/等审批/状态不明的**：
   * 这三种状态下写入最容易落到一个没人预期的地方。
   */
  const sendBroadcast = (): void => {
    const cmd = (bcast ?? '').trim()
    const list = terms()
    if (!cmd || !list.length) return
    const stateOf = (n: Node): string => String((n.data as { status?: string }).status ?? 'idle')
    const ok = list.filter((n) => stateOf(n) === 'idle')
    const skipped = list.filter((n) => stateOf(n) !== 'idle')
    if (!ok.length) {
      window.alert(
        `${list.length} 个终端都不在空闲状态（正在跑 / 等审批 / 出错），这一发没有安全的目标。\n` +
          '等它们停下来，或者单独点开某个终端发。'
      )
      return
    }
    const label = (n: Node): string =>
      `· ${String((n.data as { title?: string }).title ?? n.id)}（${stateOf(n)}）`
    if (
      !window.confirm(
        `把这行发到 ${ok.length} 个终端？\n\n${cmd}\n\n${ok.map(label).join('\n')}` +
          (skipped.length
            ? `\n\n跳过 ${skipped.length} 个（不在空闲状态）：\n${skipped.map(label).join('\n')}`
            : '') +
          '\n\n注意：这串字会原样进终端。目标里若有 agent 已退出到 shell，它就是一条命令。'
      )
    ) {
      return
    }
    for (const n of ok) window.termspace.write(n.id, `${cmd}\r`)
    closeBcast()
  }

  /** 批量重启：真杀会话再以相同身份/目录/预设重开（restartTick 驱动 spawn effect 重跑） */
  const restartAll = (): void => {
    const list = terms()
    if (!list.length) return
    if (
      !window.confirm(
        `重启「${data.title}」下的 ${list.length} 个终端？\n当前会话会被结束，再以相同身份、目录和启动命令重开。`
      )
    ) {
      return
    }
    for (const n of list) void window.termspace.destroy(n.id)
    setNodes((ns) =>
      ns.map((n) =>
        n.parentId === id && n.type === 'terminal'
          ? {
              ...n,
              data: {
                ...n.data,
                status: 'idle',
                restartTick: (((n.data as { restartTick?: number }).restartTick ?? 0) + 1)
              }
            }
          : n
      )
    )
  }

  return (
    <div className={`group-node group-${worst}${data.collapsed ? ' collapsed' : ''}`}>
      <div className="group-node-header">
        <button
          className="group-caret nodrag"
          disabled={!tmuxOk}
          title={
            !tmuxOk
              ? '折叠需要 tmux：没有 tmux 时子终端被隐藏即等于结束进程'
              : data.collapsed
                ? '展开集群'
                : '折叠集群（tmux 会话保持存活）'
          }
          onClick={(e) => {
            e.stopPropagation()
            toggleCollapse()
          }}
        >
          {data.collapsed ? '▸' : '▾'}
        </button>
        <span className="group-node-title">{data.title}</span>
        {wt && (
          <span
            className={`group-wt${wtStat && wtStat.dirty > 0 ? ' dirty' : ''}`}
            title={`worktree：${wt.path}${wtStat ? `\n${wtStat.dirty} 个未提交改动` : ''}`}
          >
            ⎇ {wt.branch}
            {wtStat && wtStat.dirty > 0 && ` ·${wtStat.dirty}`}
          </span>
        )}
        <span className="group-node-counts">
          {total} 终端{running > 0 && ` · ${running} 运行`}
          {attention > 0 && ` · ${attention} 需要你`}
          {error > 0 && ` · ${error} 出错`}
        </span>
        {/* 折叠时子终端已卸载（pty 客户端不在），群发/重启会静默落空 → 直接不给按钮 */}
        {!data.collapsed && (
          <>
            <button
              className="group-act nodrag"
              title="向组内所有终端群发一条命令"
              onClick={(e) => {
                e.stopPropagation()
                const open = bcast === null
                setBcast(open ? '' : null)
                // 抬 z-index：React Flow 按 zIndex 排序渲染，不抬的话
                // 浮在组框上方的输入条会被相邻节点压住
                setNodes((ns) =>
                  ns.map((n) => (n.id === id ? { ...n, zIndex: open ? 1000 : undefined } : n))
                )
              }}
            >
              群发
            </button>
            {/* 非 git 仓库时整个不出现 —— 显示一个点不了的按钮只是噪音 */}
            {repo && !wt && (
              <button
                className="group-act nodrag"
                disabled={binding}
                /* 文案不能只说"物理隔离" —— 建完还要问一次迁不迁现有终端，
                   不迁的话已有 agent 仍在原工作树上。别让按钮许下代码没兑现的承诺 */
                title="给这个组开一棵 git worktree。建好后可选择把组内已有终端一起迁过去（会重开会话）"
                onClick={(e) => {
                  e.stopPropagation()
                  void bindWorktree()
                }}
              >
                {binding ? '⎇ 建树中…' : '⎇ 隔离'}
              </button>
            )}
            {wt && (
              <button
                className="group-act nodrag"
                title="解除绑定（不删除磁盘上的 worktree）"
                onClick={(e) => {
                  e.stopPropagation()
                  unbindWorktree()
                }}
              >
                解绑
              </button>
            )}
            {wt && (
              <button
                className="group-act nodrag danger"
                title="删除磁盘上的这棵 worktree（组里还有终端时不给删；脏树 git 会拒绝，不会 --force）"
                onClick={(e) => {
                  e.stopPropagation()
                  void deleteWorktree()
                }}
              >
                删树
              </button>
            )}
            <button
              className="group-act nodrag"
              title="结束并重开组内所有会话（保留身份/目录/启动命令）"
              onClick={(e) => {
                e.stopPropagation()
                restartAll()
              }}
            >
              重启
            </button>
          </>
        )}
        <button className="term-node-close nodrag" title="解组（终端保留）" onClick={ungroup}>
          ⊟
        </button>
        <button
          className="term-node-close nodrag"
          title="删除集群及组内全部终端（会话结束）"
          onClick={(e) => {
            e.stopPropagation()
            // 走画布统一入口：确认弹窗、撤回记录、连线一并处理都在那里
            const list = kids()
            requestDelete(
              [id, ...list.map((k) => k.id)],
              `删除集群「${data.title}」及组内 ${list.length} 个节点`
            )
          }}
        >
          ✕
        </button>
      </div>
      {/* 浮在组头**上方**：子终端节点渲染在父组之上，放组内会被整个盖住 */}
      {bcast !== null && !data.collapsed && (
        <div className="group-bcast nodrag">
          <input
            className="group-bcast-input"
            autoFocus
            value={bcast}
            placeholder="命令会被原样敲进组内每个终端并回车"
            onChange={(e) => setBcast(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendBroadcast()
              if (e.key === 'Escape') closeBcast()
            }}
            spellCheck={false}
          />
          <button className="group-act send" onClick={sendBroadcast} disabled={!bcast.trim()}>
            {/* 数的是**真会收到的那些**。写总数会让人以为全发了，
                而实际只发给空闲的那几个 —— 差额在确认框里列清楚 */}
            发送到 {idleCount} 个终端
          </button>
        </div>
      )}
    </div>
  )
}

export default memo(GroupNodeImpl)
