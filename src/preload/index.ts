import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, Mode } from '../main/agent/loop'

const api = {
  currentProject: (): Promise<string | null> => ipcRenderer.invoke('project:current'),
  openProject: (): Promise<string | null> => ipcRenderer.invoke('project:open'),
  list: (dir: string): Promise<{ name: string; dir: boolean }[]> => ipcRenderer.invoke('fs:list', dir),
  read: (file: string): Promise<string> => ipcRenderer.invoke('fs:read', file),
  write: (file: string, text: string): Promise<void> => ipcRenderer.invoke('fs:write', file, text),
  termSpawn: (cols: number, rows: number): Promise<void> => ipcRenderer.invoke('term:spawn', cols, rows),
  termWrite: (d: string) => ipcRenderer.send('term:write', d),
  termResize: (cols: number, rows: number) => ipcRenderer.send('term:resize', cols, rows),
  onTermData: (cb: (d: string) => void) => ipcRenderer.on('term:data', (_e, d: string) => cb(d)),
  agentSend: (p: { text: string; mode: Mode; model: string }): Promise<void> => ipcRenderer.invoke('agent:send', p),
  agentStop: () => ipcRenderer.send('agent:stop'),
  agentNew: () => ipcRenderer.send('agent:new'),
  agentApprove: (id: string, ok: boolean) => ipcRenderer.send('agent:approve', id, ok),
  agentModels: (): Promise<string[]> => ipcRenderer.invoke('agent:models'),
  onAgentEvent: (cb: (e: AgentEvent) => void) => ipcRenderer.on('agent:event', (_e, ev: AgentEvent) => cb(ev)),
}

contextBridge.exposeInMainWorld('forge', api)

export type ForgeApi = typeof api
export type { AgentEvent, Mode }
