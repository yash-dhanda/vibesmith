import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import * as pty from 'node-pty'
import { homedir } from 'node:os'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRoot, inRoot, setRoot } from './project'
import { runAgent, SYSTEM_PROMPT, type Mode } from './agent/loop'
import { ollama, type Message } from './agent/provider'
import { ToolBox } from './agent/tools'

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

ipcMain.handle('agent:send', (e, p: { text: string; mode: Mode; model: string }) => {
  if (running) throw new Error('agent already running')
  if (!getRoot()) throw new Error('open a project folder first')
  agent ??= { messages: [{ role: 'system', content: SYSTEM_PROMPT }], tools: new ToolBox() }
  agent.messages.push({ role: 'user', content: p.text })
  const run = (running = { ctl: new AbortController(), pending: new Map() })
  runAgent({
    messages: agent.messages,
    mode: p.mode,
    provider: ollama({ model: p.model }),
    tools: agent.tools,
    emit: (ev) => e.sender.send('agent:event', ev),
    approve: (id) => new Promise((res) => run.pending.set(id, res)),
    signal: run.ctl.signal,
  }).finally(() => (running = null))
})

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

ipcMain.handle('agent:models', async () => {
  try {
    const j = (await (await fetch('http://127.0.0.1:11434/api/tags')).json()) as { models: { name: string }[] }
    return j.models.map((m) => m.name)
  } catch {
    return []
  }
})

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
