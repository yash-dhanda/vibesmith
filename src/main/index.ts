import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, shell, type IpcMainInvokeEvent } from 'electron'
import { makeKeepAwake, WORKING_STATUSES } from './keepAwake'
import type * as PtyModule from 'node-pty'
import { homedir } from 'node:os'
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkForUpdate, type UpdateInfo } from './updates'
import { PRICES_AS_OF, costOf, priceFor } from './pricing'
import { getRoot, resolveIn, setRoot } from './project'
import { isPreviewable } from './preview'
import { PreviewServer } from './previewServer'
import { PreviewViews, type Bounds } from './previewView'
import { detectRun, ProjectRunner } from './runner'
import { rewindChat } from './rewind'
import { isRemote } from './ollamaHost'
import { BriefStore, type BriefEdit } from './briefStore'
import { applyUserPlan, planFromTranscript, planNote, type PlanState } from './agent/plan'
import { runVerify } from './agent/commands'
import { contextWindowFor } from './agent/contextWindow'
import { runAgent, systemPromptFor, type AgentEvent, type Mode } from './agent/loop'
import { ToolBox } from './agent/tools'
import { changesSince, createCheckpoint, diffOf, fileAt, hasGit, initRepo, isRepo, SECRET_PATH, undoFile, undoTo, type Change, type Checkpoint } from './checkpoint'
import { summarizeChanges } from './agent/summarize'
import { ChatStore, compact, titleFrom, type Chat, type ChatListItem, type ChatStatus } from './chatStore'
import { clearKey, keyStatus, setKey, type KeyProvider } from './keys'
import { listModels, makeProvider, modelSupportsVision, ollamaStatus } from './models'
import { AttachmentStore, inlineText } from './attachments'
import { getVerify, setVerify } from './settings'
import { registerLibrary } from './library'
import { registerGitSearch } from './registerGitSearch'
import { registerProjectTools } from './registerProjectTools'
import { effectiveRules } from './projectRules'
import { registerProjectKnowledge } from './registerProjectKnowledge'
import { registerGithubTop } from './registerGithubTop'
import { rankProjects, scanProjects, type ProjectHit } from './projectScan'
import { SkillStore, type SkillRepo } from './skills'
import { CATEGORY_LABEL, SKILL_CATALOG, SKILL_PACKS } from './skillCatalog'
import { historyPath, readHistory } from './team/history'
import { isAgent } from './team/events'
import { RemoteServer, type Handler } from './remote'
import { PushNotifier, type PushKind } from './notify'
import { UsageStore } from './usageStore'
import { createTeamService, sanitizeConfig, type TeamService } from './team/service'
import { electronCapture, registerPreviewCrew } from './registerPreviewCrew'
import { registerQueue } from './registerQueue'
import { registerIdeas } from './registerIdeas'

const here = dirname(fileURLToPath(import.meta.url))

// Remote access needs to call the same handlers the window does, so every handler and listener registered below is also kept in a table.
const remoteHandlers = new Map<string, Handler>()
const remoteListeners = new Map<string, Handler[]>()
{
  const handle = ipcMain.handle.bind(ipcMain) as (c: string, fn: Handler) => void
  const on = ipcMain.on.bind(ipcMain) as (c: string, fn: Handler) => unknown
  ipcMain.handle = ((c: string, fn: Handler) => (remoteHandlers.set(c, fn), handle(c, fn))) as typeof ipcMain.handle
  ipcMain.on = ((c: string, fn: Handler) => (remoteListeners.set(c, [...(remoteListeners.get(c) ?? []), fn]), on(c, fn))) as typeof ipcMain.on
}
let remote: RemoteServer | null = null
const remoteSrv = () =>
  (remote ??= new RemoteServer({ dir: app.getPath('userData'), rendererDir: join(here, '../renderer'), preloadFile: join(here, '../preload/index.mjs'), handlers: remoteHandlers, listeners: remoteListeners }))

let win: BrowserWindow | null = null
let library: ReturnType<typeof registerLibrary> | null = null
let store: ChatStore
let usage: UsageStore

// The phone keeps its own folder: opening a chat on it must not move the one the computer's window is working in.
// Until the phone opens a chat it follows the computer's folder (read only: it never writes the computer's).
// One folder per paired device, keyed by the device id the remote server puts on the event (events without one share a slot).
const phoneRoots = new Map<string, string>()
const isPhone = (e: unknown) => !!(e as { remote?: boolean } | null)?.remote
const deviceOf = (e: unknown) => String((e as { device?: unknown } | null)?.device ?? 'phone')
const rootOf = (e: unknown) => (isPhone(e) ? (phoneRoots.get(deviceOf(e)) ?? getRoot()) : getRoot())
const setRootOf = (e: unknown, p: string) => (isPhone(e) ? (phoneRoots.set(deviceOf(e), realpathSync(p)), phoneRoots.get(deviceOf(e))!) : setRoot(p))
const inRootOf = (e: unknown, p: string) => resolveIn(rootOf(e) ?? (() => { throw new Error('no project open') })(), p)

// ---- files and terminal: they follow the chat that is on screen ----
ipcMain.handle('fs:list', async (e, dir: string) => {
  const entries = await readdir(inRootOf(e, dir), { withFileTypes: true })
  return entries
    .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
    .map((d) => ({ name: d.name, dir: d.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
})
ipcMain.handle('fs:read', (e, file: string) => readFile(inRootOf(e, file), 'utf8'))
ipcMain.handle('fs:write', (e, file: string, text: string) => writeFile(inRootOf(e, file), text))

// One terminal per window. It runs in the project folder; the shell itself is the user's, not jailed.
// node-pty is a native module: it is loaded on demand, so a build where it is missing still runs (without a terminal).
let term: PtyModule.IPty | null = null
const killTerm = () => {
  term?.kill()
  term = null
}
ipcMain.handle('term:spawn', async (e, cols: number, rows: number) => {
  killTerm() // the old shell's last output and exit notice must not reach the new terminal
  let pty: typeof PtyModule
  try {
    pty = await import('node-pty')
  } catch {
    e.sender.send('term:data', '\r\nThe terminal is not available in this build.\r\n')
    return
  }
  killTerm() // a second spawn can have finished while this one was loading node-pty: its shell would be orphaned
  const shell = process.platform === 'win32' ? process.env.COMSPEC || 'powershell.exe' : process.env.SHELL || 'bash'
  term = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd: rootOf(e) ?? homedir(), env: process.env as Record<string, string> })
  const t = term
  t.onData((d) => term === t && !e.sender.isDestroyed() && e.sender.send('term:data', d))
  t.onExit(() => {
    if (term !== t) return
    term = null // a dead pty throws on resize and write
    if (!e.sender.isDestroyed()) e.sender.send('term:data', '\r\n[process exited]\r\n')
  })
})
ipcMain.on('term:write', (_e, d: string) => { try { term?.write(d) } catch {} })
ipcMain.on('term:resize', (_e, cols: number, rows: number) => { try { term?.resize(cols, rows) } catch {} })

// ---- remembered folder: a new chat starts in the project you were just using ----
type State = { lastProject?: string; notify?: boolean; noUndo?: string[] }
const stateFile = () => join(app.getPath('userData'), 'state.json')
const readState = (): State => {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return {}
  }
}
// temp file + rename: a crash mid-write must not leave half a state file (a corrupt one reads as empty)
const writeState = (patch: Partial<State>) => {
  const f = stateFile()
  writeFileSync(f + '.tmp', JSON.stringify({ ...readState(), ...patch }))
  renameSync(f + '.tmp', f)
}
const lastProject = (): string | null => {
  const p = readState().lastProject
  return p && existsSync(p) ? p : null
}
const rememberProject = (p: string) => writeState({ lastProject: p })

// ---- chat sessions: each chat has its own run, so work carries on in the background while you look at another chat ----
type Run = { ctl: AbortController; pending: Map<string, (ok: boolean) => void>; model: string; stoppedByUser: boolean; startedAt: number; refreshed: boolean }
type Session = { chat: Chat; tools: ToolBox; run: Run | null; dirty: boolean; saveTimer: NodeJS.Timeout | null; plan: PlanState | null; steer: string[] }
const sessions = new Map<string, Session>()
const planOf = (s: Session): PlanState => (s.plan ??= planFromTranscript(s.chat.transcript))
let viewing: string | null = null // the chat on screen; the renderer tells us

const changed = () => win?.webContents.send('chats:changed')
const status = (id: string): ChatStatus => {
  const r = sessions.get(id)?.run
  return !r ? 'idle' : r.pending.size ? 'waiting' : 'running'
}
const list = (): ChatListItem[] => store.list().map((c) => ({ ...c, status: status(c.id) }))

function sessionFor(id: string): Session | null {
  let s = sessions.get(id)
  if (s) return s
  const chat = store.load(id)
  if (!chat) return null
  s = { chat, tools: new ToolBox(chat.project ?? '/nonexistent'), run: null, dirty: false, saveTimer: null, plan: null, steer: [] }
  sessions.set(id, s)
  return s
}

function flush(s: Session) {
  if (s.saveTimer) clearTimeout(s.saveTimer)
  s.saveTimer = null
  if (!s.dirty || sessions.get(s.chat.id) !== s) return // a deleted chat must not be written back by a late event
  try {
    store.save(s.chat)
    s.dirty = false // only once it is on disk
  } catch (err) {
    console.error('chat save failed', err) // disk full, or a file held by antivirus: stay dirty and try again shortly
    s.saveTimer = setTimeout(() => flush(s), 5000)
  }
}
// A crash or a power cut mid-run still leaves the transcript up to a couple of seconds ago.
function scheduleSave(s: Session) {
  s.dirty = true
  s.saveTimer ??= setTimeout(() => flush(s), 2000)
}

const views = new PreviewViews(() => win, (st) => win?.webContents.send('preview:status', st))
const runners = new Map<string, ProjectRunner>()
function stopRunner(chatId: string) {
  runners.get(chatId)?.stop()
  runners.delete(chatId)
}
const previews = new Map<string, PreviewServer>()
function stopPreview(chatId: string) {
  previews.get(chatId)?.stop()
  previews.delete(chatId)
}

// The ledger is bookkeeping: a failed write (full disk, a file another program holds open) must not stop a run or fail a Crew task.
function recordUsage(model: string, u: { input: number; output: number; genMs: number }) {
  try {
    usage.record(model, u)
    win?.webContents.send('usage:changed')
  } catch {}
}

function emit(s: Session, ev: AgentEvent) {
  s.chat.transcript.push(ev)
  if (ev.type === 'tool_result' && ev.ok) previews.get(s.chat.id)?.reload()
  win?.webContents.send('agent:event', { chatId: s.chat.id, ev })
  if (ev.type === 'usage' && s.run) recordUsage(s.run.model, { input: ev.input, output: ev.output, genMs: ev.tps > 0 ? (ev.output / ev.tps) * 1000 : 0 })
  scheduleSave(s)
}

async function runtimeEvent(model: string, queueSeconds?: number): Promise<Extract<AgentEvent, { type: 'runtime' }>> {
  if (!model.startsWith('ollama:')) {
    const price = priceFor(model)
    return { type: 'runtime', location: 'cloud', model, modelLoaded: true, ...(queueSeconds === undefined ? {} : { queueSeconds }), ...(price ? { price: { ...price, currency: 'USD' as const, asOf: PRICES_AS_OF } } : {}) }
  }
  const name = model.slice('ollama:'.length).replace(/:latest$/, '')
  const st = await ollamaStatus().catch(() => null)
  const m = st?.loaded.find((l) => l.name.replace(/:latest$/, '') === name)
  return { type: 'runtime', location: isRemote() ? 'remote' : 'local', model, modelLoaded: !!m, ...(m ? { gpuPercent: m.gpuPercent } : {}), ...(queueSeconds === undefined ? {} : { queueSeconds: Math.round(queueSeconds * 10) / 10 }) }
}

const withPreview = (files: Change[]) => files.map((f) => ({ ...f, previewable: f.status !== 'deleted' && isPreviewable(f.path) }))

// The first ~16 KB of a file: a new file can be huge, and 25 lines are all the summary uses.
async function head(file: string): Promise<string> {
  try {
    if (!(await lstat(file)).isFile()) return '' // a symlink could point at a file outside the project
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(16_384)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      return buf.subarray(0, bytesRead).includes(0) ? '' : buf.toString('utf8', 0, bytesRead) // binary: nothing to summarise
    } finally {
      await fh.close().catch(() => {})
    }
  } catch {
    return ''
  }
}

// After a run, ask the model for one plain sentence per changed file. Slow or failing models just give none.
async function describeChanges(s: Session, provider: ReturnType<typeof makeProvider>, model: string, root: string, cp: Checkpoint, files: Change[]) {
  const list = files.slice(0, 12)
  if (!list.length) return
  const withExcerpt = await Promise.all(
    list.map(async (f) => ({ ...f, excerpt: SECRET_PATH.test(f.path) ? '' : f.status === 'added' ? (await head(join(root, f.path))).split('\n').slice(0, 25).join('\n') : (await diffOf(root, cp, f.path)).split('\n').slice(0, 30).join('\n') })),
  )
  // This call costs tokens like any other: count it in the ledger.
  const counted: typeof provider = { chat: async (...a) => { const turn = await provider.chat(...a); if (turn.usage) recordUsage(model, turn.usage); return turn } }
  const items = await summarizeChanges(counted, withExcerpt, AbortSignal.timeout(45_000))
  if (Object.keys(items).length) emit(s, { type: 'summaries', checkpoint: cp.id, items, by: 'model' })
}

// A Notification nobody references can be garbage collected before it is clicked: hold it until it closes.
const shown = new Set<Notification>()
function hold(n: Notification) {
  shown.add(n)
  n.on('close', () => shown.delete(n))
  n.on('click', () => shown.delete(n))
}

// Phone notifications (ntfy): the same events as the desktop ones, only while the window is not in front. See notify.ts for what is sent.
let pushInst: PushNotifier | null = null
const push = () => (pushInst ??= new PushNotifier(app.getPath('userData')))
const away = () => !win || win.isDestroyed() || !win.isFocused()

function notify(title: string, body: string, chatId: string) {
  if (away()) void push().event(/approval/.test(title) ? 'chatQuestion' : 'chatDone')
  if (!Notification.isSupported() || readState().notify === false) return
  const n = new Notification({ title, body })
  hold(n)
  n.on('click', () => {
    if (win?.isMinimized()) win.restore()
    win?.show()
    win?.focus()
    win?.webContents.send('chats:focus', chatId)
  })
  n.show()
}
const unseen = (id: string) => !win || win.isDestroyed() || !win.isFocused() || viewing !== id

ipcMain.handle('app:init', (e) => {
  if (!rootOf(e)) {
    const p = lastProject()
    if (p) setRootOf(e, p)
  }
  return { chats: list(), project: rootOf(e), usage: usage.summary() }
})

ipcMain.handle('usage:summary', () => usage.summary())

ipcMain.handle('project:pick', async (e, chatId: string) => {
  if (sessions.get(chatId)?.chat.transcript.length || store.load(chatId)?.transcript.length) throw new Error('This chat belongs to its project. Start a new chat to work in another folder.')
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (r.canceled) return rootOf(e)
  const root = setRootOf(e, r.filePaths[0])
  rememberProject(root)
  return root
})

// The project's running history (what happened so far), kept in the project folder for the user and the agents.
// With a run id it is that run's project, otherwise the folder on screen.
const historyRoot = (e: unknown, runId: unknown) => {
  if (typeof runId !== 'string' || !runId) return rootOf(e)
  return teamSvc().orch.get(teamId(runId))?.project ?? rootOf(e)
}
ipcMain.handle('team:history', async (e, runId?: unknown) => {
  const root = historyRoot(e, runId)
  if (!root) return null
  return { path: historyPath(root), text: readHistory(root).slice(-300_000) } // readHistory never follows a link out of the project
})
ipcMain.handle('team:history-open', async (e, runId?: unknown) => {
  const root = historyRoot(e, runId)
  const path = root ? historyPath(root) : ''
  if (!path || !readHistory(root!)) throw new Error('Nothing has happened in this project yet.') // also true when the file or .forge is a link
  const err = await shell.openPath(path)
  if (err) throw new Error(err)
})

// Remote access: the Forge window served to a paired phone over Tailscale (or this computer only). Off until the user turns it on.
ipcMain.handle('remote:status', () => remoteSrv().status())
ipcMain.handle('remote:set', (_e, o: unknown) => remoteSrv().configure({ enabled: typeof (o as { enabled?: unknown })?.enabled === 'boolean' ? (o as { enabled: boolean }).enabled : undefined, lan: typeof (o as { lan?: unknown })?.lan === 'boolean' ? (o as { lan: boolean }).lan : undefined, https: typeof (o as { https?: unknown })?.https === 'boolean' ? (o as { https: boolean }).https : undefined }))
ipcMain.handle('remote:pair', async () => {
  if (!remoteSrv().status().listening) throw new Error('Turn on remote access first.')
  return remoteSrv().pairLink()
})
ipcMain.handle('remote:revoke', (_e, id: unknown) => remoteSrv().revoke(String(id ?? '')))

// Phone notifications through an ntfy server. The topic works like a password, so a paired phone cannot reach these (see BLOCKED in remote.ts).
ipcMain.handle('push:get', () => push().get())
ipcMain.handle('push:set', (_e, o: unknown) => {
  const v = (o ?? {}) as { enabled?: unknown; server?: unknown; includeProject?: unknown }
  return push().set({ enabled: typeof v.enabled === 'boolean' ? v.enabled : undefined, server: typeof v.server === 'string' ? v.server : undefined, includeProject: typeof v.includeProject === 'boolean' ? v.includeProject : undefined })
})
ipcMain.handle('push:test', () => push().test())
ipcMain.handle('push:new-topic', () => push().newTopic())

// Skill libraries: GitHub repositories the user adds; the agents of a team run read the skills that fit their task.
let skillStoreInst: SkillStore | null = null
const skillStore = () => (skillStoreInst ??= new SkillStore(join(app.getPath('userData'), 'skills')))
const skillId = (v: unknown) => String(v ?? '').slice(0, 200)
ipcMain.handle('skills:list', () => skillStore().list())
ipcMain.handle('skills:catalog', () => ({ entries: SKILL_CATALOG, packs: SKILL_PACKS, categories: CATEGORY_LABEL }))
ipcMain.handle('skills:add', (_e, url: unknown) => skillStore().add(String(url ?? '')))
ipcMain.handle('skills:update', (_e, id: unknown) => skillStore().update(skillId(id)))
ipcMain.handle('skills:toggle', (_e, id: unknown, enabled: unknown) => skillStore().setEnabled(skillId(id), enabled === true))
ipcMain.handle('skills:remove', (_e, id: unknown) => {
  if (!skillStore().list().some((r) => r.id === skillId(id))) throw new Error('That skill library is not in the list.') // an id that names the registry file itself must not wipe it
  return skillStore().remove(skillId(id))
})

// Folder finder for Team mode: scan the home folder for projects, match them to what the user typed, and open the one they click.
let scanCache: { at: number; hits: ProjectHit[] } | null = null
let scanning: Promise<ProjectHit[]> | null = null // one scan at a time: callers that arrive meanwhile wait for it
const scanned = async (fresh = false) => {
  if (!fresh && scanCache && Date.now() - scanCache.at < 120_000) return scanCache.hits
  return (scanning ??= scanProjects()
    .then((found) => {
      const hits = found.sort((a, b) => b.mtime - a.mtime)
      scanCache = { at: Date.now(), hits }
      return hits
    })
    .finally(() => (scanning = null)))
}
ipcMain.handle('project:scan', async (_e, fresh?: unknown) => (await scanned(fresh === true)).slice(0, 300))
ipcMain.handle('project:suggest', async (_e, query: unknown) => rankProjects(await scanned(), String(query ?? '').slice(0, 2000)))
ipcMain.handle('project:set', async (e, path: unknown) => {
  const p = String(path ?? '')
  if (!isAbsolute(p) || !(await stat(p).then((s) => s.isDirectory()).catch(() => false))) throw new Error('That folder is not available.')
  const root = setRootOf(e, p)
  rememberProject(root)
  return root
})

ipcMain.handle('chats:list', () => list())
ipcMain.on('chats:viewing', (_e, id: string | null) => (viewing = id))

ipcMain.handle('chats:open', (e, id: string) => {
  const s = sessionFor(id)
  if (!s) throw new Error('that chat could not be loaded')
  const { chat } = s
  const missing = !!chat.project && !existsSync(chat.project)
  if (chat.project && !missing) setRootOf(e, chat.project)
  viewing = id
  return { id, title: chat.title, project: chat.project, missing, status: status(id), transcript: compact(chat.transcript) }
})

ipcMain.handle('chats:rename', (_e, id: string, title: string) => {
  const s = sessionFor(id)
  if (!s) throw new Error('that chat could not be loaded')
  s.chat.title = titleFrom(title)
  s.dirty = true
  flush(s)
  changed()
})

ipcMain.handle('chats:pin', (_e, id: string, pinned: boolean) => {
  const s = sessionFor(id)
  if (!s) throw new Error('that chat could not be loaded')
  s.chat.pinned = !!pinned || undefined
  store.save(s.chat, false) // pinning is not activity: the chat keeps its place in time
  changed()
})
ipcMain.handle('chats:search', (_e, query: string) => store.search(String(query ?? '')).map((h) => ({ ...h, status: status(h.id) })))

ipcMain.handle('chats:delete', (_e, id: string) => {
  if (sessions.get(id)?.run) throw new Error('Stop this chat first.')
  views.detach(id)
  stopPreview(id)
  stopRunner(id)
  attachments().removeChat(id)
  store.delete(id)
  const s = sessions.get(id)
  if (s?.saveTimer) clearTimeout(s.saveTimer)
  sessions.delete(id) // flush ignores sessions that are no longer in the table, so a late summary cannot bring the chat back
})

ipcMain.handle('save:text', async (_e, name: string, text: string) => {
  const r = await dialog.showSaveDialog(win!, { defaultPath: name })
  if (r.canceled || !r.filePath) return false
  writeFileSync(r.filePath, text)
  return true
})

ipcMain.handle('open:external', (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url) // never file: or custom schemes
})

// Open something the agent built: a page in the browser, or the project folder. Always inside the chat's own folder.
const chatRoot = (chatId: string) => {
  const root = sessions.get(chatId)?.chat.project ?? store.load(chatId)?.project ?? getRoot()
  if (!root || !existsSync(root)) throw new Error('This chat has no folder to open.')
  return root
}
ipcMain.handle('open:path', async (_e, chatId: string, rel: string) => {
  if (!isPreviewable(rel)) throw new Error('Forge only opens pages, images and documents this way.')
  const abs = resolveIn(chatRoot(chatId), rel) // throws if the path leaves the folder
  if (!existsSync(abs)) throw new Error(`${rel} does not exist any more.`)
  const err = await shell.openPath(abs)
  if (err) throw new Error(err)
})
ipcMain.handle('preview:start', async (_e, chatId: string) => {
  let p = previews.get(chatId)
  if (!p) previews.set(chatId, (p = new PreviewServer(chatRoot(chatId))))
  try {
    return { url: await p.start() }
  } catch (e) {
    stopPreview(chatId)
    throw e
  }
})
ipcMain.on('preview:stop', (_e, chatId: string) => stopPreview(chatId))

// The preview inside the app: a sandboxed native view placed at `bounds` (the pane's rectangle in window coordinates, CSS pixels).
// source 'page' = the project's index.html (starts the live-reloading server), 'run' = the web server started with Run it.
ipcMain.handle('preview:attach', async (_e, chatId: string, p: { bounds: Bounds; source?: 'page' | 'run' }) => {
  let url: string
  if (p?.source === 'run') {
    url = runners.get(chatId)?.state.url ?? ''
    if (!url) throw new Error('Nothing is running yet. Press Run first.')
  } else {
    let pv = previews.get(chatId)
    if (!pv) previews.set(chatId, (pv = new PreviewServer(chatRoot(chatId))))
    try {
      url = await pv.start()
    } catch (e) {
      stopPreview(chatId)
      throw e
    }
  }
  views.attach(chatId, url, p.bounds)
  return { url }
})
ipcMain.on('preview:bounds', (_e, chatId: string, bounds: Bounds) => views.setBounds(chatId, bounds))
ipcMain.on('preview:visible', (_e, chatId: string, visible: boolean) => views.setVisible(chatId, !!visible))
ipcMain.on('preview:reload', (_e, chatId: string) => views.reload(chatId))
ipcMain.on('preview:detach', (_e, chatId: string) => views.detach(chatId))
// The project's name, description and priorities, in the user's words. Shared by every chat in that folder.
let briefs: BriefStore
const briefStore = () => (briefs ??= new BriefStore(join(app.getPath('userData'), 'briefs.json')))
ipcMain.handle('project:brief-get', (_e, chatId: string) => briefStore().get(chatRoot(chatId)))
ipcMain.handle('project:brief-set', (_e, chatId: string, edit: BriefEdit) => {
  const root = chatRoot(chatId)
  const r = briefStore().set(root, edit ?? {})
  if (!r.conflict) win?.webContents.send('project:brief-changed', { project: root, brief: r.brief })
  return { ...r.brief, conflict: r.conflict }
})
// "Run it": what can be started in this chat's project, and a managed process with live logs.
ipcMain.handle('run:detect', (_e, chatId: string) => detectRun(chatRoot(chatId)))
ipcMain.handle('run:status', (_e, chatId: string) => {
  const r = runners.get(chatId)
  return { ...(r?.state ?? { state: 'stopped', command: null, port: null, url: null, exitCode: null }), logs: r?.logs ?? '' }
})
ipcMain.handle('run:start', (_e, chatId: string) => {
  const root = chatRoot(chatId)
  const plan = detectRun(root)
  if (plan.kind !== 'server' || !plan.command) throw new Error(plan.kind === 'static' ? 'This project is a web page: use the preview.' : 'There is nothing to run yet. Ask Forge to build something first.')
  let r = runners.get(chatId)
  if (!r) {
    r = new ProjectRunner(root, (text) => win?.webContents.send('run:log', { chatId, text }), (state) => win?.webContents.send('run:state', { chatId, ...state }))
    runners.set(chatId, r)
  }
  r.start(plan.command)
  return r.state
})
ipcMain.on('run:stop', (_e, chatId: string) => runners.get(chatId)?.stop())
ipcMain.handle('open:folder', async (_e, chatId: string) => {
  const err = await shell.openPath(chatRoot(chatId))
  if (err) throw new Error(err)
})

// ---- attachments: pictures and text files on a message ----
let attStore: AttachmentStore
const attachments = () => (attStore ??= new AttachmentStore(join(app.getPath('userData'), 'attachments')))
ipcMain.handle('attachments:add', (_e, chatId: string, files: { name: string; data: Uint8Array }[]) =>
  attachments().add(chatId, Array.isArray(files) ? files : []).map(({ id, name, kind, size }) => ({ id, name, kind, size })),
)
// A small picture for the chip in the composer or the thread.
ipcMain.handle('attachments:preview', (_e, chatId: string, id: string) => {
  const a = attachments().find(chatId, id)
  return a?.kind === 'image' ? attachments().dataUrl(a) : null
})

// ---- the agent ----
// A send awaits several things (git, the undo question) before its run exists: a second send in that gap must not start another run.
const sending = new Set<string>()
type SendArgs = { chatId: string; text: string; attachments?: string[]; mode: Mode; model: string; numCtx?: number; maxSteps?: number; maxMinutes?: number; cloudContext?: number }
ipcMain.handle('agent:send', async (e, p: SendArgs) => {
  if (sending.has(p.chatId) || sessionFor(p.chatId)?.run) throw new Error('This chat is still working. Wait for it, or press stop.')
  sending.add(p.chatId)
  try {
    await send(e, p)
  } finally {
    sending.delete(p.chatId) // by now session.run (set inside send) guards the chat
  }
})
async function send(e: IpcMainInvokeEvent, p: SendArgs) {
  let s = sessionFor(p.chatId)
  const root = s ? s.chat.project : rootOf(e)
  if (!root) throw new Error('Choose a folder to work in first.')
  if (!existsSync(root)) throw new Error(`The folder ${root} no longer exists.`)
  // Attachments: text files go into the message, pictures go to the model as pictures (only if it can see).
  const atts = (Array.isArray(p.attachments) ? p.attachments : []).slice(0, 8).map((id) => attachments().find(p.chatId, id))
  if (atts.some((a) => !a)) throw new Error('An attached file is no longer available. Attach it again.')
  const found = atts as NonNullable<(typeof atts)[number]>[]
  if (found.some((a) => a.kind === 'image') && !(await modelSupportsVision(p.model))) throw new Error("This model can't look at pictures. Pick a model that can see (for example Qwen 3.5), or remove the picture.")
  const provider = makeProvider(p.model, p.numCtx) // throws a readable error (e.g. missing key) before anything is recorded
  const verifyCmd = getVerify(root).effective
  if (p.mode === 'full-auto' && !verifyCmd) throw new Error("Full auto needs a verify command, because nothing else checks the model's work. Set one in Settings (gear icon).")

  // Undo needs git. An empty folder gets it silently (nothing of the user's to disturb). A folder with files asks once,
  // in plain words, and remembers a "no". A PC without git simply runs without undo.
  const git = await hasGit()
  if (git && !(await isRepo(root))) {
    if (readdirSync(root).length === 0) await initRepo(root)
    else if (!(e as { remote?: boolean }).remote && !(readState().noUndo ?? []).includes(root)) { // a phone cannot answer a dialog on the computer: it runs without undo
      const r = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender) ?? win!, {
        type: 'question', buttons: ['Turn on undo', 'Not for this folder'], defaultId: 0, cancelId: 1,
        message: 'Turn on undo for this folder?',
        detail: 'Forge keeps a private snapshot of your files before each run so you can undo anything it changes. This adds a hidden .git folder here and does not touch your files.',
      })
      if (r.response === 0) await initRepo(root)
      else writeState({ noUndo: [...(readState().noUndo ?? []), root] })
    }
  }

  if (!s) {
    const chat = store.create(root, p.chatId)
    chat.messages.push({ role: 'system', content: systemPromptFor({ ...briefOf(root), skills: p.model.startsWith('ollama:') ? skillStore().inline() : '' }) })
    s = { chat, tools: new ToolBox(root), run: null, dirty: false, saveTimer: null, plan: null, steer: [] }
    sessions.set(chat.id, s)
  }
  const session = s
  const { chat, tools } = session
  // The project's description and rules can change between messages: the model always gets the current ones.
  if (chat.messages[0]?.role === 'system') chat.messages[0] = { role: 'system', content: systemPromptFor({ ...briefOf(root), skills: p.model.startsWith('ollama:') ? skillStore().inline() : '' }) }
  if (!chat.transcript.length) chat.title = titleFrom(p.text)
  const info = found.map(({ id, name, kind, size }) => ({ id, name, kind, size }))
  chat.transcript.push({ type: 'user', text: p.text, ...(info.length ? { attachments: info } : {}) })
  const images = found.filter((a) => a.kind === 'image').map((a) => ({ mime: a.mime, path: a.path }))
  const inlined = found.filter((a) => a.kind === 'text').map((a) => ((t) => inlineText(a.name, t.text, t.cut))(attachments().text(a))).join('')
  chat.messages.push({ role: 'user', content: p.text + inlined, ...(images.length ? { images } : {}) })
  session.dirty = true
  flush(session)

  // How much the model can remember decides how much of a file is read at once and when old output is shrunk.
  const local = p.model.startsWith('ollama:')
  const numCtx = Math.min(131_072, Math.max(2048, p.numCtx ?? 8192))
  tools.maxRead = local ? Math.min(20_000, Math.max(4000, numCtx)) : 20_000
  const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === 'number' && isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d)

  const run: Run = { ctl: new AbortController(), pending: new Map(), model: p.model, stoppedByUser: false, startedAt: Date.now(), refreshed: false }
  session.run = run
  changed()

  void runtimeEvent(p.model).then((r) => emit(session, r))
  let failed = false // the run ended in an error: no after-run summaries
  let cp: Checkpoint | null = null
  if (git && (await isRepo(root))) {
    try {
      cp = await createCheckpoint(root)
    } catch (err) {
      // An unreadable file or a nested repo without a commit makes the snapshot fail: the run goes on without undo instead of leaving the chat stuck.
      emit(session, { type: 'note', text: `Could not snapshot the files (${(err as Error).message.split('\n')[0]}), so this run cannot be undone.` })
    }
  } else emit(session, { type: 'note', text: git ? 'No git repository: this run cannot be undone.' : 'Git is not installed on this computer, so this run cannot be undone. Install git to get Undo.' })

  // Not awaited: the run carries on in the background and the screen follows it through events.
  runAgent({
    messages: chat.messages,
    mode: p.mode,
    provider,
    tools,
    emit: (ev) => {
      if (ev.type === 'error') failed = true
      const price = ev.type === 'usage' ? priceFor(p.model) : null
      emit(session, ev.type === 'usage' && price ? { ...ev, costUsd: costOf(price, ev.input, ev.output) } : ev)
      // After the first reply the model is loaded: say so, and how long the user waited for it to start.
      if (ev.type === 'usage' && !run.refreshed) {
        run.refreshed = true
        const waited = Math.max(0, (Date.now() - run.startedAt) / 1000 - (ev.tps > 0 ? ev.output / ev.tps : 0))
        void runtimeEvent(p.model, waited).then((r) => emit(session, r))
      }
    },
    approve: (id) =>
      new Promise((res) => {
        run.pending.set(id, res)
        changed()
        if (unseen(chat.id)) notify('Forge needs your approval', chat.title, chat.id)
      }),
    signal: run.ctl.signal,
    maxSteps: clamp(p.maxSteps, 5, 500, 50),
    maxMs: clamp(p.maxMinutes, 1, 240, 30) * 60_000,
    contextLimit: local ? numCtx : contextWindowFor(p.model, undefined, p.cloudContext), // the shrinker keeps its own headroom below this
    verify: verifyCmd ? () => runVerify(verifyCmd, root, run.ctl.signal) : undefined,
    plan: planOf(session),
    takeSteering: () => (session.steer.length ? session.steer.splice(0).join('\n') : null),
  })
    .then(async () => {
      const files = cp ? await changesSince(root, cp) : []
      if (cp && files.length) {
        chat.checkpoints[cp.id] = cp
        emit(session, { type: 'changes', checkpoint: cp.id, files: withPreview(files) })
        if (!run.stoppedByUser && !failed) void describeChanges(session, provider, p.model, root, cp, files)
      }
    })
    .catch((err) => emit(session, { type: 'error', message: (err as Error).message }))
    .finally(() => {
      session.run = null
      flush(session)
      changed()
      if (!run.stoppedByUser && unseen(chat.id)) notify('Forge finished', chat.title, chat.id)
    })
}

ipcMain.handle('agent:undo', async (_e, chatId: string, id: string) => {
  const s = sessions.get(chatId)
  const cp = s?.chat.checkpoints[id]
  if (!s || s.run || !cp || !s.chat.project) throw new Error('nothing to undo')
  const touched = await undoTo(s.chat.project, cp)
  delete s.chat.checkpoints[id]
  emit(s, { type: 'restored', checkpoint: id, paths: touched, remaining: [] })
  s.chat.messages.push({ role: 'user', content: '[The user undid your last changes. Files are back to how they were before your edits. Re-read a file before editing it again.]' })
  s.dirty = true
  flush(s)
  return touched
})

// The user steers the plan: reorder, rename, skip, add, remove. A stale revision is refused and the current plan returned.
ipcMain.handle('agent:plan-update', (_e, chatId: string, p: { revision: number; items: unknown }) => {
  const s = sessionFor(chatId)
  if (!s) throw new Error('that chat could not be loaded')
  const cur = planOf(s)
  const r = applyUserPlan(cur, Number(p?.revision), p?.items)
  if (r.changed) {
    const note = planNote(cur, r.plan)
    Object.assign(cur, r.plan) // the running agent holds this very object: replacing it would make its next update_plan drop the user's edit
    if (note) s.steer.push(note)
    emit(s, { type: 'plan', revision: cur.revision, items: cur.items })
  }
  return { revision: r.plan.revision, items: r.plan.items, conflict: r.conflict }
})

// Before and after of one changed file, for a visual comparison.
const DETAIL_MAX = 120_000
ipcMain.handle('agent:change-detail', async (_e, chatId: string, id: string, path: string) => {
  const s = sessionFor(chatId)
  const cp = s?.chat.checkpoints[id]
  if (!s || !cp || !s.chat.project || typeof path !== 'string') throw new Error('that change is no longer available')
  const root = s.chat.project
  const before = await fileAt(root, cp, path)
  const abs = resolveIn(root, path)
  const after = existsSync(abs) ? await readFile(abs, 'utf8') : null
  const binary = (before ?? '').includes('\0') || (after ?? '').includes('\0')
  const cut = (t: string | null) => (binary ? '' : (t ?? '').slice(0, DETAIL_MAX))
  return { before: cut(before), after: cut(after), existedBefore: before !== null, existsNow: after !== null, binary, truncated: !binary && ((before ?? '').length > DETAIL_MAX || (after ?? '').length > DETAIL_MAX) }
})

// "Edit and resend" / "Try again": take the chat back to just before the user's Nth message (0-based), optionally putting
// the files back too. The caller then sends the (edited) text with agentSend as usual.
ipcMain.handle('chats:rewind', async (_e, chatId: string, userIndex: number, restoreFiles: boolean) => {
  const s = sessionFor(chatId)
  if (!s) throw new Error('that chat could not be loaded')
  if (s.run) throw new Error('This chat is still working. Wait for it, or press stop.')
  const before = { transcript: s.chat.transcript, messages: s.chat.messages, checkpoints: { ...s.chat.checkpoints } }
  const r = rewindChat(s.chat, Number(userIndex))
  if (!r) throw new Error('that message no longer exists')
  let files: string[] = []
  if (restoreFiles && r.restore && s.chat.project) {
    try {
      files = await undoTo(s.chat.project, r.restore)
    } catch (err) {
      Object.assign(s.chat, before) // the files could not be put back: keep the chat and its way back as they were
      throw err
    }
  }
  s.plan = null
  s.steer = []
  s.chat.messages.push({ role: 'user', content: restoreFiles ? '[The user took the chat back and restored the files. Re-read a file before editing it.]' : '[The user took the chat back. Files may still hold changes from the earlier attempt: re-read a file before editing it.]' })
  s.dirty = true
  flush(s)
  changed()
  return { text: r.text, files, transcript: compact(s.chat.transcript) }
})

ipcMain.handle('agent:undo-file', async (_e, chatId: string, id: string, path: string) => {
  const s = sessions.get(chatId)
  const cp = s?.chat.checkpoints[id]
  if (!s || s.run || !cp || !s.chat.project || typeof path !== 'string') throw new Error('nothing to undo')
  const left = await undoFile(s.chat.project, cp, path)
  emit(s, { type: 'restored', checkpoint: id, paths: [path], remaining: withPreview(left) })
  s.chat.messages.push({ role: 'user', content: `[The user undid your changes to ${path}. That file is back to how it was before your edits. Re-read it before editing it again.]` })
  s.dirty = true
  flush(s)
  return withPreview(left)
})

ipcMain.on('agent:approve', (_e, chatId: string, id: string, ok: boolean) => {
  const r = sessions.get(chatId)?.run
  r?.pending.get(id)?.(ok)
  r?.pending.delete(id)
  changed()
})

ipcMain.on('agent:stop', (_e, chatId: string) => {
  const r = sessions.get(chatId)?.run
  if (!r) return
  r.stoppedByUser = true
  r.ctl.abort()
  for (const res of r.pending.values()) res(false)
  r.pending.clear()
})

ipcMain.handle('verify:get', (e) => { const root = rootOf(e); return root ? getVerify(root) : null })
ipcMain.handle('verify:set', (e, cmd: string) => { const root = rootOf(e); return root && setVerify(root, cmd) })

ipcMain.handle('agent:models', () => listModels())
ipcMain.handle('ollama:status', () => ollamaStatus())
let lastUpdate: UpdateInfo = { available: false }
ipcMain.handle('update:check', async () => (lastUpdate = await checkForUpdate(app.getVersion())))
ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataDir: app.getPath('userData'), electron: process.versions.electron, platform: process.platform }))
ipcMain.handle('app:open-data', () => shell.openPath(app.getPath('userData')))
ipcMain.handle('prefs:get', () => ({ notify: readState().notify !== false }))
ipcMain.handle('prefs:set', (_e, key: string, value: boolean) => {
  if (key === 'notify') writeState({ notify: !!value })
})
ipcMain.handle('keys:status', () => keyStatus())
ipcMain.handle('keys:set', (_e, p: KeyProvider, key: string) => setKey(p, key))
ipcMain.handle('keys:clear', (_e, p: KeyProvider) => clearKey(p))

// ---- window ----
function busyRuns() {
  return [...sessions.values()].filter((s) => s.run)
}
function saveAll() {
  for (const s of sessions.values()) flush(s)
}
// Quitting stops the running chats: ask first. Resolves true once the user has agreed and the runs are stopped.
let quitting = false
let asking: Promise<boolean> | null = null
function confirmQuit(): Promise<boolean> {
  const busy = busyRuns()
  return (asking ??= dialog
    .showMessageBox(win!, {
      type: 'warning', buttons: ['Keep working', 'Quit anyway'], defaultId: 0, cancelId: 0,
      message: busy.length === 1 ? 'A chat is still working.' : `${busy.length} chats are still working.`,
      detail: 'Quitting stops them. Progress so far is saved.',
    })
    .then((r) => {
      if (r.response !== 1) return false
      quitting = true
      for (const s of busy) s.run?.ctl.abort()
      saveAll()
      return true
    })
    .finally(() => (asking = null)))
}

// A second launch (a desktop shortcut clicked twice) focuses the running app instead of opening another.
// app.quit() would let the rest of start-up run in this second process (recovering the first one's runs, binding its port): exit at once.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.exit(0)
app.on('second-instance', () => {
  if (win?.isMinimized()) win.restore()
  win?.focus()
})

// ---- team mode: Claude Code and Codex working as one team, each on its own git branch (see docs/TEAM.md) ----
// never lets a failure to block sleep stop a run
const keepAwake = makeKeepAwake({ start: (t) => { try { return powerSaveBlocker.start(t) } catch { return -1 } }, stop: (id) => { try { if (id >= 0) powerSaveBlocker.stop(id) } catch {} } })
let team: TeamService | null = null
// A long team run goes on while the user is elsewhere: say so when it needs them or ends. Same switch as the chat notifications.
function teamNotify(ev: import('./team/types').RunEvent) {
  if (!win || win.isDestroyed() || win.isFocused()) return
  let title = '', body = '', kind: PushKind = 'attention'
  if (ev.type === 'approval' && ev.approval.status === 'pending' && ev.approval.kind !== 'final') (title = 'Your team needs an answer'), (body = ev.approval.title), (kind = 'question')
  else if (ev.type === 'run' && ev.status === 'awaiting_approval') (title = 'Your team is done'), (body = 'Review the result and apply it.'), (kind = 'finished')
  else if (ev.type === 'run' && ev.status === 'failed') (title = 'Your team run failed'), (body = ev.reason ?? '')
  else if (ev.type === 'run' && ev.status === 'paused' && ev.reason && !/Paused by you/.test(ev.reason)) (title = 'Your team stopped'), (body = ev.reason)
  if (!title) return
  void push().event(kind, team?.orch.get(ev.runId)?.project) // generic text only; the title and body above are for this computer
  if (!Notification.isSupported() || readState().notify === false) return
  const n = new Notification({ title, body: body.slice(0, 200) })
  hold(n)
  n.on('click', () => {
    if (win?.isMinimized()) win.restore()
    win?.show()
    win?.focus()
    win?.webContents.send('team:focus', ev.runId)
  })
  n.show()
}
const teamSvc = (): TeamService =>
  (team ??= createTeamService({
    userData: app.getPath('userData'),
    mcpScript: join(here, 'team-mcp.js').replace('app.asar' + (process.platform === 'win32' ? '\\' : '/'), 'app.asar.unpacked' + (process.platform === 'win32' ? '\\' : '/')),
    recordUsage: (agent, u) => recordUsage(`crew:${agent}`, { input: u.input, output: u.output, genMs: 0 }),
    visualCapture: electronCapture,
    notify: (kind) => void push().event(kind),
    emit: (ev) => {
      if (ev.type === 'run') keepAwake.set(ev.runId, WORKING_STATUSES.includes(ev.status))
      win?.webContents.send('team:event', ev)
      teamNotify(ev)
    },
    skills: () => skillStore().catalog(),
    localSkills: () => skillStore().inline(),
    projectNotes: (p) => {
      const b = briefOf(p)
      return { brief: [b.name, b.description].filter(Boolean).join(': '), rules: b.rules }
    },
  }))
// The project's rules: the editable .forge/rules.md when there is one, else the brief's older rules field. Solo and Crew read the same.
const briefOf = (root: string) => { const b = briefStore().get(root); return { ...b, rules: effectiveRules(root, b.rules) } }
const teamId = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[\w-]{1,60}$/.test(v)) throw new Error('bad id')
  return v
}
ipcMain.handle('team:health', () => teamSvc().health())
ipcMain.handle('team:attach', (_e, files: unknown) => teamSvc().attach(Array.isArray(files) ? (files as { name: string; data: string }[]) : []))
ipcMain.handle('team:attach-part', (_e, part: unknown) => teamSvc().attachPart(part as import('./team/attach').AttachPart))
ipcMain.handle('team:start', (e, goal: unknown, config: unknown) => {
  const root = rootOf(e)
  if (!root) throw new Error('Choose a folder to work in first.')
  return teamSvc().start(root, String(goal ?? ''), sanitizeConfig(config), (config as { attachments?: unknown } | null)?.attachments)
})
ipcMain.handle('team:list', () => teamSvc().list())
ipcMain.handle('team:get', (_e, id: unknown) => teamSvc().orch.get(teamId(id)))
ipcMain.handle('team:events', (_e, id: unknown, limit?: unknown) => teamSvc().orch.events(teamId(id), typeof limit === 'number' ? Math.min(5000, Math.max(1, limit)) : 2000))
ipcMain.handle('team:diff', (_e, id: unknown, taskId?: unknown) => teamSvc().orch.diffFor(teamId(id), typeof taskId === 'string' ? teamId(taskId) : undefined))
ipcMain.handle('team:pause', (_e, id: unknown, hard?: unknown) => teamSvc().orch.pause(teamId(id), hard === true))
ipcMain.handle('team:resume', (_e, id: unknown) => teamSvc().orch.resume(teamId(id)))
ipcMain.handle('team:cancel', (_e, id: unknown) => teamSvc().orch.cancel(teamId(id)))
ipcMain.handle('team:answer', (_e, id: unknown, approvalId: unknown, allow: unknown, note?: unknown) => teamSvc().orch.answerApproval(teamId(id), teamId(approvalId), allow === true, typeof note === 'string' ? note.slice(0, 500) : undefined))
ipcMain.handle('team:run-app', (_e, id: unknown) => teamSvc().runApp(teamId(id)))
ipcMain.handle('team:stop-app', (_e, id: unknown) => teamSvc().stopApp(teamId(id)))
ipcMain.handle('team:follow', (_e, id: unknown, text: unknown, to?: unknown, attachments?: unknown) => teamSvc().followUp(teamId(id), String(text ?? ''), isAgent(to) ? to : 'all', attachments))
ipcMain.handle('team:steer', (_e, id: unknown, text: unknown, to?: unknown) => teamSvc().orch.steer(teamId(id), String(text ?? ''), isAgent(to) ? to : 'all'))
ipcMain.handle('team:retry-task', (_e, id: unknown, taskId: unknown) => teamSvc().orch.retryTask(teamId(id), teamId(taskId)))
ipcMain.handle('team:stop-task', (_e, id: unknown, taskId: unknown) => teamSvc().orch.stopTask(teamId(id), teamId(taskId)))
ipcMain.handle('team:skip-task', (_e, id: unknown, taskId: unknown) => teamSvc().orch.skipTask(teamId(id), teamId(taskId)))
ipcMain.handle('team:set-models', (_e, id: unknown, m: unknown) => {
  const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return teamSvc().orch.setModels(teamId(id), { claudeModel: str(o.claudeModel), codexModel: str(o.codexModel), geminiModel: str(o.geminiModel), localModel: str(o.localModel), claudeEffort: str(o.claudeEffort), codexEffort: str(o.codexEffort), bypassPermissions: typeof o.bypassPermissions === 'boolean' ? o.bypassPermissions : undefined })
})
ipcMain.handle('team:set-speed', (_e, id: unknown, fast: unknown) => teamSvc().orch.setSpeed(teamId(id), fast === true))
ipcMain.handle('team:extend-budget', (_e, id: unknown) => teamSvc().orch.extendBudget(teamId(id)))
ipcMain.handle('team:live-diff', (_e, id: unknown, taskId: unknown, path?: unknown) => teamSvc().orch.liveDiff(teamId(id), teamId(taskId), typeof path === 'string' ? path.slice(0, 500) : undefined))
ipcMain.handle('team:memory', (_e, id: unknown) => teamSvc().orch.memorySnapshot(teamId(id)))
ipcMain.handle('team:update-plan', (_e, id: unknown, edits: unknown) => {
  const list = (Array.isArray(edits) ? edits : []).slice(0, 30).map((x) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    return { id: teamId(o.id), title: typeof o.title === 'string' ? o.title : undefined, goal: typeof o.goal === 'string' ? o.goal : undefined, agent: isAgent(o.agent) ? o.agent : undefined, acceptance: Array.isArray(o.acceptance) ? o.acceptance.map(String) : undefined, deps: Array.isArray(o.deps) ? o.deps.map(String) : undefined, skip: typeof o.skip === 'boolean' ? o.skip : undefined } as const
  })
  return teamSvc().orch.updatePlan(teamId(id), list as never)
})
ipcMain.handle('team:diagnostics', () => teamSvc().diagnostics())
ipcMain.handle('team:undo', (_e, id: unknown) => teamSvc().orch.undoApply(teamId(id)))
ipcMain.handle('team:delete', (_e, id: unknown) => teamSvc().orch.deleteRun(teamId(id)))
ipcMain.handle('team:settings-get', (e) => {
  const root = rootOf(e)
  return root ? teamSvc().settings.get(root) : {}
})
ipcMain.handle('team:settings-set', (e, cfg: unknown) => {
  const root = rootOf(e)
  if (root) teamSvc().settings.set(root, cfg)
})
ipcMain.handle('team:export-report', async (e, id: unknown) => {
  const run = teamSvc().orch.get(teamId(id))
  if (!run?.final) throw new Error('This run has no report yet.')
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender) ?? win!, { defaultPath: join(run.project, 'TEAM-REPORT.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] })
  if (r.canceled || !r.filePath) return null
  writeFileSync(r.filePath, run.final.report)
  return r.filePath
})
ipcMain.handle('team:apply', (_e, id: unknown, withoutUndo?: unknown) => teamSvc().orch.approveFinal(teamId(id), withoutUndo === true))
ipcMain.handle('team:reject', (_e, id: unknown) => teamSvc().orch.rejectFinal(teamId(id)))
registerQueue({ team: teamSvc, rootOf })
registerGitSearch({ neverPush: (p) => !!teamSvc().settings.get(p).neverPush, getRun: (id) => teamSvc().orch.get(id) ?? null, listRuns: () => teamSvc().list(), listChats: () => store.list(), loadChat: (id) => store.load(id) })
registerProjectTools({ getRun: (id) => teamSvc().orch.get(id) ?? null, listRuns: () => teamSvc().list(), listChats: () => store.list(), loadChat: (id) => store.load(id), scanned: () => scanCache?.hits ?? [], busy: (p) => [...sessions.values()].some((s) => s.run && s.chat.project === p) })
registerProjectKnowledge({ rootOf, userData: app.getPath('userData'), briefRules: (p) => briefStore().get(p).rules, getRun: (id) => teamSvc().orch.get(id) ?? null, stats: (id) => teamSvc().stats(id) })
registerIdeas({ rootOf })
registerGithubTop({ rootOf, userData: app.getPath('userData') })

app.whenReady().then(() => {
  if (!gotLock) return
  library = registerLibrary(() => win)
  registerPreviewCrew({ getWin: () => win, views, runApp: (id) => teamSvc().runApp(id), shotsDir: (id) => join(app.getPath('userData'), 'visual', id) })
  teamSvc() // also recovers runs that were interrupted by the last shutdown
  library.ensureStarted()
  store = new ChatStore(join(app.getPath('userData'), 'chats'))
  usage = new UsageStore(app.getPath('userData'))
  win = new BrowserWindow({
    autoHideMenuBar: true, // no File/Edit/View bar: this is a chat app, not an editor
    title: 'Forge',
  icon: join(here, '../../build/icon.png'),
    width: 1280,
    height: 820,
    backgroundColor: '#141414',
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      contextIsolation: true,
      zoomFactor: 1.07, // comfortable density for all-day use (UI 13px reads as 14px); Ctrl 0 / Ctrl - / Ctrl + still change it
      // ponytail: sandbox off because the ESM preload needs it; renderer only loads local files
      sandbox: false,
    },
  })
  // A link in a reply must open in the browser, never replace the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win!.webContents.getURL()) e.preventDefault()
  })

  win.on('close', (e) => {
    if (quitting || !busyRuns().length) return
    e.preventDefault()
    void confirmQuit().then((yes) => yes && win?.close())
  })
  win.on('closed', () => (win = null))
  // Whatever the app tells its window is also told to the paired phones; and the remote server comes up if the user turned it on.
  {
    const wc = win.webContents
    const send = wc.send.bind(wc)
    wc.send = ((channel: string, ...args: unknown[]) => (remoteSrv().broadcast(channel, args), send(channel, ...args))) as typeof wc.send
    void remoteSrv().configure({}).catch(() => {})
  }

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(here, '../renderer/index.html'))
})

app.on('before-quit', (e) => {
  // Ask before anything is torn down: "Keep working" must leave the app as it was (previews, engine, Crew runs).
  if (!quitting && busyRuns().length) {
    e.preventDefault()
    void confirmQuit().then((yes) => yes && app.quit())
    return
  }
  team?.orch.shutdown()
  team?.stopApps()
  views.detachAll()
  for (const id of [...runners.keys()]) stopRunner(id)
  for (const id of [...previews.keys()]) stopPreview(id)
  killTerm()
  saveAll()
  library?.stop()
})
app.on('window-all-closed', () => app.quit())
