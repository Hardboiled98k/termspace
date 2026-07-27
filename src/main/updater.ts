/**
 * 自动更新（Warp 那套：后台检测 → 后台下载 → 提示 → 用户点了才装）。
 *
 * ## macOS 上的硬约束
 *
 * - **必须签名**。Squirrel.Mac 要求候选 app 满足**由当前 app 的代码签名导出的
 *   designated requirement**（我们有 Developer ID，见 CLAUDE.md「打包签名」）。
 *
 *   它保证的仅仅是"候选包的身份与完整性满足当前签名要求"。它**不**保证：
 *   更新来自官方目录、`latest-mac.yml` 是真的、包比现在新、包没有已知漏洞、
 *   包过了公证、私钥没泄漏。拿到能满足该 requirement 的签名能力就能造出可装的包。
 *
 *   `latest-mac.yml` 里的 sha512 是**下载完整性**校验，不是发布者身份认证 ——
 *   攻击者若同时控制 yml 和 zip，可以给恶意包算一个完全匹配的 sha512。
 *   所以发布目录本身的控制权是这条链路的信任根，最后一道边界才是代码签名。
 * - **走 zip 不走 dmg**。dmg 是给人手动装的，Squirrel 只认 zip；
 *   所以 `electron-builder.yml` 的 mac target 要同时出 `dmg` 和 `zip`。
 * - **dev 模式下必须整个关掉**：没有 `app-update.yml`（那是打包时生成的），
 *   electron-updater 会直接抛。
 *
 * ## 为什么不自动装
 *
 * 这个 app 的终端里跑着用户的活。**自动重启 = 把人家正在跑的东西掐了** ——
 * 虽然 tmux 会话能续存，但 agent 的那一轮对话不会。所以只到"下载好了"为止，
 * 装不装、什么时候装，用户说了算。
 */
import { app, type BrowserWindow } from 'electron'

/** 推给渲染层的更新状态。**每一档都要能区分**，界面据此决定显示什么 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** 已是最新。带上当前版本，让"检查更新"这个动作有可见的反馈 */
  | { phase: 'current'; version: string }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string; notes?: string }
  /** 查不了。**不弹窗、不打断** —— 更新失败不是用户此刻要处理的事 */
  | { phase: 'error'; message: string }

export interface Updater {
  check: (userInitiated: boolean) => void
  /** 用户点「重启并安装」 */
  install: () => void
  state: () => UpdateState
  dispose: () => void
}

/** 每 6 小时自检一次。更密没有意义 —— 发版不会那么频繁，而每次都是一次网络请求 */
const CHECK_EVERY_MS = 6 * 60 * 60_000

export function startUpdater(
  win: () => BrowserWindow | null,
  opts: { enabled: () => boolean; feedUrl: () => string }
): Updater {
  let state: UpdateState = { phase: 'idle' }
  let timer: NodeJS.Timeout | null = null
  /** 上一次用的更新源。换了就把已下载的作废，见 check 里的注释 */
  let lastFeed = ''

  const push = (s: UpdateState): void => {
    state = s
    const w = win()
    if (w && !w.isDestroyed()) w.webContents.send('update:state', s)
  }

  /* dev 下 electron-updater 会因为找不到 app-update.yml 直接抛。
     整个模块降级成"永远 idle"，而不是让主进程每 6 小时抛一次未捕获异常。 */
  if (!app.isPackaged) {
    return {
      check: () => push({ phase: 'error', message: '开发模式不检查更新' }),
      install: () => undefined,
      state: () => state,
      dispose: () => undefined
    }
  }

  // 动态 require：dev 下上面已经 return 了，这里不会执行到
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')

  autoUpdater.autoDownload = true
  /* **绝不自动装**。默认值 true 会在退出时静默替换掉 app —— 用户下次打开发现
     版本变了、而且没人问过他。见文件头。 */
  autoUpdater.autoInstallOnAppQuit = false
  /* electron-updater 6.x 默认就是 false，**显式写出来**是为了把它变成一条
     有意的策略而不是一个默认值：签名本身不提供版本单调性，防降级完全靠这一层。
     将来启用 prerelease / channel 时很容易无意中改掉它。 */
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => push({ phase: 'checking' }))
  autoUpdater.on('update-not-available', (i) =>
    push({ phase: 'current', version: i?.version ?? app.getVersion() })
  )
  /* 版本号要**单独存**，不能从展示状态反推。第一次 download-progress 之后
     phase 已经是 'downloading' 了，再按 `phase === 'available'` 去取版本
     就只剩空串 —— 界面会从「正在下载 0.2.0」变成「正在下载 」。
     正常下载必现，不需要任何乱序。 */
  let pending = ''
  autoUpdater.on('update-available', (i) => {
    pending = i.version
    push({ phase: 'available', version: i.version })
  })
  autoUpdater.on('download-progress', (p) =>
    push({ phase: 'downloading', version: pending, percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (i) => {
    pending = i.version
    push({
      phase: 'ready',
      version: i.version,
      notes: typeof i.releaseNotes === 'string' ? i.releaseNotes.slice(0, 2000) : undefined
    })
  })
  /* 更新查不了是**常态**（离线、发布源没配、证书过期），不该打断任何人。
     只把原因留在设置面板里，让想看的人看得到。 */
  autoUpdater.on('error', (e) => push({ phase: 'error', message: String(e?.message ?? e) }))

  const check = (userInitiated: boolean): void => {
    // 用户明确点了「检查更新」时无视开关 —— 他此刻就是想查
    if (!userInitiated && !opts.enabled()) return
    /* 正在进行时不再发起新一轮：electron-updater 的 check promise 会在
       **自动下载完成之前**就 resolve，此时再 check 会让两轮的事件交错，
       进度和版本号互相覆盖。界面禁用了按钮，但定时器不看界面。 */
    if (state.phase === 'checking' || state.phase === 'downloading') return
    const feed = opts.feedUrl()
    /* 没配更新源就**明说**，不要去打包时那个占位域名。
       否则用户看到的是一条看不懂的 DNS 错误，而真正的问题是"你还没填地址"。 */
    if (!feed) {
      return push({ phase: 'error', message: '还没配更新源（设置 → 更新）' })
    }
    /* 每次都设一遍：用户可能刚在设置里改了地址，
       而 autoUpdater 是单例、feed 只在 setFeedURL 时才更新。 */
    /* 换了源就把已下载的那个作废。包本身仍受签名校验保护，但「我明明改了源，
       它装的还是旧源下来的包」在产品语义上是错的。 */
    if (feed !== lastFeed) {
      lastFeed = feed
      pending = ''
      if (state.phase === 'ready') state = { phase: 'idle' }
    }
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    autoUpdater.checkForUpdates().catch((e: unknown) => {
      push({ phase: 'error', message: String((e as Error)?.message ?? e) })
    })
  }

  // 启动后等 20s 再查：别和首屏的 pty spawn、hook server、额度采集抢
  const first = setTimeout(() => check(false), 20_000)
  timer = setInterval(() => check(false), CHECK_EVERY_MS)

  return {
    check,
    install: () => {
      if (state.phase !== 'ready') return
      /* macOS 上 MacUpdater 重写了 quitAndInstall，**这两个参数不按
         BaseUpdater 的语义解释** —— 重开行为由 MacUpdater 自己完成。
         传值只是为了在别的平台上也说得通；别照着 BaseUpdater 的文档理解这一行。 */
      autoUpdater.quitAndInstall(false, true)
    },
    state: () => state,
    dispose: () => {
      clearTimeout(first)
      if (timer) clearInterval(timer)
    }
  }
}
