import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentName } from './events'

// The line between Forge and the small MCP server each agent launches. Agents ask for things (read my inbox, post a note, ask the user);
// Forge decides. One JSON object per line over a local socket (a named pipe on Windows), and every request carries a secret
// that only the processes Forge started know.
export type HubCtx = { runId: string; taskId: string; agent: AgentName }
export type HubHandler = (op: string, args: any, ctx: HubCtx) => Promise<unknown>

// Calls the hub is answering right now, per task. An approval or a question can wait for a person for hours; while one does, the agent that
// asked is not stuck, and the runner's idle timer uses this to tell the difference.
const inflight = new Map<string, number>()
export const hubBusy = (runId: string, taskId: string) => (inflight.get(`${runId}:${taskId}`) ?? 0) > 0

export class TeamHub {
  private server: Server | null = null
  private dir = ''
  readonly token = randomBytes(24).toString('hex')
  path = ''
  constructor(private handler: HubHandler) {}

  start(): Promise<string> {
    if (this.server) return Promise.resolve(this.path)
    const id = randomBytes(6).toString('hex')
    if (process.platform === 'win32') this.path = `\\\\.\\pipe\\forge-team-${id}`
    else {
      this.dir = mkdtempSync(join(tmpdir(), 'forge-team-')) // mode 0700: only this user can reach the socket
      this.path = join(this.dir, 'hub.sock')
    }
    return new Promise((resolve, reject) => {
      this.server = createServer((s) => this.serve(s))
      this.server.once('error', reject)
      this.server.listen(this.path, () => resolve(this.path))
    })
  }

  private serve(s: Socket) {
    let buf = ''
    const open = new Set<() => void>()
    s.on('close', () => open.forEach((release) => release())) // an agent that exited no longer waits on anything
    s.setEncoding('utf8') // a character split across two reads stays whole
    s.on('error', () => {})
    s.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        void this.one(s, line, open)
      }
    })
  }

  private async one(s: Socket, line: string, open = new Set<() => void>()) {
    let req: { id?: number; token?: string; op?: string; args?: unknown; ctx?: HubCtx }
    try {
      req = JSON.parse(line)
    } catch {
      return
    }
    const reply = (o: object) => s.writable && s.write(JSON.stringify({ id: req.id, ...o }) + '\n')
    if (req.token !== this.token || !req.op || !req.ctx?.runId) return void reply({ ok: false, error: 'not allowed' })
    const key = `${req.ctx.runId}:${req.ctx.taskId}`
    inflight.set(key, (inflight.get(key) ?? 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      open.delete(release)
      const left = (inflight.get(key) ?? 1) - 1
      if (left > 0) inflight.set(key, left)
      else inflight.delete(key)
    }
    open.add(release)
    try {
      reply({ ok: true, result: await this.handler(req.op, req.args ?? {}, req.ctx) })
    } catch (e) {
      reply({ ok: false, error: (e as Error).message })
    } finally {
      release()
    }
  }

  stop() {
    this.server?.close()
    this.server = null
    if (this.dir) rmSync(this.dir, { recursive: true, force: true })
  }
}
