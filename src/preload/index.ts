import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, Mode } from '../main/agent/loop'
import type { ChatListItem, ChatStatus, TranscriptItem } from '../main/chatStore'
import type { UsageSummary } from '../main/usageStore'

export type CatalogItem = { id: string; name: string; sizeGB: number; q: number; tags: string[]; blurb: string; fit: 'gpu' | 'partial' | 'cpu' | 'too-big'; best: boolean; installed: boolean }
export type InstalledModel = { name: string; sizeBytes: number; modified: string; params: string; quant: string; loaded: boolean }
export type PullEvent = { name: string; status: string; completed: number; total: number; percent: number; bytesPerSec: number; done: boolean; error?: string; cancelled?: boolean }
type KeyStatus = Record<'anthropic' | 'openai' | 'openrouter', boolean>
export type OpenedChat = { id: string; title: string; project: string | null; missing: boolean; status: ChatStatus; transcript: TranscriptItem[] }

const api = {
  // app + chats
  appInit: (): Promise<{ chats: ChatListItem[]; project: string | null; usage: UsageSummary }> => ipcRenderer.invoke('app:init'),
  pickProject: (chatId: string): Promise<string | null> => ipcRenderer.invoke('project:pick', chatId),
  chatsList: (): Promise<ChatListItem[]> => ipcRenderer.invoke('chats:list'),
  chatsViewing: (id: string | null) => ipcRenderer.send('chats:viewing', id),
  chatsOpen: (id: string): Promise<OpenedChat> => ipcRenderer.invoke('chats:open', id),
  chatsRename: (id: string, title: string): Promise<void> => ipcRenderer.invoke('chats:rename', id, title),
  chatsDelete: (id: string): Promise<void> => ipcRenderer.invoke('chats:delete', id),
  onChatsChanged: (cb: () => void) => ipcRenderer.on('chats:changed', () => cb()),
  onChatsFocus: (cb: (id: string) => void) => ipcRenderer.on('chats:focus', (_e, id: string) => cb(id)),
  // agent
  agentSend: (p: { chatId: string; text: string; mode: Mode; model: string; numCtx?: number; maxSteps?: number; maxMinutes?: number }): Promise<void> => ipcRenderer.invoke('agent:send', p),
  agentStop: (chatId: string) => ipcRenderer.send('agent:stop', chatId),
  agentApprove: (chatId: string, id: string, ok: boolean) => ipcRenderer.send('agent:approve', chatId, id, ok),
  agentUndo: (chatId: string, id: string): Promise<string[]> => ipcRenderer.invoke('agent:undo', chatId, id),
  agentUndoFile: (chatId: string, id: string, path: string): Promise<{ path: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number }[]> => ipcRenderer.invoke('agent:undo-file', chatId, id, path),
  onAgentEvent: (cb: (m: { chatId: string; ev: AgentEvent }) => void) => ipcRenderer.on('agent:event', (_e, m: { chatId: string; ev: AgentEvent }) => cb(m)),
  agentModels: (): Promise<{ id: string; label: string; group: string }[]> => ipcRenderer.invoke('agent:models'),
  // usage
  usageSummary: (): Promise<UsageSummary> => ipcRenderer.invoke('usage:summary'),
  onUsageChanged: (cb: () => void) => ipcRenderer.on('usage:changed', () => cb()),
  // settings
  keysStatus: (): Promise<KeyStatus> => ipcRenderer.invoke('keys:status'),
  keysSet: (p: string, key: string): Promise<void> => ipcRenderer.invoke('keys:set', p, key),
  keysClear: (p: string): Promise<void> => ipcRenderer.invoke('keys:clear', p),
  verifyGet: (): Promise<{ configured: string | null; detected: string | null; effective: string | null } | null> => ipcRenderer.invoke('verify:get'),
  verifySet: (cmd: string): Promise<void> => ipcRenderer.invoke('verify:set', cmd),
  // AI engine and model library
  engineStatus: (): Promise<{ state: 'ready-external' | 'ready-managed' | 'installed' | 'missing'; version?: string; installing: boolean; cpuOnly: boolean }> => ipcRenderer.invoke('engine:status'),
  engineInstall: (): Promise<void> => ipcRenderer.invoke('engine:install'),
  engineCancel: () => ipcRenderer.send('engine:cancel'),
  engineStart: (): Promise<void> => ipcRenderer.invoke('engine:start'),
  onEngineProgress: (cb: (p: { phase: string; done: number; total: number; bytesPerSec?: number }) => void) => ipcRenderer.on('engine:progress', (_e, p) => cb(p)),
  onEngineChanged: (cb: () => void) => ipcRenderer.on('engine:changed', () => cb()),
  systemInfo: (): Promise<{ ramGB: number; cpu: string; cores: number; gpu: { name: string; vramGB: number; freeGB: number } | null; diskFreeGB: number | null }> => ipcRenderer.invoke('system:info'),
  modelsCatalog: (): Promise<CatalogItem[]> => ipcRenderer.invoke('models:catalog'),
  modelsInstalled: (): Promise<InstalledModel[]> => ipcRenderer.invoke('models:installed'),
  modelsPull: (name: string): Promise<void> => ipcRenderer.invoke('models:pull', name),
  modelsCancel: (name: string) => ipcRenderer.send('models:cancel', name),
  modelsDelete: (name: string): Promise<void> => ipcRenderer.invoke('models:delete', name),
  modelsSearch: (q: string): Promise<{ id: string; pullName: string; downloads: number; likes: number }[]> => ipcRenderer.invoke('models:search', q),
  onModelsProgress: (cb: (p: PullEvent) => void) => ipcRenderer.on('models:progress', (_e, p: PullEvent) => cb(p)),
  onModelsChanged: (cb: () => void) => ipcRenderer.on('models:changed', () => cb()),
  // app
  ollamaStatus: (): Promise<{ up: boolean; models: string[]; loaded: { name: string; gpuPercent: number }[] }> => ipcRenderer.invoke('ollama:status'),
  appInfo: (): Promise<{ version: string; dataDir: string; electron: string; platform: string }> => ipcRenderer.invoke('app:info'),
  openDataDir: (): Promise<string> => ipcRenderer.invoke('app:open-data'),
  prefsGet: (): Promise<{ notify: boolean }> => ipcRenderer.invoke('prefs:get'),
  prefsSet: (key: 'notify', value: boolean): Promise<void> => ipcRenderer.invoke('prefs:set', key, value),
  // misc
  saveText: (name: string, text: string): Promise<boolean> => ipcRenderer.invoke('save:text', name, text),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
  openPath: (chatId: string, rel: string): Promise<void> => ipcRenderer.invoke('open:path', chatId, rel),
  openFolder: (chatId: string): Promise<void> => ipcRenderer.invoke('open:folder', chatId),
  // workspace (files, editor, terminal)
  list: (dir: string): Promise<{ name: string; dir: boolean }[]> => ipcRenderer.invoke('fs:list', dir),
  read: (file: string): Promise<string> => ipcRenderer.invoke('fs:read', file),
  write: (file: string, text: string): Promise<void> => ipcRenderer.invoke('fs:write', file, text),
  termSpawn: (cols: number, rows: number): Promise<void> => ipcRenderer.invoke('term:spawn', cols, rows),
  termWrite: (d: string) => ipcRenderer.send('term:write', d),
  termResize: (cols: number, rows: number) => ipcRenderer.send('term:resize', cols, rows),
  onTermData: (cb: (d: string) => void) => ipcRenderer.on('term:data', (_e, d: string) => cb(d)),
}

contextBridge.exposeInMainWorld('forge', api)

export type ForgeApi = typeof api
export type { AgentEvent, ChatListItem, ChatStatus, Mode, TranscriptItem, UsageSummary }
