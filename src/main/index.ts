import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import * as pty from 'node-pty'
import { homedir } from 'node:os'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRoot, inRoot, setRoot } from './project'
import { runVerify } from './agent/commands'
import { runAgent, SYSTEM_PROMPT, type AgentEvent, type Mode } from './agent/loop'
import type { Message } from './agent/provider'
import { ToolBox } from './agent/tools'
import { changesSince, createCheckpoint, initRepo, isRepo, undoTo, type Checkpoint } from './checkpoint'
import { clearKey, keyStatus, setKey, type KeyProvider } from './keys'
import { listModels, makeProvider } from './models'
import { getVerify, setVerify } from './settings'

const here = dirname(fileURLToPath(import.meta.url))

ipcMain.handle('project:current', () => getRoot())

ipcMain.handle('project:open', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (r.canceled) return null
  agent = null
  return setRoot(r.filePaths[0])
})

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

// One chat session per window: the conversation survives across prompts, like any chat app.
let agent: { messages: Message[]; tools: ToolBox } | null = null
let running: { ctl: AbortController; pending: Map<string, (ok: boolean) => void> } | null = null
const checkpoints = new Map<string, Checkpoint>() // runs that changed files, by id, until undone

ipcMain.handle('agent:send', async (e, p: { text: string; mode: Mode; model: string }) => {
  if (running) throw new Error('agent already running')
  const root = getRoot()
  if (!root) throw new Error('open a project folder first')
  const provider = makeProvider(p.model) // throws a readable error (e.g. missing key) before anything is recorded
  const verifyCmd = getVerify(root).effective
  if (p.mode === 'full-auto' && !verifyCmd) throw new Error('Full auto needs a verify command, because nothing else checks the model\'s work. Set one in Settings (gear icon).')

  const send = (ev: AgentEvent) => e.sender.send('agent:event', ev)
  const run = (running = { ctl: new AbortController(), pending: new Map() })
  try {
    // Undo needs git. Ask before creating a repo in someone's folder.
    if (!(await isRepo(root))) {
      const win = BrowserWindow.fromWebContents(e.sender)!
      const r = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['Initialize git', 'Continue without undo'], defaultId: 0, cancelId: 1,
        message: "This folder isn't a git repository.", detail: 'Forge uses git to snapshot your files before each agent run, so you can undo it. Initialize one here?',
      })
      if (r.response === 0) await initRepo(root)
    }
    let cp: Checkpoint | null = null
    if (await isRepo(root)) cp = await createCheckpoint(root)
    else send({ type: 'note', text: 'No git repository: this run cannot be undone.' })

    agent ??= { messages: [{ role: 'system', content: SYSTEM_PROMPT }], tools: new ToolBox() }
    agent.messages.push({ role: 'user', content: p.text })
    const a = agent
    runAgent({
      messages: a.messages,
      mode: p.mode,
      provider,
      tools: a.tools,
      emit: send,
      approve: (id) => new Promise((res) => run.pending.set(id, res)),
      signal: run.ctl.signal,
      verify: verifyCmd ? () => runVerify(verifyCmd, root, run.ctl.signal) : undefined,
    })
      .then(async () => {
        const files = cp ? await changesSince(root, cp) : []
        if (cp && files.length) {
          checkpoints.set(cp.id, cp)
          send({ type: 'changes', checkpoint: cp.id, files })
        }
      })
      .catch((err) => send({ type: 'error', message: (err as Error).message }))
      .finally(() => (running = null))
  } catch (err) {
    running = null
    throw err
  }
})

ipcMain.handle('agent:undo', async (_e, id: string) => {
  const root = getRoot()
  const cp = checkpoints.get(id)
  if (running || !root || !cp) throw new Error('nothing to undo')
  const touched = await undoTo(root, cp)
  checkpoints.delete(id)
  agent?.messages.push({ role: 'user', content: '[The user undid your last changes. Files are back to how they were before your edits. Re-read a file before editing it again.]' })
  return touched
})

ipcMain.handle('verify:get', () => (getRoot() ? getVerify(getRoot()!) : null))
ipcMain.handle('verify:set', (_e, cmd: string) => getRoot() && setVerify(getRoot()!, cmd))

ipcMain.on('agent:approve', (_e, id: string, ok: boolean) => {
  running?.pending.get(id)?.(ok)
  running?.pending.delete(id)
})

ipcMain.on('agent:stop', () => {
  if (!running) return
  running.ctl.abort()
  for (const res of running.pending.values()) res(false)
  running.pending.clear()
})

ipcMain.on('agent:new', () => {
  if (!running) agent = null
})

ipcMain.handle('agent:models', () => listModels())
ipcMain.handle('keys:status', () => keyStatus())
ipcMain.handle('keys:set', (_e, p: KeyProvider, key: string) => setKey(p, key))
ipcMain.handle('keys:clear', (_e, p: KeyProvider) => clearKey(p))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      contextIsolation: true,
      // ponytail: sandbox off because the ESM preload needs it; renderer only loads local files
      sandbox: false,
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(here, '../renderer/index.html'))
})

app.on('window-all-closed', () => app.quit())
