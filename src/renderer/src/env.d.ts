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
}

declare interface Window {
  termboard: TermboardApi
}
