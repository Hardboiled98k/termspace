import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
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
import { startWorkerWatch, type WorkerWatch } from './worker-watch'

// dev 下 app 名默认是 "Electron"，userData 会指向共享目录 → 显式隔离
app.setPath('userData', path.join(app.getPath('appData'), 'termboard'))

const ptys = new Map<string, pty.IPty>()
let hookSystem: HookSystem | null = null
let contextTail: ContextTail | null = null
let workerWatch: WorkerWatch | null = null
let mainWin: BrowserWindow | null = null

function sendToWin(channel: string, data: unknown): void {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, data)
}

function killPty(id: string): void {
  contextTail?.untrack(id)
  const p = ptys.get(id)
  if (!p) return
  ptys.delete(id)
  try {
    p.kill()
  } catch {
    // 进程可能已退出
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1520,
    height: 940,
    title: 'TermBoard',
    backgroundColor: '#00000000',
    vibrancy: 'under-window', // macOS 毛玻璃材质，画布透明底透出
    visualEffectState: 'active',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // reload 时 renderer effect cleanup 不执行，孤儿 pty 在导航提交时全量回收
  // （did-navigate 先于新页面 JS 执行，不会误杀新 spawn）
  win.webContents.on('did-navigate', () => {
    for (const id of [...ptys.keys()]) killPty(id)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

interface SpawnOpts {
  identityId?: string
  command?: string // agent 预设启动命令，spawn 后写入 shell
  provider?: string
}

ipcMain.handle(
  'pty:spawn',
  async (e, id: string, cols: number, rows: number, opts?: SpawnOpts) => {
    killPty(id)
    const shell = process.env['SHELL'] || '/bin/zsh'
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    env['TERM'] = 'xterm-256color'
    env['COLORTERM'] = 'truecolor'
    // hook 门控：托管脚本只在带 NODE_ID 的终端里工作
    env['TERMBOARD_NODE_ID'] = id
    env['TERMBOARD_AGENT_ID'] = opts?.provider ?? 'claude'
    if (hookSystem) env['TERMBOARD_HOOK_ENDPOINT'] = hookSystem.endpointFile
    // identity env 包注入（多账号/多 key，密文存储主进程解密）
    const idEnv = await resolveIdentityEnv(opts?.identityId)
    if (idEnv) Object.assign(env, idEnv)

  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 24,
    cwd: os.homedir(),
    env
  })
  ptys.set(id, p)

  // agent 预设：等 shell 就绪后写入启动命令（tty 缓冲会排队，200ms 只是保险）
  const cmd = opts?.command?.trim()
  if (cmd) {
    setTimeout(() => {
      if (ptys.get(id) === p) p.write(`${cmd}\r`)
    }, 200)
  }

  const wc = e.sender
  p.onData((data) => {
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
  killPty(id)
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

// ── 工作区持久化（JSON，M1 简版；多项目/tmux 续存后续做）──
const workspacePath = (): string => path.join(app.getPath('userData'), 'workspace.json')

ipcMain.handle('workspace:load', async () => {
  try {
    return JSON.parse(await readFile(workspacePath(), 'utf8'))
  } catch {
    return null // 首次启动无文件
  }
})

ipcMain.handle('workspace:save', async (_e, data: unknown) => {
  try {
    await writeFile(workspacePath(), JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('workspace save failed:', err)
  }
})

app.whenReady().then(async () => {
  // 设计系统 dark-first：vibrancy 跟随系统会在浅色模式下透白，先锁深色
  nativeTheme.themeSource = 'dark'

  // hook 系统先于窗口（pty spawn 需要 endpoint 路径）；失败不阻塞启动
  contextTail = createContextTail((u) => sendToWin('agent:context', u))
  try {
    hookSystem = await startHookSystem(
      (e) => sendToWin('agent:status', e),
      (nodeId, tp) => contextTail?.track(nodeId, tp)
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

app.on('window-all-closed', () => {
  for (const id of [...ptys.keys()]) killPty(id)
  hookSystem?.dispose()
  workerWatch?.dispose()
  contextTail?.dispose()
  app.quit()
})
