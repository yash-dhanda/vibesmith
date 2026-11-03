import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import * as pty from 'node-pty'
import { homedir } from 'node:os'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Every file op is confined to the opened project folder (path jail).
let root: string | null = process.env.FORGE_PROJECT ? realpathSync(process.env.FORGE_PROJECT) : null

function inRoot(p: string): string {
  if (!root) throw new Error('no project open')
  const abs = resolve(root, p)
  // realpath resolves symlinks so a link inside root cannot point outside it.
  // New files do not exist yet, so resolve the parent instead.
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    real = join(realpathSync(dirname(abs)), abs.slice(dirname(abs).length))
  }
  const rel = relative(root, real)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path outside project: ${p}`)
  return real
}

ipcMain.handle('project:current', () => root)

ipcMain.handle('project:open', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (r.canceled) return null
  root = realpathSync(r.filePaths[0])
  return root
})

ipcMain.handle('fs:list', async (_e, dir: string) => {
  const entries = await readdir(inRoot(dir), { withFileTypes: true })
  return entries
    .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
    .map((d) => ({ name: d.name, dir: d.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
})

// One terminal per window. It runs in the project folder; the shell itself is the user's, not jailed.
let term: pty.IPty | null = null

ipcMain.handle('term:spawn', (e, cols: number, rows: number) => {
  term?.kill()
  term = pty.spawn(process.env.SHELL || 'bash', [], { name: 'xterm-256color', cols, rows, cwd: root ?? homedir(), env: process.env as Record<string, string> })
  term.onData((d) => e.sender.send('term:data', d))
  term.onExit(() => e.sender.send('term:data', '\r\n[process exited]\r\n'))
})
ipcMain.on('term:write', (_e, d: string) => term?.write(d))
ipcMain.on('term:resize', (_e, cols: number, rows: number) => term?.resize(cols, rows))

ipcMain.handle('fs:read', (_e, file: string) => readFile(inRoot(file), 'utf8'))
ipcMain.handle('fs:write', (_e, file: string, text: string) => writeFile(inRoot(file), text))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
