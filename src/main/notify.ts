import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Phone notifications: one short HTTP POST to an ntfy-compatible server (https://ntfy.sh by default), which the ntfy app on the phone shows.
// Only the fixed sentences below are ever sent. Goals, messages, code and file names have no way in: callers pass an event kind, not text.

export type PushSettings = { enabled: boolean; server: string; topic: string; includeProject: boolean }
export type PushResult = { ok: boolean; error?: string }
type Priority = 'min' | 'low' | 'default' | 'high' | 'urgent'

const TEXT = {
  question: ['Crew needs your answer', 'high'],
  finished: ['Crew run finished', 'default'],
  attention: ['Crew run needs attention', 'high'],
  chatQuestion: ['Forge needs your approval', 'high'],
  chatDone: ['Forge finished', 'default'],
} as const satisfies Record<string, readonly [string, Priority]>
export type PushKind = keyof typeof TEXT

const GAP_MS = 5000
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])
const newTopic = () => randomBytes(18).toString('base64url') // 24 characters, url-safe

// https only; plain http is for a server on this computer (tests, a self-hosted ntfy). Returns the address without a trailing slash.
export function checkServer(server: string): string {
  let u: URL
  try { u = new URL(server.trim()) } catch { throw new Error('That is not a web address. Use something like https://ntfy.sh.') }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) throw new Error('Use an https address (http is only allowed for a server on this computer).')
  return u.origin + u.pathname.replace(/\/+$/, '')
}

export class PushNotifier {
  private s: PushSettings
  private file: string
  private last = new Map<string, number>()

  constructor(dir: string) {
    this.file = join(dir, 'push.json')
    let v: Partial<PushSettings> = {}
    try { v = JSON.parse(readFileSync(this.file, 'utf8')) } catch {}
    let server = 'https://ntfy.sh'
    try { server = checkServer(String(v.server ?? server)) } catch {}
    this.s = { enabled: v.enabled === true, server, topic: typeof v.topic === 'string' && /^[\w-]{16,64}$/.test(v.topic) ? v.topic : newTopic(), includeProject: v.includeProject === true }
    if (v.topic !== this.s.topic) this.save()
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.s, null, 2), { mode: 0o600 }) // the topic works like a password for a public server
  }

  get(): PushSettings { return { ...this.s } }

  set(o: Partial<Pick<PushSettings, 'enabled' | 'server' | 'includeProject'>>): PushSettings {
    const server = o.server === undefined ? this.s.server : checkServer(o.server)
    this.s = { ...this.s, server, enabled: typeof o.enabled === 'boolean' ? o.enabled : this.s.enabled, includeProject: typeof o.includeProject === 'boolean' ? o.includeProject : this.s.includeProject }
    this.save()
    return this.get()
  }

  newTopic(): PushSettings {
    this.s.topic = newTopic()
    this.save()
    return this.get()
  }

  // Never throws. At most one message per 5 s for the same key.
  async send(m: { title: string; body: string; url?: string; priority?: Priority; key?: string }): Promise<PushResult> {
    const key = m.key ?? m.title
    const wait = (this.last.get(key) ?? 0) + GAP_MS - Date.now()
    if (wait > 0) return { ok: false, error: `Wait ${Math.ceil(wait / 1000)} seconds before sending another one.` }
    let server: string
    try { server = checkServer(this.s.server) } catch (e) { return { ok: false, error: (e as Error).message } }
    this.last.set(key, Date.now())
    try {
      const headers: Record<string, string> = { Title: m.title, Priority: m.priority ?? 'default' }
      if (m.url) headers.Click = m.url
      const r = await fetch(`${server}/${this.s.topic}`, { method: 'POST', headers, body: m.body, signal: AbortSignal.timeout(5000), redirect: 'error' })
      return r.ok ? { ok: true } : { ok: false, error: `The push server answered ${r.status}.` }
    } catch (e) {
      const x = e as Error & { cause?: { code?: string } }
      return { ok: false, error: x.name === 'TimeoutError' ? 'The push server did not answer within 5 seconds.' : `Could not reach the push server (${x.cause?.code ?? x.message}).` }
    }
  }

  // An event of the app. Does nothing unless push is on; the project folder name is added only when the user asked for it.
  event(kind: PushKind, project?: string): Promise<PushResult> {
    if (!this.s.enabled) return Promise.resolve({ ok: false, error: 'Phone notifications are off.' })
    const folder = this.s.includeProject && project ? basename(project).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40) : ''
    const [text, priority] = TEXT[kind]
    return this.send({ title: 'Forge', body: folder ? `${text} · ${folder}` : text, priority, key: kind })
  }

  test(): Promise<PushResult> {
    return this.send({ title: 'Forge', body: 'This is a test. Phone notifications work.', key: 'test' })
  }
}
