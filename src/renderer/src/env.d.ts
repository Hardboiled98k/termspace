/// <reference types="vite/client" />

interface AppSettings {
  defaultFontSize: number
  defaultShell: string
  tmuxEnabled: boolean
  scrollback: number
  skillDirs: string[]
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

interface TermboardApi {
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
  hooksStatus: () => Promise<{ installed: boolean; endpoint: string; settingsPath: string }>
  reapSessions: (knownIds: string[]) => Promise<number>
  listSkills: () => Promise<{ name: string; description: string; source: string }[]>
  reportAgents: (
    list: { id: string; title: string; provider?: string; status: string }[]
  ) => void
  onBrowserCmd: (
    cb: (req: {
      reqId: string
      nodeId: string
      action: string
      arg: string
    }) => void | Promise<void>
  ) => () => void
  browserResult: (r: { reqId: string; ok: boolean; result: string }) => void
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => void
  destroy: (id: string) => void
  onData: (id: string, cb: (data: string) => void) => () => void
  onExit: (id: string, cb: (code: number) => void) => () => void
  loadContext: (nodeId: string) => Promise<string>
  saveContext: (nodeId: string, text: string) => Promise<void>
  loadWorkspace: () => Promise<unknown>
  saveWorkspace: (data: unknown) => Promise<void>
  onAgentStatus: (
    cb: (e: { nodeId: string; agentId: string; state: string; newTurn: boolean }) => void
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
}

declare interface Window {
  termboard: TermboardApi
}
