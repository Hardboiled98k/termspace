import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

const api = {
  spawn: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty:spawn', id, cols, rows),
  write: (id: string, data: string): void => {
    ipcRenderer.send('pty:write', id, data)
  },
  resize: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:resize', id, cols, rows)
  },
  kill: (id: string): void => {
    ipcRenderer.send('pty:kill', id)
  },
  onData: (id: string, cb: (data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: string): void => cb(data)
    ipcRenderer.on(`pty:data:${id}`, listener)
    return () => ipcRenderer.removeListener(`pty:data:${id}`, listener)
  },
  onExit: (id: string, cb: (code: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, code: number): void => cb(code)
    ipcRenderer.on(`pty:exit:${id}`, listener)
    return () => ipcRenderer.removeListener(`pty:exit:${id}`, listener)
  },
  loadWorkspace: (): Promise<unknown> => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (data: unknown): Promise<void> => ipcRenderer.invoke('workspace:save', data)
}

contextBridge.exposeInMainWorld('termboard', api)

export type TermboardApi = typeof api
