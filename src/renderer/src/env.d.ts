/// <reference types="vite/client" />

interface TermboardApi {
  spawn: (id: string, cols: number, rows: number) => Promise<void>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => void
  onData: (id: string, cb: (data: string) => void) => () => void
  onExit: (id: string, cb: (code: number) => void) => () => void
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
}

declare interface Window {
  termboard: TermboardApi
}
