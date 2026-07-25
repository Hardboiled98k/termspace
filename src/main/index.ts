import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as pty from 'node-pty'
import { startHookSystem, type HookSystem } from './hooks'
import { createContextTail, type ContextTail } from './context-tail'
import {
  listIdentities,
  upsertIdentity,
  deleteIdentity,
  resolveIdentityEnv
} from './identity-store'
import { listPresets, upsertPreset, deletePreset } from './preset-store'
import { startWorkerWatch, workerAction, type WorkerWatch } from './worker-watch'
import { getSettings, setSettings, type Settings } from './settings-store'
import { searchSkills, loadSkill, listSkills } from './skill-index'
import { delegate, noteTranscript, noteStatus, dropNode } from './delegate'
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

const ptys = new Map<string, pty.IPty>()
let hookSystem: HookSystem | null = null
let contextTail: ContextTail | null = null
let workerWatch: WorkerWatch | null = null
let mainWin: BrowserWindow | null = null
/** 渲染层推来的画布 agent 摘要，供 tb agents / 派活用 */
let boardAgents: { id: string; title: string; provider?: string; status: string }[] = []
ipcMain.on('board:agents', (_e, list: typeof boardAgents) => {
  boardAgents = Array.isArray(list) ? list : []
})

// 全工作区已知节点 id（跨所有项目）→ 清理不在其中的孤儿 tmux 会话
ipcMain.handle('sessions:reap', async (_e, knownIds: string[]) => {
  const keep = new Set([...(Array.isArray(knownIds) ? knownIds : []), ...ptys.keys()])
  return reapOrphanSessions(keep)
})

// tb browser：主进程 ↔ renderer 往返（renderer 持有 webview）
const browserPending = new Map<string, (r: { ok: boolean; result: string }) => void>()
let browserReqSeq = 0
function browserCommand(action: string, arg: string, nodeId: string): Promise<string> {
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
    mainWin.webContents.send('browser:cmd', { reqId, nodeId, action, arg })
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
  idLocks.set(
    id,
    next.catch(() => undefined)
  )
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

/** 真结束：kill-session + 客户端 + 清快照（节点 ✕ / 换身份重生成）*/
function destroyPty(id: string): Promise<void> {
  return serialize(id, async () => {
    contextTail?.untrack(id)
    dropNode(id)
    await releasePty(id, false)
    await pendingSnapshots.get(id) // 等在飞的抓屏落完，否则下一行删了又被写回来
    // 快照必须删：否则删掉节点后，新节点若拿到同一个 id 会回灌已删除终端的内容
    await unlink(scrollbackFile(id)).catch(() => undefined)
    await killSession(id)
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
    // 等该 id 上未收尾的 destroy（kill-session 是异步的，抢跑会杀掉马上要建的新会话）
    await idLocks.get(id)
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
      // F8：tb 命令挂到 PATH 最前，agent 直接可用
      env['PATH'] = `${hookSystem.binDir}:${env['PATH'] ?? ''}`
    }
    // F2 上下文 + F8 工具路由提示（合成一份文件，Claude 预设经 --append-system-prompt 注入）
    env['TERMBOARD_CONTEXT_FILE'] = await buildMergedContext(id, opts?.contextNodeIds ?? [])
    // identity env 包注入（多账号/多 key，密文存储主进程解密）
    const idEnv = await resolveIdentityEnv(opts?.identityId)
    if (idEnv) Object.assign(env, idEnv)

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
  const { file, args } = buildSpawnArgs(tmux, id, shell, cwd, env)
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
    if (!wc.isDestroyed()) wc.send(`pty:exit:${id}`, exitCode)
  })
})

ipcMain.on('pty:write', (_e, id: string, data: string) => {
  ptys.get(id)?.write(data)
})

ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
  if (cols > 0 && rows > 0) {
    try {
      ptys.get(id)?.resize(cols, rows)
    } catch {
      // resize 竞态：进程刚退出时忽略
    }
  }
})

ipcMain.on('pty:kill', (_e, id: string) => {
  // effect cleanup（remount/HMR/reload 前奏）→ 释放客户端，会话续存
  void releasePty(id)
})

// 节点 ✕ / 换身份 → 真杀会话。可 await：renderer 换身份时要等旧会话确实死透再 respawn
ipcMain.handle('pty:destroy', (_e, id: string) => destroyPty(id))

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
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => setSettings(patch))
ipcMain.handle('skills:list', async () => {
  const dirs = (await getSettings()).skillDirs
  return (await listSkills(dirs)).map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source
  }))
})
ipcMain.handle('hooks:status', () => ({
  installed: !!hookSystem,
  endpoint: hookSystem?.endpointFile ?? '',
  settingsPath: path.join(os.homedir(), '.claude', 'settings.json')
}))

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

ipcMain.handle('context:load', async (_e, nodeId: string) => {
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

ipcMain.handle('context:save', async (_e, nodeId: string, text: string) => {
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

ipcMain.handle('workspace:save', async (_e, data: unknown) => {
  const f = workspacePath()
  try {
    const json = JSON.stringify(data, null, 2)
    await writeFile(`${f}.tmp`, json)
    // 先把上一版转成备份再换新：这中间被杀，load 会从 .bak 恢复
    if (existsSync(f)) await rename(f, workspaceBak())
    await rename(`${f}.tmp`, f)
    return { ok: true }
  } catch (err) {
    console.error('workspace save failed:', err)
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
})

app.whenReady().then(async () => {
  // 设计系统 dark-first：vibrancy 跟随系统会在浅色模式下透白，先锁深色
  nativeTheme.themeSource = 'dark'

  // hook 系统先于窗口（pty spawn 需要 endpoint 路径）；失败不阻塞启动
  contextTail = createContextTail((u) => sendToWin('agent:context', u))
  try {
    hookSystem = await startHookSystem(
      (e) => {
        sendToWin('agent:status', e)
        noteStatus(e.nodeId, e.state) // 派活等待判完成用
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
        agents: async () => {
          if (!boardAgents.length) return '画布上暂无其他 agent 终端。'
          return boardAgents
            .map((a) => `${a.id}\t${a.title}\t${a.provider ?? 'shell'}\t${a.status}`)
            .join('\n')
        },
        ask: (target, task) =>
          delegate(
            {
              hasNode: (nid) => ptys.has(nid),
              writeToPty: (nid, data) => ptys.get(nid)?.write(data)
            },
            target,
            task
          ),
        browser: async (action, arg, nodeId) => {
          const r = await browserCommand(action, arg, nodeId)
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
      }
    )
  } catch (err) {
    console.error('hook system failed to start:', err)
  }

  // F7 worker 卡片：轮询 cdx list（franke_skills 引擎）
  workerWatch = startWorkerWatch((rows) => sendToWin('workers:update', rows))

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
  // 兜底 3s：某个 tmux capture 卡住也不能让 app 关不掉
  void Promise.race([
    Promise.allSettled(snapshots),
    new Promise((r) => setTimeout(r, 3000))
  ]).then(() => app.quit())
})
