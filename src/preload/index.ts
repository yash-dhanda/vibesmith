import { contextBridge, ipcRenderer } from 'electron'

const api = {
  currentProject: (): Promise<string | null> => ipcRenderer.invoke('project:current'),
  openProject: (): Promise<string | null> => ipcRenderer.invoke('project:open'),
  list: (dir: string): Promise<{ name: string; dir: boolean }[]> => ipcRenderer.invoke('fs:list', dir),
  read: (file: string): Promise<string> => ipcRenderer.invoke('fs:read', file),
  write: (file: string, text: string): Promise<void> => ipcRenderer.invoke('fs:write', file, text),
}

contextBridge.exposeInMainWorld('forge', api)

export type ForgeApi = typeof api
