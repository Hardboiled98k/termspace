/// <reference types="vite/client" />

interface AppSettings {
  defaultFontSize: number
  defaultShell: string
  tmuxEnabled: boolean
  scrollback: number
  skillDirs: string[]
  claudeHooks: 'ask' | 'on' | 'off'
  remoteEnabled: boolean
  remoteAllowInput: boolean
  remoteAllowApprove: boolean
  remotePort: number
  remoteBind: 'loopback' | 'tailscale'
}

/** 审批规则引擎的判定。**没有 allow** —— 见 src/main/approval-policy.ts */
interface PolicyVerdict {
  decision: 'require_human' | 'deny'
  rule: string
  reason: string
}

interface IdentityMeta {
  id: string
  name: string
  provider: 'claude' | 'codex' | 'gemini' | 'custom'
  envKeys: string[]
}

interface Preset {
  id: string
  name: string
  provider: 'claude' | 'codex' | 'gemini' | 'custom'
  command: string
  identityId?: string
}

interface TermscapeApi {
  spawn: (
    id: string,
    cols: number,
    rows: number,
    opts?: {
      identityId?: string
      command?: string
      provider?: string
      contextNodeIds?: string[]
      cwd?: string
    }
  ) => Promise<void>
  pickFolder: () => Promise<string | null>
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  hooksStatus: () => Promise<{
    installed: boolean
    endpoint: string
    settingsPath: string
    consent: 'ask' | 'on' | 'off'
  }>
  uninstallHooks: () => Promise<{ ok: boolean; changed?: boolean }>
  remoteStatus: () => Promise<{
    enabled: boolean
    allowInput: boolean
    allowApprove: boolean
    running: boolean
    port: number
    token: string
    bind: string
    bindMode: 'loopback' | 'tailscale'
    /** 选了 tailscale 却没找到 100.x 地址，实际退回了回环 */
    fellBack: boolean
    /** 启动失败原因，空表示没失败 */
    error: string
    /** 带 token 的配对链接，手机扫码即连 */
    pairUrl: string
  } | null>
  doctor: () => Promise<
    { key: string; label: string; ok: boolean; detail: string; hint: string }[]
  >
  reapSessions: (knownIds: string[]) => Promise<number>
  listSkills: () => Promise<{ name: string; description: string; source: string }[]>
  reportAgents: (payload: {
    agents: { id: string; title: string; provider?: string; status: string }[]
    /** 授权连线，形如 `source>target` */
    links: string[]
    /** 现存节点 id 全集（主进程据此撤销失效授权） */
    nodeIds: string[]
    /** 完整画布快照（远程 API 用；只含布局与状态，不含终端内容） */
    board: unknown
  }) => void
  onApprovals: (
    cb: (
      list: {
        id: string
        nodeId: string
        toolName: string
        summary: string
        toolUseId: string
        createdAt: number
        sessionId: string
        cwd: string
        inputHash: string
        verdict?: PolicyVerdict
      }[]
    ) => void
  ) => () => void
  decideApproval: (id: string, allow: boolean) => Promise<{ ok: boolean; error?: string }>
  /** 抓终端当前屏尾部若干行（消息中心显示"它在问什么"） */
  peek: (id: string, lines?: number) => Promise<string>
  /** 就地把内容写进该终端 */
  reply: (id: string, text: string) => Promise<{ ok: boolean; error?: string }>
  onBrowserCmd: (
    cb: (req: {
      reqId: string
      nodeId: string
      action: string
      arg: string
      /** 发起这条指令的终端节点 id（open 时用来自动连线） */
      source: string
    }) => void | Promise<void>
  ) => () => void
  browserResult: (r: { reqId: string; ok: boolean; result: string }) => void
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => void
  /** 返回销毁前抓到的屏幕内容，撤回删除时回灌 */
  destroy: (id: string) => Promise<string>
  seedScrollback: (id: string, text: string) => Promise<boolean>
  onData: (id: string, cb: (data: string) => void) => () => void
  onExit: (id: string, cb: (code: number) => void) => () => void
  loadContext: (nodeId: string) => Promise<string>
  saveContext: (nodeId: string, text: string) => Promise<{ ok: boolean; error?: string }>
  loadWorkspace: () => Promise<unknown>
  saveWorkspace: (data: unknown) => Promise<{ ok: boolean; error?: string }>
  onAgentStatus: (
    cb: (e: { nodeId: string; agentId: string; state: string; newTurn: boolean; event?: string }) => void
  ) => () => void
  onAgentContext: (
    cb: (e: {
      nodeId: string
      usedTokens: number
      windowTokens: number
      usedPercent: number
      model: string
    }) => void
  ) => () => void
  onQuota: (
    cb: (q: {
      five_hour?: { used_percentage: number; resets_at: number }
      seven_day?: { used_percentage: number; resets_at: number }
      /** 快照时刻（unix 秒）。这份数据只在有 Claude 会话刷状态栏时更新，必须校验新鲜度 */
      _captured_at?: number
    }) => void
  ) => () => void
  ready: () => void
  workerAction: (
    action: 'result' | 'kill' | 'send' | 'clean',
    task: string,
    text?: string
  ) => Promise<{ ok: boolean; output: string }>
  onWorkers: (
    cb: (
      rows: {
        task: string
        backend: string
        model?: string
        state: string
        repo?: string
        age_s?: number
        question?: string | null
      }[]
    ) => void
  ) => () => void
  listPresets: () => Promise<Preset[]>
  upsertPreset: (input: Omit<Preset, 'id'> & { id?: string }) => Promise<Preset[]>
  deletePreset: (id: string) => Promise<Preset[]>
  listIdentities: () => Promise<IdentityMeta[]>
  upsertIdentity: (input: {
    id?: string
    name: string
    provider: IdentityMeta['provider']
    env: Record<string, string>
  }) => Promise<IdentityMeta[]>
  deleteIdentity: (id: string) => Promise<IdentityMeta[]>
  renameIdentity: (id: string, name: string) => Promise<IdentityMeta[]>
  /** 凭证登录态。只有 codex 能真查（codex login status），其余如实报 unknown */
  identityLoginStatus: (id: string) => Promise<{
    state: 'in' | 'out' | 'unknown'
    detail: string
    home?: string
  }>
}

declare interface Window {
  termscape: TermscapeApi
}
