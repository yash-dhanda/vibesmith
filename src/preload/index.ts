import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, Mode } from '../main/agent/loop'
import type { ChatListItem, ChatStatus, TranscriptItem } from '../main/chatStore'
import type { UsageSummary } from '../main/usageStore'
import type { RunSummary, TeamMemory } from '../main/team/service'
import type { Run as TeamRun, RunEvent as TeamRunEvent, TeamConfig } from '../main/team/types'

export type CatalogItem = { id: string; name: string; sizeGB: number; q: number; tags: string[]; blurb: string; fit: 'gpu' | 'partial' | 'cpu' | 'too-big'; best: boolean; installed: boolean }
export type InstalledModel = { name: string; sizeBytes: number; modified: string; params: string; quant: string; loaded: boolean }
export type PullEvent = { name: string; status: string; completed: number; total: number; percent: number; bytesPerSec: number; done: boolean; error?: string; cancelled?: boolean }
type KeyStatus = Record<'anthropic' | 'openai' | 'openrouter', boolean>
export type ProjectBrief = { name: string; description: string; priorities: { id: string; text: string; included: boolean }[]; revision: number }
export type RunStatus = { state: 'stopped' | 'starting' | 'running' | 'exited'; command: string | null; port: number | null; url: string | null; exitCode: number | null; logs: string }
export type OpenedChat = { id: string; title: string; project: string | null; missing: boolean; status: ChatStatus; transcript: TranscriptItem[] }

const api = {
  // app + chats
  appInit: (): Promise<{ chats: ChatListItem[]; project: string | null; usage: UsageSummary }> => ipcRenderer.invoke('app:init'),
  pickProject: (chatId: string): Promise<string | null> => ipcRenderer.invoke('project:pick', chatId),
  chatsList: (): Promise<ChatListItem[]> => ipcRenderer.invoke('chats:list'),
  chatsViewing: (id: string | null) => ipcRenderer.send('chats:viewing', id),
  chatsOpen: (id: string): Promise<OpenedChat> => ipcRenderer.invoke('chats:open', id),
  chatsRename: (id: string, title: string): Promise<void> => ipcRenderer.invoke('chats:rename', id, title),
  chatsRewind: (id: string, userIndex: number, restoreFiles: boolean): Promise<{ text: string; files: string[]; transcript: TranscriptItem[] }> => ipcRenderer.invoke('chats:rewind', id, userIndex, restoreFiles),
  chatsPin: (id: string, pinned: boolean): Promise<void> => ipcRenderer.invoke('chats:pin', id, pinned),
  chatsSearch: (query: string): Promise<(ChatListItem & { snippets: { where: 'title' | 'user' | 'assistant'; text: string }[] })[]> => ipcRenderer.invoke('chats:search', query),
  chatsDelete: (id: string): Promise<void> => ipcRenderer.invoke('chats:delete', id),
  onChatsChanged: (cb: () => void) => ipcRenderer.on('chats:changed', () => cb()),
  onChatsFocus: (cb: (id: string) => void) => ipcRenderer.on('chats:focus', (_e, id: string) => cb(id)),
  // agent
  agentSend: (p: { chatId: string; text: string; attachments?: string[]; mode: Mode; model: string; numCtx?: number; maxSteps?: number; maxMinutes?: number }): Promise<void> => ipcRenderer.invoke('agent:send', p),
  attachmentsAdd: (chatId: string, files: { name: string; data: Uint8Array }[]): Promise<{ id: string; name: string; kind: 'image' | 'text'; size: number }[]> => ipcRenderer.invoke('attachments:add', chatId, files),
  attachmentsPreview: (chatId: string, id: string): Promise<string | null> => ipcRenderer.invoke('attachments:preview', chatId, id),
  agentStop: (chatId: string) => ipcRenderer.send('agent:stop', chatId),
  agentApprove: (chatId: string, id: string, ok: boolean) => ipcRenderer.send('agent:approve', chatId, id, ok),
  agentUndo: (chatId: string, id: string): Promise<string[]> => ipcRenderer.invoke('agent:undo', chatId, id),
  planUpdate: (chatId: string, p: { revision: number; items: { id?: string; text: string; status?: 'todo' | 'doing' | 'done'; skipped?: boolean }[] }): Promise<{ revision: number; items: { id: string; text: string; status: 'todo' | 'doing' | 'done'; skipped: boolean }[]; conflict: boolean }> => ipcRenderer.invoke('agent:plan-update', chatId, p),
  changeDetail: (chatId: string, checkpoint: string, path: string): Promise<{ before: string; after: string; existedBefore: boolean; existsNow: boolean; binary: boolean; truncated: boolean }> => ipcRenderer.invoke('agent:change-detail', chatId, checkpoint, path),
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
  engineStatus: (): Promise<{ state: 'ready-external' | 'ready-managed' | 'installed' | 'missing' | 'remote-down'; version?: string; installing: boolean; cpuOnly: boolean; remote: boolean; host: string }> => ipcRenderer.invoke('engine:status'),
  engineInstall: (): Promise<void> => ipcRenderer.invoke('engine:install'),
  engineHostGet: (): Promise<{ host: string; vramGB: number }> => ipcRenderer.invoke('engine:host-get'),
  engineHostTest: (host: string): Promise<{ ok: boolean; host: string; models: number }> => ipcRenderer.invoke('engine:host-test', host),
  engineHostSet: (host: string, vramGB?: number): Promise<void> => ipcRenderer.invoke('engine:host-set', host, vramGB),
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
  // team mode: Claude Code + Codex as one team (docs/TEAM.md)
  teamHealth: (): Promise<{ agents: { agent: 'claude' | 'codex'; ok: boolean; detail: string; fix?: string; version?: string }[]; codexModels: string[]; limits: { codex?: { primaryPct: number; primaryResetsAt?: number; secondaryPct?: number; secondaryResetsAt?: number; plan?: string } } }> => ipcRenderer.invoke('team:health'),
  teamStart: (goal: string, config?: Partial<TeamConfig>): Promise<RunSummary> => ipcRenderer.invoke('team:start', goal, config),
  teamList: (): Promise<RunSummary[]> => ipcRenderer.invoke('team:list'),
  teamGet: (id: string): Promise<TeamRun | null> => ipcRenderer.invoke('team:get', id),
  teamEvents: (id: string, limit?: number): Promise<{ t: number; ev: TeamRunEvent }[]> => ipcRenderer.invoke('team:events', id, limit),
  teamDiff: (id: string, taskId?: string): Promise<string> => ipcRenderer.invoke('team:diff', id, taskId),
  teamPause: (id: string, hard?: boolean): Promise<void> => ipcRenderer.invoke('team:pause', id, hard),
  teamResume: (id: string): Promise<void> => ipcRenderer.invoke('team:resume', id),
  teamCancel: (id: string): Promise<void> => ipcRenderer.invoke('team:cancel', id),
  teamAnswer: (id: string, approvalId: string, allow: boolean, note?: string): Promise<boolean> => ipcRenderer.invoke('team:answer', id, approvalId, allow, note),
  teamSteer: (id: string, text: string, to?: 'claude' | 'codex' | 'all'): Promise<void> => ipcRenderer.invoke('team:steer', id, text, to),
  teamRetryTask: (id: string, taskId: string): Promise<void> => ipcRenderer.invoke('team:retry-task', id, taskId),
  teamSkipTask: (id: string, taskId: string): Promise<void> => ipcRenderer.invoke('team:skip-task', id, taskId),
  teamExtendBudget: (id: string): Promise<void> => ipcRenderer.invoke('team:extend-budget', id),
  teamLiveDiff: (id: string, taskId: string, path?: string): Promise<string> => ipcRenderer.invoke('team:live-diff', id, taskId, path),
  teamMemory: (id: string): Promise<TeamMemory | null> => ipcRenderer.invoke('team:memory', id),
  teamUndo: (id: string): Promise<{ ok: boolean; paths: string[]; message: string }> => ipcRenderer.invoke('team:undo', id),
  teamDelete: (id: string): Promise<boolean> => ipcRenderer.invoke('team:delete', id),
  teamSettingsGet: (): Promise<Partial<TeamConfig>> => ipcRenderer.invoke('team:settings-get'),
  teamSettingsSet: (cfg: Partial<TeamConfig>): Promise<void> => ipcRenderer.invoke('team:settings-set', cfg),
  teamExportReport: (id: string): Promise<string | null> => ipcRenderer.invoke('team:export-report', id),
  teamApply: (id: string): Promise<{ ok: boolean; message: string; checkpoint?: string }> => ipcRenderer.invoke('team:apply', id),
  teamReject: (id: string): Promise<void> => ipcRenderer.invoke('team:reject', id),
  onTeamFocus: (cb: (runId: string) => void) => ipcRenderer.on('team:focus', (_e, runId: string) => cb(runId)),
  onTeamEvent: (cb: (ev: TeamRunEvent) => void) => ipcRenderer.on('team:event', (_e, ev: TeamRunEvent) => cb(ev)),
  updateCheck: (): Promise<{ available: boolean; version?: string; url?: string; notes?: string }> => ipcRenderer.invoke('update:check'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
  openPath: (chatId: string, rel: string): Promise<void> => ipcRenderer.invoke('open:path', chatId, rel),
  previewStart: (chatId: string): Promise<{ url: string }> => ipcRenderer.invoke('preview:start', chatId),
  previewAttach: (chatId: string, p: { bounds: { x: number; y: number; width: number; height: number }; source?: 'page' | 'run' }): Promise<{ url: string }> => ipcRenderer.invoke('preview:attach', chatId, p),
  previewBounds: (chatId: string, bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('preview:bounds', chatId, bounds),
  previewVisible: (chatId: string, visible: boolean) => ipcRenderer.send('preview:visible', chatId, visible),
  previewReload: (chatId: string) => ipcRenderer.send('preview:reload', chatId),
  previewDetach: (chatId: string) => ipcRenderer.send('preview:detach', chatId),
  onPreviewStatus: (cb: (s: { chatId: string; state: 'loading' | 'ready' | 'error' | 'closed'; url: string; title: string; error?: string }) => void) => ipcRenderer.on('preview:status', (_e, s) => cb(s)),
  previewStop: (chatId: string) => ipcRenderer.send('preview:stop', chatId),
  projectBriefGet: (chatId: string): Promise<ProjectBrief> => ipcRenderer.invoke('project:brief-get', chatId),
  projectBriefSet: (chatId: string, edit: { revision: number; name?: string; description?: string; priorities?: { id?: string; text: string; included?: boolean }[] }): Promise<ProjectBrief & { conflict: boolean }> => ipcRenderer.invoke('project:brief-set', chatId, edit),
  onProjectBriefChanged: (cb: (m: { project: string; brief: ProjectBrief }) => void) => ipcRenderer.on('project:brief-changed', (_e, m) => cb(m)),
  runDetect: (chatId: string): Promise<{ kind: 'static' | 'server' | 'none'; command: string | null; label: string }> => ipcRenderer.invoke('run:detect', chatId),
  runStatus: (chatId: string): Promise<RunStatus> => ipcRenderer.invoke('run:status', chatId),
  runStart: (chatId: string): Promise<Omit<RunStatus, 'logs'>> => ipcRenderer.invoke('run:start', chatId),
  runStop: (chatId: string) => ipcRenderer.send('run:stop', chatId),
  onRunLog: (cb: (m: { chatId: string; text: string }) => void) => ipcRenderer.on('run:log', (_e, m) => cb(m)),
  onRunState: (cb: (m: { chatId: string } & Omit<RunStatus, 'logs'>) => void) => ipcRenderer.on('run:state', (_e, m) => cb(m)),
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
