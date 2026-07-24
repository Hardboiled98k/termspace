import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as pty from 'node-pty'

// dev 下 app 名默认是 "Electron"，userData 会指向共享目录 → 显式隔离
app.setPath('userData', path.join(app.getPath('appData'), 'termboard'))

const ptys = new Map<string, pty.IPty>()

function killPty(id: string): void {
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

ipcMain.handle('pty:spawn', (e, id: string, cols: number, rows: number) => {
  killPty(id)
  const shell = process.env['SHELL'] || '/bin/zsh'
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'

  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 24,
    cwd: os.homedir(),
    env
  })
  ptys.set(id, p)

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

app.whenReady().then(() => {
  // 设计系统 dark-first：vibrancy 跟随系统会在浅色模式下透白，先锁深色
  nativeTheme.themeSource = 'dark'
  const win = createWindow()

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
  app.quit()
})
