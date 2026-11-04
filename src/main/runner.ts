import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blocked, killTree } from './agent/commands'

// "Run it": start the project the agent built (a dev server, a script) as a managed process with live logs, so a
// non-programmer never opens a terminal. The command is detected from the project; the user presses Run.

export type RunPlan = { kind: 'static' | 'server' | 'none'; command: string | null; label: string }

const win = process.platform === 'win32'

export function detectRun(root: string): RunPlan {
  const has = (f: string) => existsSync(join(root, f))
  let pkg: { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object; main?: string } | null = null
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {}
  if (pkg) {
    const script = pkg.scripts?.dev ? 'npm run dev' : pkg.scripts?.start ? 'npm start' : null
    const needsInstall = !has('node_modules') && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0
    if (script) return { kind: 'server', command: needsInstall ? `npm install && ${script}` : script, label: needsInstall ? `Install packages, then start (${script})` : `Start the app (${script})` }
  }
  for (const f of ['app.py', 'main.py', 'server.py']) if (has(f)) return { kind: 'server', command: `${win ? 'python' : 'python3'} ${f}`, label: `Run ${f}` }
  if (has('index.html')) return { kind: 'static', command: null, label: 'Open the page' }
  for (const f of [pkg?.main, 'server.js', 'index.js', 'app.js'])
    if (f && /^[\w./-]+\.js$/.test(f) && has(f)) return { kind: 'server', command: `node ${f}`, label: `Run ${f}` }
  return { kind: 'none', command: null, label: 'Nothing to run yet' }
}

export function findPort(text: string): number | null {
  // "Port 5173 is in use, trying another one" / EADDRINUSE name a port the server did NOT get: the real address comes on a later line.
  text = text.replace(/.*(?:\bin use\b|EADDRINUSE).*/gi, '')
  const m =/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/i.exec(text) ?? /\bport[ :]+(\d{2,5})\b/i.exec(text)
  const n = m ? Number(m[1]) : 0
  return n >= 80 && n <= 65535 ? n : null
}

export type RunState = { state: 'stopped' | 'starting' | 'running' | 'exited'; command: string | null; port: number | null; url: string | null; exitCode: number | null }
const MAX_LOG = 40_000

export class ProjectRunner {
  private child: ChildProcess | null = null
  private log = ''
  private s: RunState = { state: 'stopped', command: null, port: null, url: null, exitCode: null }

  constructor(private root: string, private onLog: (text: string) => void, private onState: (s: RunState) => void) {}

  get state(): RunState {
    return { ...this.s }
  }
  get logs(): string {
    return this.log
  }

  private set(patch: Partial<RunState>) {
    this.s = { ...this.s, ...patch }
    this.onState(this.state)
  }

  start(command: string) {
    if (this.child) throw new Error('It is already running.')
    const why = blocked(command)
    if (why) throw new Error(`Forge will not run that (${why}).`)
    this.log = ''
    const posix = !win
    // BROWSER=none: dev servers should not pop open a window of their own. FORCE_COLOR=0: plain text logs.
    const child = spawn(command, { shell: true, cwd: this.root, detached: posix, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' } })
    this.child = child
    this.set({ state: 'starting', command, port: null, url: null, exitCode: null })
    const take = (d: Buffer) => {
      const text = d.toString()
      this.log = (this.log + text).slice(-MAX_LOG)
      this.onLog(text)
      if (this.s.port === null) {
        const port = findPort(text)
        if (port) this.set({ state: 'running', port, url: `http://localhost:${port}` })
      }
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', (e) => take(Buffer.from(`\n[could not start: ${e.message}]\n`)))
    child.on('close', (code) => {
      this.child = null
      this.set({ state: 'exited', exitCode: code ?? null, url: null, port: null })
    })
    // No port in the first moments (a script, a bot): it is still running, just not a web page.
    setTimeout(() => {
      if (this.child === child && this.s.state === 'starting') this.set({ state: 'running' })
    }, 2500).unref()
  }

  stop() {
    const c = this.child
    if (!c) return
    killTree(c, 'SIGTERM')
    setTimeout(() => killTree(c), 3000).unref()
  }
}
