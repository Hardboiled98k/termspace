import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as pty from 'node-pty'
import {
  startHookSystem,
  uninstallClaudeHooks,
  claudeHooksPresent,
  type HookSystem,
  type PendingApproval
} from './hooks'
import { createContextTail, type ContextTail } from './context-tail'
import {
  listIdentities,
  upsertIdentity,
  deleteIdentity,
  resolveIdentityEnv
} from './identity-store'
import { listPresets, upsertPreset, deletePreset } from './preset-store'
import { startWorkerWatch, workerAction, type WorkerWatch } from './worker-watch'
import { startRemoteApi, type RemoteApi } from './remote'
import { resolveBind } from './net-iface'
import { evaluate as evaluatePolicy, type PolicyVerdict } from './approval-policy'
import { getSettings, setSettings, type Settings } from './settings-store'
import { searchSkills, loadSkill, listSkills } from './skill-index'
import { delegate, noteTranscript, noteStatus, dropNode, isAgentSession } from './delegate'
import {
  ensureTmux,
  hasSession,
  killSession,
  buildSpawnArgs,
  reapOrphanSessions,
  capturePane
} from './tmux'

// dev 下 app 名默认是 "Electron"，userData 会指向共享目录 → 显式隔离
app.setPath('userData', path.join(app.getPath('appData'), 'termboard'))

/* IPC 输入校验：nodeId 会被拼进文件路径、tmux 会话名、Map 键。各处虽都做了字符白名单
   替换，但在入口统一拒掉更省心，也挡住超长 id 把 Map 撑爆。画布真实 id 形如 t1/b2/g3/ctx-p1。 */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const okId = (id: unknown): id is string => typeof id === 'string' && NODE_ID_RE.test(id)
/** 只认主窗口来的 IPC（webview guest 等其他 webContents 一律拒） */
const fromMainWin = (e: { sender: Electron.WebContents }): boolean =>
  !!mainWin && !mainWin.isDestroyed() && e.sender === mainWin.webContents
const PTY_WRITE_LIMIT = 256 * 1024


/** 本次运行是否已经问过 hook 写入同意（renderer:ready 会被 reload 反复触发） */
let askedConsent = false
/** 远程端能否写入终端 / 批准工具调用。设置里改了要立刻生效，所以单独缓存 */
let remoteAllowInput = false
let remoteAllowApprove = false
/** 选了 tailscale 但没找到 100.x 地址，实际退回了回环。界面要如实说 */
let remoteFellBack = false
/** 远程 API 启动失败的原因。只进 console 的话，设置里只有一个"未启动"，用户无从下手 */
let remoteError = ''

const ptys = new Map<string, pty.IPty>()
/** 本次运行开过终端的工作目录。审批规则引擎据此判断 cwd 是否在管辖范围内 */
const spawnedRoots = new Set<string>()
let hookSystem: HookSystem | null = null
let contextTail: ContextTail | null = null
let workerWatch: WorkerWatch | null = null
let mainWin: BrowserWindow | null = null
let remoteApi: RemoteApi | null = null

/** 抓某终端当前屏尾部若干行的纯文本（消息中心和远程 API 共用） */
async function peekPane(id: string, lines: number): Promise<string> {
  const raw = await capturePane(id)
  if (!raw) return ''
  return raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // 去掉 ANSI 转义，给 UI 用纯文本
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== '')) // 压掉连续空行
    .slice(-Math.max(1, Math.min(200, lines)))
    .join('\n')
    .trim()
}
/**
 * 给审批卡片附上规则引擎的判定（桌面与手机端共用同一份）。
 *
 * 规则引擎只输出「转人工」或「建议拒绝」，**永远不会替用户批准** ——
 * 见 approval-policy.ts 的文件头，别在这里加一条"低风险自动放行"的捷径。
 * 它读的是完整 rawInput（只在主进程里流转），不是给 UI 看的 300 字截断摘要。
 */
function withVerdict(list: PendingApproval[]): (PendingApproval & { verdict?: PolicyVerdict })[] {
  return list.map((a) => {
    const full = hookSystem?.getApprovalFull(a.id)
    /* 拿不到完整输入时给兜底判定，不能返回"无判定"——
       UI 上「没有横幅」看起来跟「审过了没事」一模一样，故障方向全在危险那一侧 */
    if (!full) {
      return {
        ...a,
        verdict: {
          decision: 'require_human' as const,
          rule: 'unknown',
          reason: '读不到完整调用内容，无法判定'
        }
      }
    }
    return {
      ...a,
      verdict: evaluatePolicy({
        toolName: full.toolName,
        rawInput: full.rawInput,
        cwd: full.cwd,
        knownRoots: [...spawnedRoots],
        permissionMode: full.permissionMode
      })
    }
  })
}

/** 渲染层推来的画布 agent 摘要，供 tb agents / 派活用 */
let boardAgents: { id: string; title: string; provider?: string; status: string }[] = []
/** 画布上的授权连线：`source>target`。终端→终端 = 派活；终端→浏览器 = 允许驱动 */
let boardLinks = new Set<string>()
/** 完整画布快照（布局 + 状态），远程 API 用；终端内容不在里面 */
let boardSnapshot: unknown = null
ipcMain.on(
  'board:agents',
  (
    e,
    payload:
      | { agents?: typeof boardAgents; links?: string[]; nodeIds?: string[]; board?: unknown }
      | typeof boardAgents
  ) => {
    if (!fromMainWin(e)) return
    // 兼容旧形态（纯数组）
    const p = Array.isArray(payload) ? { agents: payload, links: [], nodeIds: [], board: null } : payload
    boardAgents = Array.isArray(p?.agents) ? p.agents : []
    if (p?.board) {
      boardSnapshot = p.board
      remoteApi?.push('board', p.board)
    }
    boardLinks = new Set(Array.isArray(p?.links) ? p.links.filter((s) => typeof s === 'string') : [])
    /* 节点 id 会被复用（nextId 取 max+1）：删掉 b1 再建一个新的 b1，
       旧授权就白送给了陌生节点。所以节点一消失就撤销与它有关的一次性授权。 */
    if (Array.isArray(p?.nodeIds)) {
      const alive = new Set(p.nodeIds.filter((s) => typeof s === 'string'))
      for (const g of [...grants]) {
        const [src, dst] = g.split('>')
        if (!alive.has(src) || !alive.has(dst)) grants.delete(g)
      }
    }
  }
)

/* 本次运行内用户当场批准过的跨节点调用（连线之外的逃生口）。
   连线被删掉后授权立即失效，但这里的一次性批准按 app 生命周期保留。 */
const grants = new Set<string>()

/**
 * 跨节点动作授权：先看画布连线，没有就弹窗问用户。
 * 诚实说明：source 由调用方脚本自报，同 UID 进程能直接 `tmux send-keys` 绕过整条链路，
 * 所以这是**产品护栏**（防 agent 自己乱来、让连线成为真语义），不是安全边界。
 */
async function authorizeLink(
  source: string,
  target: string,
  what: string,
  detail: string
): Promise<boolean> {
  if (!source || !target) return false
  const key = `${source}>${target}`
  if (boardLinks.has(key) || grants.has(key)) return true
  if (!mainWin || mainWin.isDestroyed()) return false
  const { response, checkboxChecked } = await dialog.showMessageBox(mainWin, {
    type: 'question',
    buttons: ['拒绝', '允许本次'],
    defaultId: 0,
    cancelId: 0,
    message: `允许 ${source} ${what} ${target}？`,
    detail: `${detail}\n\n画布上这两个节点之间没有连线。拉一条线过去即可长期授权。`,
    checkboxLabel: '本次运行内不再询问这一对节点',
    checkboxChecked: false
  })
  if (response !== 1) return false
  if (checkboxChecked) grants.add(key)
  return true
}

// 全工作区已知节点 id（跨所有项目）→ 清理不在其中的孤儿 tmux 会话
ipcMain.handle('sessions:reap', async (e, knownIds: string[]) => {
  if (!fromMainWin(e)) return 0
  const given = Array.isArray(knownIds) ? knownIds.filter(okId) : []
  const keep = new Set([...given, ...ptys.keys()])
  return reapOrphanSessions(keep)
})

// tb browser：主进程 ↔ renderer 往返（renderer 持有 webview）
const browserPending = new Map<string, (r: { ok: boolean; result: string }) => void>()
let browserReqSeq = 0
function browserCommand(
  action: string,
  arg: string,
  nodeId: string,
  source = ''
): Promise<string> {
  return new Promise((resolve) => {
    if (!mainWin || mainWin.isDestroyed()) return resolve('窗口不可用')
    const reqId = `br${++browserReqSeq}`
    const timer = setTimeout(() => {
      browserPending.delete(reqId)
      resolve('浏览器指令超时')
    }, 35_000)
    browserPending.set(reqId, (r) => {
      clearTimeout(timer)
      resolve(r.ok ? r.result : `失败：${r.result}`)
    })
    // source 传给 renderer：open 时自动画一条 终端→浏览器 的连线，
    // 让"谁能驱动这个浏览器"在画布上看得见、也能靠删线撤销
    mainWin.webContents.send('browser:cmd', { reqId, nodeId, action, arg, source })
  })
}
ipcMain.on('browser:result', (_e, r: { reqId: string; ok: boolean; result: string }) => {
  browserPending.get(r.reqId)?.(r)
  browserPending.delete(r.reqId)
})

function sendToWin(channel: string, data: unknown): void {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, data)
}

/** cold-restore 快照路径：release/退出前抓屏落盘，机器重启后 tmux 死了也能回灌 */
const scrollbackFile = (id: string): string =>
  path.join(app.getPath('userData'), 'scrollback', `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`)

async function snapshotScrollback(id: string): Promise<void> {
  try {
    const content = await capturePane(id)
    if (!content) return
    const f = scrollbackFile(id)
    await mkdir(path.dirname(f), { recursive: true })
    await writeFile(f, content)
  } catch {
    // 抓屏失败不影响主流程
  }
}

/** 进行中的抓屏：destroy 删快照前要等它落完，否则删掉又被写回来 */
const pendingSnapshots = new Map<string, Promise<void>>()

/* 同一 nodeId 的 spawn / destroy 必须串行。destroy 里的 kill-session 是异步的，
   紧接着 respawn（换身份）时，迟到的 kill 会把刚建好的新会话杀掉。 */
const idLocks = new Map<string, Promise<unknown>>()
function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = idLocks.get(id) ?? Promise.resolve()
  const next = prev.then(fn, fn) // 前一个失败也要继续排队
  const tail = next.catch(() => undefined)
  idLocks.set(id, tail)
  // 队尾跑完就把锁清掉，别让 Map 无限长
  void tail.then(() => {
    if (idLocks.get(id) === tail) idLocks.delete(id)
  })
  return next
}

/**
 * 只杀客户端，tmux 会话存活（reload / app 退出 / 重挂载）— 续存的关键。
 * snapshot=false 用于 destroy：节点都要没了，抓屏存下来只会在同 id 重建时回灌旧内容。
 */
function releasePty(id: string, snapshot = true): Promise<void> {
  const p = ptys.get(id)
  if (!p) return pendingSnapshots.get(id) ?? Promise.resolve()
  ptys.delete(id)
  let done = Promise.resolve()
  if (snapshot) {
    done = snapshotScrollback(id)
    pendingSnapshots.set(id, done)
    void done.finally(() => {
      if (pendingSnapshots.get(id) === done) pendingSnapshots.delete(id)
    })
  }
  try {
    p.kill()
  } catch {
    // 进程可能已退出
  }
  return done
}

/**
 * 真结束：kill-session + 客户端 + 清快照（节点 ✕ / 换身份重生成）。
 * 返回销毁前抓到的屏幕内容 —— 撤回删除时拿它回灌，让恢复出来的终端不是一片空白。
 * （进程本身救不回来，这一点在 UI 上要说清楚。）
 */
function destroyPty(id: string): Promise<string> {
  return serialize(id, async () => {
    contextTail?.untrack(id)
    dropNode(id)
    hookSystem?.dropApprovals(id) // 节点没了，挂着的审批也别留着
    await hookSystem?.revokeNodeToken(id) // 吊销身份，别让重建的同 id 节点继承
    // 一次性授权也要清：id 会被新节点复用，留着等于把授权传给了陌生人
    for (const g of [...grants]) {
      if (g.startsWith(`${id}>`) || g.endsWith(`>${id}`)) grants.delete(g)
    }
    // 先抓一份屏幕内容交给调用方（撤回删除时回灌），再动手杀
    const farewell = await capturePane(id).catch(() => '')
    await releasePty(id, false)
    await pendingSnapshots.get(id) // 等在飞的抓屏落完，否则下一行删了又被写回来
    // 快照必须删：否则删掉节点后，新节点若拿到同一个 id 会回灌已删除终端的内容
    await unlink(scrollbackFile(id)).catch(() => undefined)
    await killSession(id)
    return farewell
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1520,
    height: 940,
    title: 'Termscape',
    backgroundColor: '#00000000',
    vibrancy: 'under-window', // macOS 毛玻璃材质，画布透明底透出
    visualEffectState: 'active',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true // 画布浏览器节点用 <webview>
    }
  })

  // reload 时 renderer effect cleanup 不执行 → 释放客户端（tmux 会话存活，新页面 -A 接回）
  // （did-navigate 先于新页面 JS 执行，不会误杀新 spawn）
  win.webContents.on('did-navigate', () => {
    for (const id of [...ptys.keys()]) void releasePty(id)
  })

  /* ── 外壳收口（Electron 安全基线）──
     主窗口的 preload 暴露了 pty/凭证等能力，一旦被导航到外站就等于把这些交出去。 */

  // 画布浏览器节点的 <webview> 参数由主进程定，不信任 renderer 传的：
  // guest 绝不允许带 preload 或开 node —— 那等于任意网页拿到 Node 权限
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    const src = String(params.src ?? '')
    if (!/^(https?:\/\/|about:blank)/i.test(src)) params.src = 'about:blank'
  })

  /* 主窗口自身不许被导航走。用 origin/规范化路径比对，不能用 startsWith：
     `http://localhost:5173.evil.test` 是能通过前缀检查的。 */
  const devOrigin = process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).origin
    : null
  const prodPage = path.join(__dirname, '../renderer/index.html')
  const allowNav = (raw: string): boolean => {
    try {
      const u = new URL(raw)
      if (devOrigin) return u.origin === devOrigin
      return u.protocol === 'file:' && path.normalize(decodeURIComponent(u.pathname)) === prodPage
    } catch {
      return false
    }
  }
  const blockNav = (e: Electron.Event, url: string): void => {
    if (!allowNav(url)) e.preventDefault()
  }
  win.webContents.on('will-navigate', blockNav)
  win.webContents.on('will-redirect', blockNav)

  // 新窗口一律不在应用内开，扔给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 画布浏览器里的 target="_blank" / window.open：guest 有自己的 handler，
  // 不装的话这类链接是直接失效（点了没反应），而不是"被安全地拦下"
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    // TERMBOARD_PANEL=general 等：自检截图时直接展开设置面板
    const q = process.env['TERMBOARD_PANEL'] ? `?panel=${process.env['TERMBOARD_PANEL']}` : ''
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + q)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

interface SpawnOpts {
  identityId?: string
  command?: string // agent 预设启动命令，spawn 后写入 shell
  provider?: string
  contextNodeIds?: string[] // 画布上连到本终端的简报节点
  cwd?: string // 工作目录（来自项目标签页）
}

ipcMain.handle(
  'pty:spawn',
  async (e, id: string, cols: number, rows: number, opts?: SpawnOpts) => {
    if (!fromMainWin(e) || !okId(id)) return
    /* spawn 与 destroy 走同一条串行链。只"等一下旧锁"不够：spawn 自身是异步的，
       后来的 destroy 会和它重叠，kill-session 可能落在刚建好的新会话上。 */
    return serialize(id, async () => {
    // 客户端是同步断开的；抓屏落盘不阻塞 spawn（否则每次重挂载都要等一次 capture-pane）
    void releasePty(id) // 只释放客户端；有 tmux 会话则下面 -A 接回
    const settings = await getSettings()
    const shell =
      (settings.defaultShell && existsSync(settings.defaultShell) ? settings.defaultShell : '') ||
      process.env['SHELL'] ||
      '/bin/zsh'
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    // 防嵌套：app 若从 tmux 里启动，tmux 会拒绝
    delete env['TMUX']
    delete env['TMUX_PANE']
    env['TERM'] = 'xterm-256color'
    env['COLORTERM'] = 'truecolor'
    // hook 门控：托管脚本只在带 NODE_ID 的终端里工作
    env['TERMBOARD_NODE_ID'] = id
    env['TERMBOARD_AGENT_ID'] = opts?.provider ?? 'claude'
    if (hookSystem) {
      env['TERMBOARD_HOOK_ENDPOINT'] = hookSystem.endpointFile
      /* 每个节点一个 token，服务端据此反查"是谁在调"，不再采信请求里自报的 nodeId。
         每次 spawn 换新：老 token 立即失效，同 id 重建不会继承旧身份。
         env 里这份是给新会话用的；tmux 接回的老会话靠 endpoint 文件现查（-e 会被忽略）。 */
      env['TERMBOARD_HOOK_TOKEN'] = await hookSystem.issueNodeToken(id)
      // F8：tb 命令挂到 PATH 最前，agent 直接可用
      env['PATH'] = `${hookSystem.binDir}:${env['PATH'] ?? ''}`
    }
    // F2 上下文 + F8 工具路由提示（合成一份文件，Claude 预设经 --append-system-prompt 注入）
    env['TERMBOARD_CONTEXT_FILE'] = await buildMergedContext(id, opts?.contextNodeIds ?? [])
    /* identity env 包注入（多账号/多 key，密文存储主进程解密）。
       典型用法不是 API key，而是 CODEX_HOME / CLAUDE_CONFIG_DIR ——
       两个订阅账号各指一个目录，同一条 `codex` 命令在两个节点里登的就是两个号。 */
    const idEnv = await resolveIdentityEnv(opts?.identityId)
    if (idEnv) {
      // 先删：继承下来的 OPENAI_API_KEY / ANTHROPIC_API_KEY 会让 CLI 绕过订阅走 key 计费
      for (const k of idEnv.unset) delete env[k]
      for (const [k, v] of Object.entries(idEnv.set)) {
        // 不许覆盖自家门控：改了 TERMBOARD_HOOK_TOKEN 之类，这个节点的状态/派活就哑了
        if (k.startsWith('TERMBOARD_')) continue
        env[k] = v
      }
      // identity 若整个改写了 PATH，把 tb 的目录重新顶回最前，否则 agent 用不了 tb
      if (idEnv.set['PATH'] && hookSystem) {
        env['PATH'] = `${hookSystem.binDir}:${idEnv.set['PATH']}`
      }
    }

  const tmux = settings.tmuxEnabled ? await ensureTmux(settings.scrollback) : null
  // fresh 判定：无可接会话 = 冷启动，才写入预设启动命令（重接不能重复敲）
  const fresh = tmux ? !(await hasSession(id)) : true
  // cold-restore：冷启动且有旧快照 → 先把上次画面回灌进 xterm（机器重启后恢复历史）
  let coldSnapshot = ''
  if (fresh) {
    try {
      coldSnapshot = await readFile(scrollbackFile(id), 'utf8')
    } catch {
      // 无快照
    }
  }
  const cwd = opts?.cwd && existsSync(opts.cwd) ? opts.cwd : os.homedir()
  spawnedRoots.add(cwd)
  /* identity 的键要显式告诉 tmux 层转发 —— 按前缀猜会漏（见 buildSpawnArgs 注释），
     unset 也只有它知道该删哪些（env 对象里已经没有那些键了，猜不出来）。 */
  const { file, args } = buildSpawnArgs(tmux, id, shell, cwd, env, {
    keys: Object.keys(idEnv?.set ?? {}),
    unset: idEnv?.unset ?? []
  })
  const p = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 24,
    cwd,
    env
  })
  ptys.set(id, p)

  // agent 预设：等 shell 就绪后写入启动命令（tty 缓冲会排队，200ms 只是保险）
  const cmd = opts?.command?.trim()
  if (cmd && fresh) {
    setTimeout(() => {
      if (ptys.get(id) === p) p.write(`${cmd}\r`)
    }, 200)
  }

  const wc = e.sender
  // 先把冷启动快照推给 xterm（灰显 + 分隔线），再让实时输出接上
  if (coldSnapshot && !wc.isDestroyed()) {
    wc.send(
      `pty:data:${id}`,
      `${coldSnapshot}\r\n\x1b[38;5;244m── 会话已恢复（上次画面）──\x1b[0m\r\n`
    )
  }
  p.onData((data) => {
    // 与 onExit 同样的实例守卫：同 id 重生成后，旧实例的尾部输出不能串进新 xterm
    if (ptys.get(id) !== p) return
    if (!wc.isDestroyed()) wc.send(`pty:data:${id}`, data)
  })
  p.onExit(({ exitCode }) => {
    // 实例守卫：exit 是异步的，同 id 重生成后旧实例的 exit 不能删/通知新实例
    if (ptys.get(id) !== p) return
    ptys.delete(id)
    // 进程没了 → 会话按死处理，迟到的 hook 不得再把它判成活 agent
    dropNode(id)
    if (!wc.isDestroyed()) wc.send(`pty:exit:${id}`, exitCode)
  })
  })
})

ipcMain.on('pty:write', (e, id: string, data: string) => {
  if (!fromMainWin(e) || !okId(id)) return
  if (typeof data !== 'string' || data.length > PTY_WRITE_LIMIT) return
  ptys.get(id)?.write(data)
})

ipcMain.on('pty:resize', (e, id: string, cols: number, rows: number) => {
  if (!fromMainWin(e) || !okId(id)) return
  if (cols > 0 && rows > 0) {
    try {
      ptys.get(id)?.resize(cols, rows)
    } catch {
      // resize 竞态：进程刚退出时忽略
    }
  }
})

/**
 * 审批决策：走 Claude 的 PermissionRequest hook 结构化应答，不是往 pty 里盲写 y。
 * 盲写的问题是没法保证那一下落在正确的提示上（agent 可能早换轮或已退出）。
 */
ipcMain.handle('approval:decide', (e, id: string, allow: boolean) => {
  if (!fromMainWin(e) || typeof id !== 'string') return { ok: false, error: '非法请求' }
  const hit = hookSystem?.decideApproval(id, !!allow) ?? false
  return hit
    ? { ok: true }
    : { ok: false, error: '该审批已失效（超时或 agent 已自行处理），请到终端确认' }
})

/**
 * 抓某个终端当前屏的尾部若干行 —— 消息中心用它把"终端到底在问什么"直接显示出来。
 * 只有看得见问题，就地回答才是安全的；否则就是盲按。
 */
ipcMain.handle('agent:peek', async (e, id: string, lines = 8) => {
  if (!fromMainWin(e) || !okId(id)) return ''
  return peekPane(id, lines)
})

/**
 * 就地回答：把用户在消息中心敲的内容写进该终端。
 * 与"盲发 y"的区别是 —— 上面 peek 已经把问题原文显示出来了，用户看着回答，
 * 等价于自己在终端里敲，不是替他猜。
 */
ipcMain.handle('agent:reply', (e, id: string, text: string) => {
  if (!fromMainWin(e) || !okId(id)) return { ok: false, error: '非法请求' }
  if (typeof text !== 'string' || text.length > 4096) return { ok: false, error: '内容不合法' }
  const p = ptys.get(id)
  if (!p) return { ok: false, error: '终端已不存在' }
  p.write(text)
  return { ok: true }
})

ipcMain.on('pty:kill', (e, id: string) => {
  if (!fromMainWin(e) || !okId(id)) return
  // effect cleanup（remount/HMR/reload 前奏）→ 释放客户端，会话续存
  void releasePty(id)
})

// 节点 ✕ / 换身份 → 真杀会话。可 await：renderer 换身份时要等旧会话确实死透再 respawn
ipcMain.handle('pty:destroy', (e, id: string) => {
  if (!fromMainWin(e) || !okId(id)) return Promise.resolve('')
  return destroyPty(id)
})

/**
 * 撤回删除时回灌屏幕内容：写进 cold-restore 用的快照文件，
 * 节点重建后 spawn 走 fresh 分支就会把它显示出来。
 * 进程本身救不回来 —— 这只是让恢复出来的终端不是一片空白。
 */
ipcMain.handle('session:seedScrollback', async (e, id: string, text: string) => {
  if (!fromMainWin(e) || !okId(id)) return false
  if (typeof text !== 'string' || !text.trim()) return false
  try {
    const f = scrollbackFile(id)
    await mkdir(path.dirname(f), { recursive: true })
    await writeFile(f, text.slice(0, 512 * 1024))
    return true
  } catch {
    return false
  }
})

// ── Worker 操作 IPC（F7）──
ipcMain.handle(
  'worker:action',
  (_e, action: 'result' | 'kill' | 'send' | 'clean', task: string, text?: string) => {
    const r = workerAction(action, task, text)
    // 操作后强制刷新一轮（比如 kill 后状态立刻变）
    setTimeout(() => workerWatch?.refresh(), 500)
    return r
  }
)

// ── 设置 IPC ──
ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
  /* 收紧方向**先于落盘**生效：用户点掉「允许远程写入」的那一刻门就该关上。
     等 setSettings 成功再更新的话，写盘一失败（磁盘满 / 权限）界面显示"只读"、
     实际 gate 仍是 true —— 安全开关只允许往安全的方向失败。 */
  if (patch.remoteAllowInput === false) remoteAllowInput = false
  if (patch.remoteAllowApprove === false) remoteAllowApprove = false
  const next = await setSettings(patch)
  remoteAllowInput = next.remoteAllowInput // 立刻生效，不用重启
  remoteAllowApprove = next.remoteAllowApprove
  return next
})

/** 远程访问状态（设置面板显示地址与配对 token） */
ipcMain.handle('remote:status', async (e) => {
  if (!fromMainWin(e)) return null
  const s = await getSettings()
  return {
    enabled: s.remoteEnabled,
    allowInput: s.remoteAllowInput,
    allowApprove: s.remoteAllowApprove,
    running: !!remoteApi,
    port: remoteApi?.port ?? s.remotePort,
    token: remoteApi?.token ?? '',
    bindMode: s.remoteBind,
    // 实际绑到的地址。**永远不会是 0.0.0.0** —— 这个进程能 spawn pty、持有凭证
    bind: remoteApi?.host ?? (s.remoteBind === 'tailscale' ? resolveBind('tailscale').host : '127.0.0.1'),
    /** 选了 tailscale 却没找到地址 → 实际只有本机能连，界面必须说清楚 */
    fellBack: remoteFellBack,
    /** 启动失败的原因（端口被占之类）。空 = 没失败 */
    error: remoteError,
    /** 手机扫这个：带 token 的一次性配对链接 */
    pairUrl: remoteApi ? `http://${remoteApi.host}:${remoteApi.port}/#t=${remoteApi.token}` : ''
  }
})
ipcMain.handle('skills:list', async () => {
  const dirs = (await getSettings()).skillDirs
  return (await listSkills(dirs)).map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source
  }))
})
ipcMain.handle('hooks:status', async () => ({
  installed: !!hookSystem,
  endpoint: hookSystem?.endpointFile ?? '',
  settingsPath: path.join(os.homedir(), '.claude', 'settings.json'),
  consent: (await getSettings()).claudeHooks
}))

/** 设置面板「卸载 hook」：摘掉写进用户 settings.json 的条目并记住选择 */
ipcMain.handle('hooks:uninstall', async (e) => {
  if (!fromMainWin(e)) return { ok: false }
  const changed = await uninstallClaudeHooks()
  await setSettings({ claudeHooks: 'off' })
  return { ok: true, changed }
})

/* ── 首启体检：缺依赖时明确说"缺什么、影响什么、怎么补"，
   而不是让人对着一个"看起来开着但某些功能不生效"的应用猜。 ── */
export interface DoctorItem {
  key: string
  label: string
  ok: boolean
  detail: string
  hint: string
}

function which(bin: string): string {
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const p = path.join(d, bin)
    if (existsSync(p)) return p
  }
  return ''
}

ipcMain.handle('app:doctor', async (e): Promise<DoctorItem[]> => {
  if (!fromMainWin(e)) return []
  const s = await getSettings()
  const present = await claudeHooksPresent()
  const tmux = which('tmux')
  const claude = which('claude') || existsSync(path.join(os.homedir(), '.claude')) ? 'ok' : ''
  const items: DoctorItem[] = [
    {
      key: 'tmux',
      label: 'tmux 会话续存',
      ok: !!tmux,
      detail: tmux ? tmux : '未找到 tmux',
      hint: '装了才能让终端跨应用重启存活：brew install tmux'
    },
    {
      // 报实情：真去 settings.json 里找条目，而不是只看我们自己记的授权开关
      key: 'hooks',
      label: 'Claude 状态 hook',
      ok: !!hookSystem && present,
      detail: !hookSystem
        ? 'hook 服务未启动'
        : present
          ? s.claudeHooks === 'on'
            ? '已接入'
            : '条目在（早前版本装的），但当前未授权'
          : '未写入 ~/.claude/settings.json',
      hint: '没有它，节点状态只是占位，不反映 agent 真实情况'
    },
    {
      key: 'claude',
      label: 'Claude Code',
      ok: !!claude,
      detail: claude ? '已安装' : '未检测到 ~/.claude',
      hint: 'agent 节点与上下文占用依赖它'
    },
    {
      key: 'cdx',
      label: 'worker 引擎 cdx',
      ok: !!which('cdx'),
      detail: which('cdx') || '未找到 cdx',
      hint: '仅影响 F7 worker 卡片，其余功能不受影响'
    }
  ]
  return items
})

// ── 选择项目文件夹 ──
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: '选择项目文件夹'
  })
  return r.canceled ? null : r.filePaths[0]
})

// ── Agent 预设 IPC ──
ipcMain.handle('preset:list', () => listPresets())
ipcMain.handle('preset:upsert', (_e, input: Parameters<typeof upsertPreset>[0]) =>
  upsertPreset(input)
)
ipcMain.handle('preset:delete', (_e, id: string) => deletePreset(id))

// ── Identity（凭证）IPC：渲染层只见元数据，env 值不出主进程 ──
ipcMain.handle('identity:list', () => listIdentities())
ipcMain.handle(
  'identity:upsert',
  (_e, input: Parameters<typeof upsertIdentity>[0]) => upsertIdentity(input)
)
ipcMain.handle('identity:delete', (_e, id: string) => deleteIdentity(id))

// ── F2 上下文：每个简报节点一个文件，按画布连线决定注入给谁 ──
const ctxDir = (): string => path.join(app.getPath('userData'), 'contexts')
const ctxFile = (nodeId: string): string =>
  path.join(ctxDir(), `${nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)

ipcMain.handle('context:load', async (e, nodeId: string) => {
  if (!fromMainWin(e) || !okId(nodeId)) return ''
  // 简报现在按项目隔离（ctx-<projectId>）。找不到自己的文件就沿老版本回退取内容，
  // 保证从「全画布共用一份 ctx-hub」升上来时旧简报不丢；首次编辑即写进本项目自己的文件。
  const chain = [ctxFile(nodeId)]
  if (nodeId.startsWith('ctx-')) {
    chain.push(ctxFile('ctx-hub'), path.join(app.getPath('userData'), 'board-context.md'))
  }
  for (const f of chain) {
    try {
      return await readFile(f, 'utf8')
    } catch {
      // 试下一个回退源
    }
  }
  return ''
})

ipcMain.handle('context:save', async (e, nodeId: string, text: string) => {
  if (!fromMainWin(e) || !okId(nodeId)) return { ok: false, error: '非法节点 id' }
  try {
    await mkdir(ctxDir(), { recursive: true })
    const f = ctxFile(nodeId)
    await writeFile(`${f}.tmp`, String(text))
    await rename(`${f}.tmp`, f)
    return { ok: true }
  } catch (err) {
    console.error('context save failed:', err)
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
})

/* F8 L0 路由提示：常驻成本 ~60 token，只讲"何时去查"，不讲工具内容。
   没有它模型不会主动去 tb 查，整个渐进式披露就白设计了。 */
const TOOL_ROUTING_HINT = `## Termscape 工具中枢
本终端可用 \`tb\` 命令按需取用共享工具（不要凭记忆猜工具用法）：
- 遇到需要专门方法的任务（设计/出图/部署/数据/视频/文档等）先跑 \`tb skills <关键词>\`
- 命中后用 \`tb load <名称>\` 取全文再照做
- \`tb agents\` 看本画布其他 agent 终端，\`tb ask <id> <任务>\` 派活给它们
- 需要测网页时用 \`tb browser open <url>\`，再 \`tb browser text\` / \`tb browser js <代码>\` 检查——直接开在画布上，用户能实时看到`

/** 把连到该终端的所有简报节点合并成一个文件，返回路径（无连线则返回空串） */
async function buildMergedContext(termId: string, ctxIds: string[]): Promise<string> {
  const parts: string[] = [TOOL_ROUTING_HINT]
  for (const cid of ctxIds) {
    try {
      const t = (await readFile(ctxFile(cid), 'utf8')).trim()
      if (t) parts.push(t)
    } catch {
      // 该简报还没存过内容
    }
  }
  await mkdir(ctxDir(), { recursive: true })
  const out = path.join(ctxDir(), `merged-${termId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)
  await writeFile(out, parts.join('\n\n---\n\n'))
  return out
}

// ── 工作区持久化：原子写 + last-good 备份 + 损坏隔离 ──
// 裸 writeFile 写一半被杀 = JSON 截断 → load 的 catch 把它当"首次启动" → 整个画布布局静默归零。
// 所以三件事缺一不可：写到 tmp 再 rename（原子）、覆写前留 .bak（有退路）、读不出来就隔离（不静默丢）。
const workspacePath = (): string => path.join(app.getPath('userData'), 'workspace.json')
const workspaceBak = (): string => `${workspacePath()}.bak`

/** 最低限度形状校验：JSON 合法但内容不是工作区（如截断成 `{}`）同样不可信 */
function parseWorkspace(raw: string): Record<string, unknown> | null {
  const v: unknown = JSON.parse(raw)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  // v2 有 projects，v1 有 nodes；两者皆无 = 不是有效工作区
  if (!Array.isArray(o.projects) && !Array.isArray(o.nodes)) return null
  return o
}

ipcMain.handle('workspace:load', async () => {
  for (const p of [workspacePath(), workspaceBak()]) {
    let raw: string
    try {
      raw = await readFile(p, 'utf8')
    } catch {
      continue // 文件不存在：首次启动，或还没生成过备份
    }
    try {
      const ws = parseWorkspace(raw)
      if (ws) return ws
      throw new Error('形状校验未通过')
    } catch (err) {
      // 文件在、但读不出来 = 损坏。隔离而非丢弃，用户还有手工救回的机会
      const quarantine = `${p}.corrupt-${Date.now()}`
      await rename(p, quarantine).catch(() => {})
      console.error(`workspace 损坏，已隔离到 ${quarantine}:`, err)
    }
  }
  return null
})

/* 定期存档：.bak 只防"文件写坏"，防不了"内容被合法地写坏"——
   误删一堆节点后，接下来几次防抖保存就把 .bak 也覆盖成删除后的状态了（真实发生过）。
   所以每小时另留一份带时间戳的存档，保留最近 24 份，纯兜底不参与正常加载。 */
const ARCHIVE_EVERY_MS = 60 * 60 * 1000
const ARCHIVE_KEEP = 24
let lastArchiveAt = 0

async function archiveWorkspace(json: string): Promise<void> {
  const dir = path.join(app.getPath('userData'), 'workspace-archive')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  await writeFile(path.join(dir, `workspace-${stamp}.json`), json)
  const files = (await readdir(dir)).filter((f) => f.startsWith('workspace-')).sort()
  for (const old of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) {
    await unlink(path.join(dir, old)).catch(() => undefined)
  }
}

ipcMain.handle('workspace:save', async (_e, data: unknown) => {
  const f = workspacePath()
  try {
    const json = JSON.stringify(data, null, 2)
    await writeFile(`${f}.tmp`, json)
    // 先把上一版转成备份再换新：这中间被杀，load 会从 .bak 恢复
    if (existsSync(f)) await rename(f, workspaceBak())
    await rename(`${f}.tmp`, f)
    if (Date.now() - lastArchiveAt > ARCHIVE_EVERY_MS) {
      lastArchiveAt = Date.now()
      await archiveWorkspace(json).catch(() => undefined) // 存档失败不影响主保存
    }
    return { ok: true }
  } catch (err) {
    console.error('workspace save failed:', err)
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
})

app.whenReady().then(async () => {
  // 设计系统 dark-first：vibrancy 跟随系统会在浅色模式下透白，先锁深色
  nativeTheme.themeSource = 'dark'

  /* 权限收口：画布浏览器（webview guest）只用来看页面/做测试，摄像头麦克风定位通知一律不给。
     但主窗口自己要读剪贴板 —— 终端粘贴走的就是 navigator.clipboard.readText()，别误伤。 */
  const isMainWc = (wc: Electron.WebContents | null): boolean =>
    !!wc && !!mainWin && !mainWin.isDestroyed() && wc === mainWin.webContents
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(isMainWc(wc) && permission.startsWith('clipboard'))
  )
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    isMainWc(wc) && permission.startsWith('clipboard')
  )

  /* 写用户全局的 ~/.claude/settings.json 有侵入性，必须先问过 —— 但不能在这里问：
     对话框会把启动整个卡住（窗口都还没建）。先按已有选择起服务，窗口起来之后再问。 */
  const st = await getSettings()
  const installHooks = st.claudeHooks === 'on'
  remoteAllowInput = st.remoteAllowInput
  remoteAllowApprove = st.remoteAllowApprove

  // hook 系统先于窗口（pty spawn 需要 endpoint 路径）；失败不阻塞启动
  contextTail = createContextTail((u) => sendToWin('agent:context', u))
  try {
    hookSystem = await startHookSystem(
      (e) => {
        sendToWin('agent:status', e)
        remoteApi?.push('status', e)
        // 派活等待判完成 + 会话存活判定（sessionId 用来挡已结束会话的迟到事件）
        noteStatus(e.nodeId, e.state, e.event, e.sessionId)
      },
      (nodeId, tp) => {
        contextTail?.track(nodeId, tp)
        noteTranscript(nodeId, tp) // 派活取结果用
      },
      {
        // F8 工具中枢：agent 在终端里跑 tb 命令走这三个处理器
        skills: async (q) => {
          const dirs = (await getSettings()).skillDirs
          const hits = await searchSkills(q, dirs)
          if (!hits.length) return `没有匹配「${q}」的 skill。tb skills 不带参数可列出全部。`
          return hits.map((s) => `${s.name}\n    ${s.description}`).join('\n')
        },
        load: async (name) => {
          const dirs = (await getSettings()).skillDirs
          const text = await loadSkill(name, dirs)
          return text ?? `未找到 skill「${name}」，先用 tb skills <关键词> 查名字。`
        },
        agents: async (source) => {
          const others = boardAgents.filter((a) => a.id !== source)
          if (!others.length) return '画布上暂无其他 agent 终端。'
          return others
            .map((a) => {
              const linked = boardLinks.has(`${source}>${a.id}`) ? '已连线' : '未连线'
              const live = isAgentSession(a.id) ? 'agent' : 'shell'
              return `${a.id}\t${a.title}\t${a.provider ?? 'shell'}\t${a.status}\t${live}\t${linked}`
            })
            .join('\n')
        },
        ask: (source, target, task) =>
          delegate(
            {
              hasNode: (nid) => ptys.has(nid),
              writeToPty: (nid, data) => ptys.get(nid)?.write(data),
              authorize: (s, t, task2) =>
                authorizeLink(
                  s,
                  t,
                  '把任务派给',
                  `任务内容会被当作输入敲进 ${t} 的终端：\n${task2.slice(0, 300)}`
                )
            },
            source,
            target,
            task
          ),
        browser: async (source, action, arg, nodeId) => {
          // list 之外的动作都碰得到已登录页面的内容（text/shot 同样能读走邮箱、后台、token），
          // 所以一律要授权；open 是新建一个空白节点，创建者当场获授权。
          if (action !== 'list') {
            // 省略 --node 时必须先解析出**真实**的默认节点 id 再授权，
            // 否则拿一个虚构 key 去比对连线，永远匹配不上（授权形同虚设）
            let target = nodeId
            if (!target && action !== 'open') {
              const ids = (await browserCommand('list', '', ''))
                .split('\n')
                .map((s) => s.trim())
                .filter((s) => /^[A-Za-z0-9_-]+$/.test(s))
              if (!ids.length) return '画布上没有浏览器节点，先 tb browser open <url>'
              target = ids[0]
            }
            if (action !== 'open') {
              const ok = await authorizeLink(
                source,
                target,
                '驱动浏览器节点',
                `动作：${action} ${arg.slice(0, 200)}\n目标：${target}\n该页面可能持有你的登录态。`
              )
              if (!ok) {
                return `已拒绝：${source} 未获授权驱动 ${target}。在画布上从该终端拉一条线到该浏览器节点即可长期授权。`
              }
            }
            nodeId = target
          }
          const r = await browserCommand(action, arg, nodeId, source)
          // open 出来的节点归创建者：renderer 侧已自动连线，这里再补一条 grant 兜底
          // （连线是渲染态，落盘前主进程还没收到 links 上报）
          if (action === 'open' && source && /^[A-Za-z0-9_-]+$/.test(r.trim().split('\n')[0])) {
            grants.add(`${source}>${r.trim().split('\n')[0]}`)
          }
          // 截图：把 data URL 落盘成 png，返回路径给 agent 读图
          if (action === 'shot' && r.startsWith('data:image')) {
            try {
              const b64 = r.split(',')[1] ?? ''
              const dir = path.join(app.getPath('userData'), 'shots')
              await mkdir(dir, { recursive: true })
              const f = path.join(dir, `shot-${Date.now().toString(36)}.png`)
              await writeFile(f, Buffer.from(b64, 'base64'))
              return `截图已存：${f}\n（用你的读图能力打开此文件查看页面）`
            } catch (err) {
              return `截图保存失败：${String(err)}`
            }
          }
          return r
        }
      },
      (list) => {
        const enriched = withVerdict(list)
        sendToWin('approvals:update', enriched)
        remoteApi?.push('approvals', enriched)
      },
      installHooks
    )
  } catch (err) {
    console.error('hook system failed to start:', err)
  }

  // F7 worker 卡片：轮询 cdx list（franke_skills 引擎）
  workerWatch = startWorkerWatch((rows) => sendToWin('workers:update', rows))

  /* 远程 API（阶段 0）：默认关闭。只绑 127.0.0.1，远程访问请走 Tailscale 这类
     设备级 VPN —— 这个进程能 spawn pty、持有凭证，绝不能自己往公网监听。 */
  if (st.remoteEnabled) {
    try {
      const bind = resolveBind(st.remoteBind)
      remoteApi = await startRemoteApi({
        tokenFile: path.join(app.getPath('userData'), 'remote-token'),
        port: st.remotePort,
        host: bind.host,
        // 打包后 mobile/ 在 asar 里（electron-builder.yml 的 files 收了它），fs 能直接读
        staticDir: path.join(app.getAppPath(), 'mobile'),
        allowInput: () => remoteAllowInput,
        allowApprove: () => remoteAllowApprove,
        getBoard: () => boardSnapshot,
        listApprovals: () => withVerdict(hookSystem?.listApprovals() ?? []),
        decideApproval: (id, allow) => hookSystem?.decideApproval(id, allow) ?? false,
        peek: (nodeId, lines) => peekPane(nodeId, lines),
        writeInput: (nodeId, text) => {
          const p = ptys.get(nodeId)
          if (!p) return false
          p.write(text)
          return true
        }
      })
      remoteFellBack = bind.fellBack
      console.log(`远程 API 已启动：http://${remoteApi.host}:${remoteApi.port}`)
      if (bind.fellBack) {
        console.warn('远程绑定退回 127.0.0.1：没找到 Tailscale 地址（没登录/没启动？）')
      }
    } catch (err) {
      remoteError = String((err as { message?: string })?.message ?? err)
      console.error('远程 API 启动失败:', err)
    }
  }

  // 额度 HUD：读官方真值文件（statusline 同源），60s 轮询
  const quotaFile = path.join(os.homedir(), '.claude', 'claude-usage.json')
  const pushQuota = async (): Promise<void> => {
    try {
      const q = JSON.parse(await readFile(quotaFile, 'utf8'))
      sendToWin('quota:update', q)
    } catch {
      // 文件缺失/损坏时 HUD 不显示
    }
  }
  const quotaTimer = setInterval(() => void pushQuota(), 60_000)
  app.on('before-quit', () => clearInterval(quotaTimer))

  const win = createWindow()
  mainWin = win
  // 渲染层 React mount 后主动握手 → 重推全部状态
  // （did-finish-load 早于 React 订阅注册，直接推会竞态丢失）
  ipcMain.on('renderer:ready', () => {
    void pushQuota()
    workerWatch?.refresh()
    // 首启征求 hook 写入同意：放在窗口起来之后问，别卡启动；自检截图模式下跳过。
    // renderer:ready 每次 reload/HMR 都会来，askedConsent 保证一轮只问一次。
    if (st.claudeHooks === 'ask' && !askedConsent && !process.env['TERMBOARD_SHOT']) {
      askedConsent = true
      void dialog
        .showMessageBox(win, {
          type: 'question',
          buttons: ['暂不', '允许写入'],
          defaultId: 1,
          cancelId: 0,
          message: 'Termscape 需要写入 ~/.claude/settings.json',
          detail:
            '用于接收 Claude Code 的运行状态（节点发光、谁在等你审批、上下文占用），' +
            '以及把工具调用审批接到画布上。\n\n' +
            '已有 hook 条目会保留，原文件首次备份为 settings.json.termboard-backup，' +
            '随时可在「设置 → Hooks 与状态」里卸载。\n\n' +
            '选「暂不」也能正常使用，只是节点状态不反映 agent 真实情况。'
        })
        .then(async ({ response }) => {
          const yes = response === 1
          await setSettings({ claudeHooks: yes ? 'on' : 'off' })
          // 说「暂不」时要把早前版本装进去的条目也摘掉，否则嘴上拒绝、文件里还留着
          if (yes) await hookSystem?.enableHooks()
          else await uninstallClaudeHooks()
        })
    }
    // 审批只有增量推送，reload/HMR 后既有的挂起审批就再也不显示了 → 重放一次快照
    // 必须过 withVerdict：漏了这一层，reload 后重放出来的危险请求会退化成
    // 一枚普通蓝色「批准」（verdict 为空 → 不显示风险横幅、也没有两段式确认）
    const pend = withVerdict(hookSystem?.listApprovals() ?? [])
    if (pend.length) sendToWin('approvals:update', pend)
  })

  // 自检模式：TERMBOARD_SHOT=/path/x.png 启动 → 6 秒后截图退出
  const shotPath = process.env['TERMBOARD_SHOT']
  if (shotPath) {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage()
        await writeFile(shotPath, img.toPNG())
      } finally {
        app.quit()
      }
    }, 6000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('window-all-closed', () => {
  if (quitting) return
  quitting = true
  // 只释放客户端 —— tmux 会话跨 app 重启存活（续存核心语义）。
  // 抓屏是异步的，必须等它写完再 quit，否则 cold-restore 快照永远缺最后一屏。
  const snapshots = [...ptys.keys()].map((id) => releasePty(id))
  hookSystem?.dispose()
  workerWatch?.dispose()
  contextTail?.dispose()
  remoteApi?.dispose()
  // 兜底 3s：某个 tmux capture 卡住也不能让 app 关不掉
  void Promise.race([
    Promise.allSettled(snapshots),
    new Promise((r) => setTimeout(r, 3000))
  ]).then(() => app.quit())
})
