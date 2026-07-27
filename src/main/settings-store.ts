/** 系统级设置（明文 JSON，无敏感信息） */
import { app } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isPeerAlias } from './peer'

export interface Settings {
  defaultFontSize: number
  defaultShell: string // '' = 跟随 $SHELL
  tmuxEnabled: boolean
  scrollback: number
  skillDirs: string[] // F8 工具中枢的 skill 库来源
  /**
   * 是否把托管 hook 写进用户全局的 ~/.claude/settings.json。
   * 'ask' = 还没问过（首启会弹窗征得同意）。改用户全局配置这种事不能默默做。
   */
  claudeHooks: 'ask' | 'on' | 'off'
  /** 远程 API（手机/其他电脑当客户端）。默认关闭，只绑 127.0.0.1 */
  remoteEnabled: boolean
  /** 远程端能否往终端写入。默认只读 —— 写入是把 shell 交出去，必须显式开 */
  remoteAllowInput: boolean
  /** 远程端能否批准工具调用。默认关 —— 批一次 rm -rf 比敲一行字危险得多 */
  remoteAllowApprove: boolean
  remotePort: number
  /**
   * 绑哪张网卡。'loopback' = 只有本机；'tailscale' = 绑 tailnet 那个 100.x 地址，
   * 手机加入同一 tailnet 后可访问。**没有 0.0.0.0 这个选项，也不要加**。
   */
  remoteBind: 'loopback' | 'tailscale'
  /**
   * 可以跨机派活过去的 ssh alias 白名单（`tb ask mini:t-abc <任务>` 里的 `mini`）。
   * **只存 alias，不存任何密钥** —— 认证完全交给用户已有的 ssh 配置。
   * 白名单是必须的：alias 直接进 ssh 的 argv，见 peer.ts 的 peerAllowed。
   */
  peers: string[]
  /**
   * 本机是否接受**别的机器**派过来的活。默认关。
   * 诚实说明：能 ssh 进本机的人本来就有完整 shell 权限，所以这个开关
   * 和 peers 白名单一样是产品护栏（挡误用、挡 agent 自作主张），不是安全边界。
   */
  peerDelegate: boolean
}

export const DEFAULTS: Settings = {
  defaultFontSize: 13,
  defaultShell: '',
  tmuxEnabled: true,
  scrollback: 8000,
  skillDirs: [],
  claudeHooks: 'ask',
  remoteEnabled: false,
  remoteAllowInput: false,
  remoteAllowApprove: false,
  remotePort: 7333,
  remoteBind: 'loopback',
  peers: [],
  peerDelegate: false
}

const file = (): string => path.join(app.getPath('userData'), 'settings.json')
let cache: Settings | null = null

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  if (!existsSync(file())) {
    cache = { ...DEFAULTS }
    return cache
  }
  try {
    cache = sanitize({
      ...DEFAULTS,
      ...(JSON.parse(await readFile(file(), 'utf8')) as Partial<Settings>)
    })
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

/**
 * 收敛到合法值。**读盘和写盘都要过**：手改文件把 `"remoteAllowInput": "false"` 写成字符串
 * 时，浅合并出来是个 truthy 值，等于把远程写入偷偷打开了 —— 三个安全开关只认 `=== true`。
 */
function sanitize(s: Settings): Settings {
  const bool = (v: unknown): boolean => v === true
  return {
    ...s,
    defaultFontSize: clampInt(s.defaultFontSize, 8, 24, DEFAULTS.defaultFontSize),
    scrollback: clampInt(s.scrollback, 500, 100_000, DEFAULTS.scrollback),
    // 0 会让 Node 绑一个随机端口（二维码里的端口就对不上了），必须挡住
    remotePort: clampInt(s.remotePort, 1024, 65535, DEFAULTS.remotePort),
    tmuxEnabled: s.tmuxEnabled !== false,
    remoteEnabled: bool(s.remoteEnabled),
    remoteAllowInput: bool(s.remoteAllowInput),
    remoteAllowApprove: bool(s.remoteAllowApprove),
    peerDelegate: bool(s.peerDelegate),
    /* alias 会进 ssh 的 argv，**读盘这一步就要把脏的滤掉**：
       手改 settings.json 塞一个 `-oProxyCommand=...` 进去，等于让任何能派活的
       agent 在本机执行任意命令。判据直接用 peer.ts 的，不另写一份正则。 */
    peers: Array.isArray(s.peers) ? s.peers.filter(isPeerAlias) : [],
    // 绑定地址不接受任意输入：不是精确的 'tailscale' 一律当仅本机
    remoteBind: s.remoteBind === 'tailscale' ? 'tailscale' : 'loopback',
    claudeHooks: s.claudeHooks === 'on' ? 'on' : s.claudeHooks === 'off' ? 'off' : 'ask',
    skillDirs: Array.isArray(s.skillDirs) ? s.skillDirs.filter((d) => typeof d === 'string') : [],
    defaultShell: typeof s.defaultShell === 'string' ? s.defaultShell : ''
  }
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/* 写盘串行化：并发改两个开关时，共用一个固定 .tmp 会互相覆盖，
   甚至让后一次 rename 撞上 ENOENT（前一次已经把 tmp 改名走了）。 */
let writeChain: Promise<unknown> = Promise.resolve()

export function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = writeChain.then(async () => {
    const cur = await getSettings()
    const next = sanitize({ ...cur, ...patch })
    /* 先更新内存缓存再落盘：落盘失败时，用户在界面上关掉的开关**必须**已经生效。
       反过来（落盘成功才生效）意味着写盘一出错，界面显示"只读"而实际仍可写 ——
       安全开关只能往收紧的方向 fail。 */
    cache = next
    // 临时文件名带随机后缀，见上面的注释
    const tmp = `${file()}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2))
    await rename(tmp, file())
    return next
  })
  // 链上一环失败不能卡死后续写入
  writeChain = run.catch(() => undefined)
  return run
}
