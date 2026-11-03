import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import * as pty from 'node-pty'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRoot, inRoot, setRoot } from './project'
import { runVerify } from './agent/commands'
import { runAgent, SYSTEM_PROMPT, type AgentEvent, type Mode } from './agent/loop'
import { ToolBox } from './agent/tools'
import { changesSince, createCheckpoint, initRepo, isRepo, undoTo, type Checkpoint } from './checkpoint'
import { ChatStore, compact, titleFrom, type Chat, type ChatListItem, type ChatStatus } from './chatStore'
import { clearKey, keyStatus, setKey, type KeyProvider } from './keys'
import { listModels, makeProvider } from './models'
import { getVerify, setVerify } from './settings'
import { UsageStore } from './usageStore'

const here = dirname(fileURLToPath(import.meta.url))

let win: BrowserWindow | null = null
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
let term: pty.IPty | null = null
ipcMain.handle('term:spawn', (e, cols: number, rows: number) => {
  term?.kill()
  term = pty.spawn(process.env.SHELL || 'bash', [], { name: 'xterm-256color', cols, rows, cwd: getRoot() ?? homedir(), env: process.env as Record<string, string> })
  term.onData((d) => e.sender.send('term:data', d))
  term.onExit(() => e.sender.send('term:data', '\r\n[process exited]\r\n'))
})
ipcMain.on('term:write', (_e, d: string) => term?.write(d))
ipcMain.on('term:resize', (_e, cols: number, rows: number) => term?.resize(cols, rows))

// ---- remembered folder: a new chat starts in the project you were just using ----
const stateFile = () => join(app.getPath('userData'), 'state.json')
const lastProject = (): string | null => {
  try {
    const p = (JSON.parse(readFileSync(stateFile(), 'utf8')) as { lastProject?: string }).lastProject
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}
const rememberProject = (p: string) => writeFileSync(stateFile(), JSON.stringify({ lastProject: p }))

// ---- chat sessions: each chat has its own run, so work carries on in the background while you look at another chat ----
type Run = { ctl: AbortController; pending: Map<string, (ok: boolean) => void>; model: string; stoppedByUser: boolean }
type Session = { chat: Chat; tools: ToolBox; run: Run | null; dirty: boolean; saveTimer: NodeJS.Timeout | null }
const sessions = new Map<string, Session>()
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
  s = { chat, tools: new ToolBox(chat.project ?? '/nonexistent'), run: null, dirty: false, saveTimer: null }
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

function emit(s: Session, ev: AgentEvent) {
  s.chat.transcript.push(ev)
  win?.webContents.send('agent:event', { chatId: s.chat.id, ev })
  if (ev.type === 'usage' && s.run) {
    usage.record(s.run.model, { input: ev.input, output: ev.output, genMs: ev.tps > 0 ? (ev.output / ev.tps) * 1000 : 0 })
    win?.webContents.send('usage:changed')
  }
  scheduleSave(s)
}

function notify(title: string, body: string, chatId: string) {
  if (!Notification.isSupported()) return
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

// ---- the agent ----
ipcMain.handle('agent:send', async (e, p: { chatId: string; text: string; mode: Mode; model: string; numCtx?: number }) => {
  let s = sessionFor(p.chatId)
  if (s?.run) throw new Error('This chat is still working. Wait for it, or press stop.')
  const root = s ? s.chat.project : getRoot()
  if (!root) throw new Error('Choose a folder to work in first.')
  if (!existsSync(root)) throw new Error(`The folder ${root} no longer exists.`)
  const provider = makeProvider(p.model, p.numCtx) // throws a readable error (e.g. missing key) before anything is recorded
  const verifyCmd = getVerify(root).effective
  if (p.mode === 'full-auto' && !verifyCmd) throw new Error("Full auto needs a verify command, because nothing else checks the model's work. Set one in Settings (gear icon).")

  // Undo needs git. Ask before creating a repo in someone's folder.
  if (!(await isRepo(root))) {
    const r = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender)!, {
      type: 'question', buttons: ['Initialize git', 'Continue without undo'], defaultId: 0, cancelId: 1,
      message: "This folder isn't a git repository.", detail: 'Forge uses git to snapshot your files before each run, so you can undo it. Initialize one here?',
    })
    if (r.response === 0) await initRepo(root)
  }

  if (!s) {
    const chat = store.create(root, p.chatId)
    chat.messages.push({ role: 'system', content: SYSTEM_PROMPT })
    s = { chat, tools: new ToolBox(root), run: null, dirty: false, saveTimer: null }
    sessions.set(chat.id, s)
  }
  const session = s
  const { chat, tools } = session
  if (!chat.transcript.length) chat.title = titleFrom(p.text)
  chat.transcript.push({ type: 'user', text: p.text })
  chat.messages.push({ role: 'user', content: p.text })
  session.dirty = true
  flush(session)

  const run: Run = { ctl: new AbortController(), pending: new Map(), model: p.model, stoppedByUser: false }
  session.run = run
  changed()

  let cp: Checkpoint | null = null
  if (await isRepo(root)) cp = await createCheckpoint(root)
  else emit(session, { type: 'note', text: 'No git repository: this run cannot be undone.' })

  // Not awaited: the run carries on in the background and the screen follows it through events.
  runAgent({
    messages: chat.messages,
    mode: p.mode,
    provider,
    tools,
    emit: (ev) => emit(session, ev),
    approve: (id) =>
      new Promise((res) => {
        run.pending.set(id, res)
        changed()
        if (unseen(chat.id)) notify('Forge needs your approval', chat.title, chat.id)
      }),
    signal: run.ctl.signal,
    verify: verifyCmd ? () => runVerify(verifyCmd, root, run.ctl.signal) : undefined,
  })
    .then(async () => {
      const files = cp ? await changesSince(root, cp) : []
      if (cp && files.length) {
        chat.checkpoints[cp.id] = cp
        emit(session, { type: 'changes', checkpoint: cp.id, files })
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
  s.chat.messages.push({ role: 'user', content: '[The user undid your last changes. Files are back to how they were before your edits. Re-read a file before editing it again.]' })
  s.dirty = true
  flush(s)
  return touched
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
  store = new ChatStore(join(app.getPath('userData'), 'chats'))
  usage = new UsageStore(app.getPath('userData'))
  win = new BrowserWindow({
    autoHideMenuBar: true, // no File/Edit/View bar: this is a chat app, not an editor
    title: 'Forge',
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

app.on('before-quit', saveAll)
app.on('window-all-closed', () => app.quit())
