import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import type * as PtyModule from 'node-pty'
import { homedir } from 'node:os'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRoot, inRoot, resolveIn, setRoot } from './project'
import { isPreviewable } from './preview'
import { PreviewServer } from './previewServer'
import { rewindChat } from './rewind'
import { isRemote } from './ollamaHost'
import { BriefStore, type BriefEdit } from './briefStore'
import { applyUserPlan, planFromTranscript, planNote, type PlanState } from './agent/plan'
import { runVerify } from './agent/commands'
import { runAgent, SYSTEM_PROMPT, type AgentEvent, type Mode } from './agent/loop'
import { ToolBox } from './agent/tools'
import { changesSince, createCheckpoint, diffOf, fileAt, hasGit, initRepo, isRepo, undoFile, undoTo, type Change, type Checkpoint } from './checkpoint'
import { summarizeChanges } from './agent/summarize'
import { ChatStore, compact, titleFrom, type Chat, type ChatListItem, type ChatStatus } from './chatStore'
import { clearKey, keyStatus, setKey, type KeyProvider } from './keys'
import { listModels, makeProvider, ollamaStatus } from './models'
import { getVerify, setVerify } from './settings'
import { registerLibrary } from './library'
import { UsageStore } from './usageStore'

const here = dirname(fileURLToPath(import.meta.url))

let win: BrowserWindow | null = null
let library: ReturnType<typeof registerLibrary> | null = null
let store: ChatStore
let usage: UsageStore

// ---- files and terminal: they follow the chat that is on screen ----
ipcMain.handle('fs:list', async (_e, dir: string) => {
  const entries = await readdir(inRoot(dir), { withFileTypes: true })
  return entries
    .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
    .map((d) => ({ name: d.name, dir: d.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
})
ipcMain.handle('fs:read', (_e, file: string) => readFile(inRoot(file), 'utf8'))
ipcMain.handle('fs:write', (_e, file: string, text: string) => writeFile(inRoot(file), text))

// One terminal per window. It runs in the project folder; the shell itself is the user's, not jailed.
// node-pty is a native module: it is loaded on demand, so a build where it is missing still runs (without a terminal).
let term: PtyModule.IPty | null = null
ipcMain.handle('term:spawn', async (e, cols: number, rows: number) => {
  term?.kill()
  let pty: typeof PtyModule
  try {
    pty = await import('node-pty')
  } catch {
    e.sender.send('term:data', '\r\nThe terminal is not available in this build.\r\n')
    return
  }
  const shell = process.platform === 'win32' ? process.env.COMSPEC || 'powershell.exe' : process.env.SHELL || 'bash'
  term = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd: getRoot() ?? homedir(), env: process.env as Record<string, string> })
  term.onData((d) => e.sender.send('term:data', d))
  term.onExit(() => e.sender.send('term:data', '\r\n[process exited]\r\n'))
})
ipcMain.on('term:write', (_e, d: string) => term?.write(d))
ipcMain.on('term:resize', (_e, cols: number, rows: number) => term?.resize(cols, rows))

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
const writeState = (patch: Partial<State>) => writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }))
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
  if (!s.dirty) return
  s.dirty = false
  store.save(s.chat)
}
// A crash or a power cut mid-run still leaves the transcript up to a couple of seconds ago.
function scheduleSave(s: Session) {
  s.dirty = true
  s.saveTimer ??= setTimeout(() => flush(s), 2000)
}

const previews = new Map<string, PreviewServer>()
function stopPreview(chatId: string) {
  previews.get(chatId)?.stop()
  previews.delete(chatId)
}

function emit(s: Session, ev: AgentEvent) {
  s.chat.transcript.push(ev)
  if (ev.type === 'tool_result' && ev.ok) previews.get(s.chat.id)?.reload()
  win?.webContents.send('agent:event', { chatId: s.chat.id, ev })
  if (ev.type === 'usage' && s.run) {
    usage.record(s.run.model, { input: ev.input, output: ev.output, genMs: ev.tps > 0 ? (ev.output / ev.tps) * 1000 : 0 })
    win?.webContents.send('usage:changed')
  }
  scheduleSave(s)
}

async function runtimeEvent(model: string, queueSeconds?: number): Promise<Extract<AgentEvent, { type: 'runtime' }>> {
  if (!model.startsWith('ollama:')) return { type: 'runtime', location: 'cloud', model, modelLoaded: true, ...(queueSeconds === undefined ? {} : { queueSeconds }) }
  const name = model.slice('ollama:'.length).replace(/:latest$/, '')
  const st = await ollamaStatus().catch(() => null)
  const m = st?.loaded.find((l) => l.name.replace(/:latest$/, '') === name)
  return { type: 'runtime', location: isRemote() ? 'remote' : 'local', model, modelLoaded: !!m, ...(m ? { gpuPercent: m.gpuPercent } : {}), ...(queueSeconds === undefined ? {} : { queueSeconds: Math.round(queueSeconds * 10) / 10 }) }
}

const withPreview = (files: Change[]) => files.map((f) => ({ ...f, previewable: f.status !== 'deleted' && isPreviewable(f.path) }))

// After a run, ask the model for one plain sentence per changed file. Slow or failing models just give none.
async function describeChanges(s: Session, provider: ReturnType<typeof makeProvider>, root: string, cp: Checkpoint, files: Change[]) {
  const list = files.slice(0, 12)
  if (!list.length) return
  const withExcerpt = await Promise.all(
    list.map(async (f) => ({ ...f, excerpt: f.status === 'added' ? ((await readFile(join(root, f.path), 'utf8').catch(() => '')) as string).split('\n').slice(0, 25).join('\n') : (await diffOf(root, cp, f.path)).split('\n').slice(0, 30).join('\n') })),
  )
  const items = await summarizeChanges(provider, withExcerpt, AbortSignal.timeout(45_000))
  if (Object.keys(items).length) emit(s, { type: 'summaries', checkpoint: cp.id, items, by: 'model' })
}

function notify(title: string, body: string, chatId: string) {
  if (!Notification.isSupported() || readState().notify === false) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    win?.show()
    win?.focus()
    win?.webContents.send('chats:focus', chatId)
  })
  n.show()
}
const unseen = (id: string) => !win || win.isDestroyed() || !win.isFocused() || viewing !== id

ipcMain.handle('app:init', () => {
  if (!getRoot()) {
    const p = lastProject()
    if (p) setRoot(p)
  }
  return { chats: list(), project: getRoot(), usage: usage.summary() }
})

ipcMain.handle('usage:summary', () => usage.summary())

ipcMain.handle('project:pick', async (_e, chatId: string) => {
  if (sessions.get(chatId)?.chat.transcript.length || store.load(chatId)?.transcript.length) throw new Error('This chat belongs to its project. Start a new chat to work in another folder.')
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (r.canceled) return getRoot()
  const root = setRoot(r.filePaths[0])
  rememberProject(root)
  return root
})

ipcMain.handle('chats:list', () => list())
ipcMain.on('chats:viewing', (_e, id: string | null) => (viewing = id))

ipcMain.handle('chats:open', (_e, id: string) => {
  const s = sessionFor(id)
  if (!s) throw new Error('that chat could not be loaded')
  const { chat } = s
  const missing = !!chat.project && !existsSync(chat.project)
  if (chat.project && !missing) setRoot(chat.project)
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

ipcMain.handle('chats:delete', (_e, id: string) => {
  stopPreview(id)
  if (sessions.get(id)?.run) throw new Error('Stop this chat first.')
  store.delete(id)
  sessions.delete(id)
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
// The project's name, description and priorities, in the user's words. Shared by every chat in that folder.
let briefs: BriefStore
ipcMain.handle('project:brief-get', (_e, chatId: string) => (briefs ??= new BriefStore(join(app.getPath('userData'), 'briefs.json'))).get(chatRoot(chatId)))
ipcMain.handle('project:brief-set', (_e, chatId: string, edit: BriefEdit) => {
  briefs ??= new BriefStore(join(app.getPath('userData'), 'briefs.json'))
  const root = chatRoot(chatId)
  const r = briefs.set(root, edit ?? {})
  if (!r.conflict) win?.webContents.send('project:brief-changed', { project: root, brief: r.brief })
  return { ...r.brief, conflict: r.conflict }
})
ipcMain.handle('open:folder', async (_e, chatId: string) => {
  const err = await shell.openPath(chatRoot(chatId))
  if (err) throw new Error(err)
})

// ---- the agent ----
ipcMain.handle('agent:send', async (e, p: { chatId: string; text: string; mode: Mode; model: string; numCtx?: number; maxSteps?: number; maxMinutes?: number }) => {
  let s = sessionFor(p.chatId)
  if (s?.run) throw new Error('This chat is still working. Wait for it, or press stop.')
  const root = s ? s.chat.project : getRoot()
  if (!root) throw new Error('Choose a folder to work in first.')
  if (!existsSync(root)) throw new Error(`The folder ${root} no longer exists.`)
  const provider = makeProvider(p.model, p.numCtx) // throws a readable error (e.g. missing key) before anything is recorded
  const verifyCmd = getVerify(root).effective
  if (p.mode === 'full-auto' && !verifyCmd) throw new Error("Full auto needs a verify command, because nothing else checks the model's work. Set one in Settings (gear icon).")

  // Undo needs git. An empty folder gets it silently (nothing of the user's to disturb). A folder with files asks once,
  // in plain words, and remembers a "no". A PC without git simply runs without undo.
  const git = await hasGit()
  if (git && !(await isRepo(root))) {
    if (readdirSync(root).length === 0) await initRepo(root)
    else if (!(readState().noUndo ?? []).includes(root)) {
      const r = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender)!, {
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
    chat.messages.push({ role: 'system', content: SYSTEM_PROMPT })
    s = { chat, tools: new ToolBox(root), run: null, dirty: false, saveTimer: null, plan: null, steer: [] }
    sessions.set(chat.id, s)
  }
  const session = s
  const { chat, tools } = session
  if (!chat.transcript.length) chat.title = titleFrom(p.text)
  chat.transcript.push({ type: 'user', text: p.text })
  chat.messages.push({ role: 'user', content: p.text })
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
  let cp: Checkpoint | null = null
  if (git && (await isRepo(root))) cp = await createCheckpoint(root)
  else emit(session, { type: 'note', text: git ? 'No git repository: this run cannot be undone.' : 'Git is not installed on this computer, so this run cannot be undone. Install git to get Undo.' })

  // Not awaited: the run carries on in the background and the screen follows it through events.
  runAgent({
    messages: chat.messages,
    mode: p.mode,
    provider,
    tools,
    emit: (ev) => {
      emit(session, ev)
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
    contextLimit: local ? numCtx : 150_000,
    verify: verifyCmd ? () => runVerify(verifyCmd, root, run.ctl.signal) : undefined,
    plan: planOf(session),
    takeSteering: () => (session.steer.length ? session.steer.splice(0).join('\n') : null),
  })
    .then(async () => {
      const files = cp ? await changesSince(root, cp) : []
      if (cp && files.length) {
        chat.checkpoints[cp.id] = cp
        emit(session, { type: 'changes', checkpoint: cp.id, files: withPreview(files) })
        void describeChanges(session, provider, root, cp, files)
      }
    })
    .catch((err) => emit(session, { type: 'error', message: (err as Error).message }))
    .finally(() => {
      session.run = null
      flush(session)
      changed()
      if (!run.stoppedByUser && unseen(chat.id)) notify('Forge finished', chat.title, chat.id)
    })
})

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
    s.plan = r.plan
    const note = planNote(cur, r.plan)
    if (note) s.steer.push(note)
    emit(s, { type: 'plan', revision: r.plan.revision, items: r.plan.items })
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
  const r = rewindChat(s.chat, Number(userIndex))
  if (!r) throw new Error('that message no longer exists')
  let files: string[] = []
  if (restoreFiles && r.restore && s.chat.project) files = await undoTo(s.chat.project, r.restore)
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

ipcMain.handle('verify:get', () => (getRoot() ? getVerify(getRoot()!) : null))
ipcMain.handle('verify:set', (_e, cmd: string) => getRoot() && setVerify(getRoot()!, cmd))

ipcMain.handle('agent:models', () => listModels())
ipcMain.handle('ollama:status', () => ollamaStatus())
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

// A second launch (a desktop shortcut clicked twice) focuses the running app instead of opening another.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (win?.isMinimized()) win.restore()
  win?.focus()
})

app.whenReady().then(() => {
  library = registerLibrary(() => win)
  library.ensureStarted()
  store = new ChatStore(join(app.getPath('userData'), 'chats'))
  usage = new UsageStore(app.getPath('userData'))
  win = new BrowserWindow({
    autoHideMenuBar: true, // no File/Edit/View bar: this is a chat app, not an editor
    title: 'Forge',
  icon: join(here, '../../build/icon.png'),
    width: 1280,
    height: 820,
    backgroundColor: '#18181b',
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      contextIsolation: true,
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

  let quitting = false
  win.on('close', (e) => {
    const busy = busyRuns()
    if (quitting || !busy.length) return
    e.preventDefault()
    dialog
      .showMessageBox(win!, {
        type: 'warning', buttons: ['Keep working', 'Quit anyway'], defaultId: 0, cancelId: 0,
        message: busy.length === 1 ? 'A chat is still working.' : `${busy.length} chats are still working.`,
        detail: 'Quitting stops them. Progress so far is saved.',
      })
      .then((r) => {
        if (r.response !== 1) return
        quitting = true
        for (const s of busy) s.run?.ctl.abort()
        saveAll()
        win?.close()
      })
  })
  win.on('closed', () => (win = null))

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(here, '../renderer/index.html'))
})

app.on('before-quit', () => {
  for (const id of [...previews.keys()]) stopPreview(id)
  saveAll()
  library?.stop()
})
app.on('window-all-closed', () => app.quit())
