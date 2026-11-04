import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'

// Remote access: the Forge window, served to a phone's browser. The page is the same renderer; a small script stands in for the Electron
// preload and sends each call to this server, which runs the same handler the desktop window would. Nothing is reachable until the user
// pairs a device with a one-time link, and the server only listens on the Tailscale address (or on this computer) unless asked otherwise.

export type Handler = (e: unknown, ...args: unknown[]) => unknown
export type Device = { id: string; name: string; hash: string; createdAt: number; lastSeen: number }
export type RemoteState = { enabled: boolean; lan: boolean; port: number; devices: Device[]; pairing: string[] } // pairing: hashes of links not used yet
export type RemoteStatus = { enabled: boolean; lan: boolean; listening: boolean; host: string; port: number; url: string; tailscale: boolean; devices: Omit<Device, 'hash'>[]; error?: string }
export type RemoteDeps = {
  dir: string // where remote.json lives (the user data folder)
  rendererDir: string
  preloadFile: string
  handlers: Map<string, Handler>
  listeners: Map<string, Handler[]>
  bind?: string // tests: where to listen
}

const BLOCKED = (c: string) => c.startsWith('remote:') || c === 'project:pick' || c === 'app:open-data' || c === 'team:history-open'
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json', '.webmanifest': 'application/manifest+json' }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const SESSION_SECONDS = 10 * 365 * 24 * 3600 // a paired phone stays paired until the user removes it
const MAX_BODY = 90_000_000 // photos and short videos are uploaded through the same call

// The address Tailscale gave this computer, if it is on a tailnet.
export function tailscaleAddress(): string | null {
  for (const [name, list] of Object.entries(networkInterfaces()))
    for (const a of list ?? []) {
      const [x, y] = a.address.split('.').map(Number)
      if (a.family === 'IPv4' && !a.internal && (/^tailscale/i.test(name) || (x === 100 && y >= 64 && y <= 127))) return a.address
    }
  return null
}
const lanAddress = () => Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address))?.address ?? null

export function shimSource(preload: string): string {
  const body = preload
    .replace(/^import\s*\{\s*contextBridge\s*,\s*ipcRenderer\s*\}\s*from\s*["']electron["'];?/m, 'const { contextBridge, ipcRenderer } = window.__forgeElectron;')
    .replace(/^export\s*\{\s*\};?\s*$/gm, '') // the built preload ends with an empty export, which a plain script cannot contain
  return `(() => {
const listeners = new Map()
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s) }
const encode = (k, v) => (v instanceof Uint8Array ? { __u8: b64(v) } : v instanceof ArrayBuffer ? { __u8: b64(new Uint8Array(v)) } : v)
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, encode), credentials: 'same-origin' })
  if (r.status === 401) { location.href = '/__unpaired'; throw new Error('This device is not paired.') }
  return r.json()
}
const ipcRenderer = {
  invoke: (c, ...a) => post('/rpc', { c, a }).then((r) => { if (!r.ok) throw new Error(r.error); return r.result }),
  send: (c, ...a) => { post('/send', { c, a }).catch(() => {}) },
  on: (c, fn) => { if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(fn); return ipcRenderer },
  removeListener: (c, fn) => { listeners.get(c)?.delete(fn); return ipcRenderer },
}
const connect = () => {
  const es = new EventSource('/events')
  es.onmessage = (m) => { try { const { c, a } = JSON.parse(m.data); listeners.get(c)?.forEach((fn) => fn({}, ...a)) } catch {} }
  es.onopen = () => window.dispatchEvent(new Event('forge-remote-online'))
}
connect()
document.addEventListener('visibilitychange', () => { if (!document.hidden) window.dispatchEvent(new Event('forge-remote-resume')) })
window.__forgeRemote = true
window.__forgeElectron = { contextBridge: { exposeInMainWorld: (n, api) => { window[n] = api } }, ipcRenderer }
})();
;(() => {
${body}
})();
`
}

export class RemoteServer {
  private server: Server | null = null
  private state: RemoteState
  private clients = new Set<ServerResponse>()
  private fails = new Map<string, { n: number; at: number }>()
  private host = '127.0.0.1'
  private error = ''
  private shim = ''
  private file: string

  constructor(private d: RemoteDeps) {
    this.file = join(d.dir, 'remote.json')
    let s: Partial<RemoteState> = {}
    try { s = JSON.parse(readFileSync(this.file, 'utf8')) } catch {}
    this.state = { enabled: !!s.enabled, lan: !!s.lan, port: Number(s.port) || 8787, devices: Array.isArray(s.devices) ? s.devices : [], pairing: Array.isArray(s.pairing) ? s.pairing.slice(-20) : [] }
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 })
  }

  // Every message the app sends to its window is also sent to the paired phones.
  broadcast(channel: string, args: unknown[]) {
    if (!this.clients.size) return
    let data: string
    try { data = JSON.stringify({ c: channel, a: args }) } catch { return }
    for (const res of this.clients) res.write(`data: ${data}\n\n`)
  }

  status(): RemoteStatus {
    const ts = tailscaleAddress()
    const shown = this.state.lan ? (ts ?? lanAddress() ?? this.host) : (ts ?? this.host)
    return { enabled: this.state.enabled, lan: this.state.lan, listening: !!this.server?.listening, host: this.host, port: this.port(), url: `http://${shown}:${this.port()}`, tailscale: !!ts, devices: this.state.devices.map(({ hash: _h, ...d }) => d), error: this.error || undefined }
  }
  private port() { return (this.server?.address() as { port?: number } | null)?.port ?? this.state.port }

  async configure(o: { enabled?: boolean; lan?: boolean }): Promise<RemoteStatus> {
    if (o.lan !== undefined) this.state.lan = o.lan
    if (o.enabled !== undefined) this.state.enabled = o.enabled
    this.save()
    await this.stop()
    if (this.state.enabled) await this.start()
    return this.status()
  }

  async start(port = this.state.port): Promise<void> {
    if (this.server) return
    this.error = ''
    this.host = this.d.bind ?? (this.state.lan ? '0.0.0.0' : (tailscaleAddress() ?? '127.0.0.1'))
    const srv = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) })
    srv.keepAliveTimeout = 5000
    await new Promise<void>((resolveStart) => {
      srv.once('error', (e: NodeJS.ErrnoException) => { this.error = e.code === 'EADDRINUSE' ? `Port ${port} is in use.` : e.message; resolveStart() })
      srv.listen(port, this.host, () => { this.server = srv; resolveStart() })
    })
  }

  async stop() {
    for (const c of this.clients) c.end()
    this.clients.clear()
    const s = this.server
    this.server = null
    if (s) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.() })
  }

  // A one-time link for a new device. It does not expire, but it works for one device only and is gone once used (or when a newer one pushes it out).
  async pairLink(): Promise<{ url: string; qr: string }> {
    const token = randomBytes(24).toString('hex')
    this.state.pairing = [...this.state.pairing, sha(token)].slice(-20)
    this.save()
    const url = `${this.status().url}/__pair?t=${token}`
    let qr = ''
    try { qr = await (await import('qrcode')).toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: 'M' }) } catch {}
    return { url, qr }
  }

  revoke(id: string) {
    this.state.devices = this.state.devices.filter((d) => d.id !== id)
    this.save()
    return this.status()
  }

  // ---------------------------------------------------------------- requests

  private cookie(req: IncomingMessage, name: string) {
    for (const part of (req.headers.cookie ?? '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('=') }
    return ''
  }
  private deviceOf(req: IncomingMessage): Device | null {
    const raw = this.cookie(req, 'forge_session')
    const [id, secret] = raw.split('.')
    if (!id || !secret) return null
    const dev = this.state.devices.find((d) => d.id === id)
    return dev && same(dev.hash, sha(secret)) ? dev : null
  }
  private tooMany(ip: string) {
    const f = this.fails.get(ip)
    return !!f && Date.now() - f.at < 60_000 && f.n >= 10
  }
  private fail(ip: string) {
    const f = this.fails.get(ip)
    this.fails.set(ip, f && Date.now() - f.at < 60_000 ? { n: f.n + 1, at: f.at } : { n: 1, at: Date.now() })
  }

  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []
    let n = 0
    for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw new Error('too large'); chunks.push(c as Buffer) }
    // binary arguments (pictures) arrive as { __u8: base64 } and are turned back into bytes
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}', (_k, v) => (v && typeof v === 'object' && typeof v.__u8 === 'string' && Object.keys(v).length === 1 ? new Uint8Array(Buffer.from(v.__u8, 'base64')) : v))
  }

  private json(res: ServerResponse, code: number, v: unknown) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(v))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const ip = req.socket.remoteAddress ?? ''
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    if (this.tooMany(ip)) return void this.json(res, 429, { error: 'Too many attempts. Wait a minute.' })

    if (url.pathname === '/__pair') {
      const t = url.searchParams.get('t') ?? ''
      const key = sha(t)
      const known = this.state.pairing.includes(key)
      if (known) { this.state.pairing = this.state.pairing.filter((x) => x !== key); this.save() } // one use
      if (!t || !known) { this.fail(ip); res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }); return void res.end('<meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:24px;background:#101010;color:#eee">This link has already been used or was replaced. Make a new one in Forge: Settings, Remote access.') }
      const secret = randomBytes(32).toString('hex')
      const id = randomBytes(6).toString('hex')
      const ua = String(req.headers['user-agent'] ?? '')
      const name = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Browser'
      this.state.devices.push({ id, name, hash: sha(secret), createdAt: Date.now(), lastSeen: Date.now() })
      this.save()
      res.writeHead(302, { location: '/', 'set-cookie': `forge_session=${id}.${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`, 'cache-control': 'no-store' })
      return void res.end()
    }

    const dev = this.deviceOf(req)
    if (!dev) {
      if (url.pathname === '/__unpaired' || req.method === 'GET' && url.pathname === '/') { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); return void res.end('<meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:24px;background:#101010;color:#eee"><h2>Forge</h2>This device is not paired. In Forge on your computer open Settings, Remote access, and scan the QR code.') }
      this.fail(ip)
      return void this.json(res, 401, { error: 'not paired' })
    }
    if (Date.now() - dev.lastSeen > 60_000) { dev.lastSeen = Date.now(); this.save() }

    if (req.method === 'POST' && (url.pathname === '/rpc' || url.pathname === '/send')) {
      let msg: { c?: unknown; a?: unknown }
      try { msg = await this.body(req) } catch { return void this.json(res, 400, { ok: false, error: 'bad request' }) }
      const c = typeof msg.c === 'string' ? msg.c : ''
      const args = Array.isArray(msg.a) ? msg.a : []
      if (!c || BLOCKED(c)) return void this.json(res, 403, { ok: false, error: 'This action is only available on the computer.' })
      const sender = { send: (ch: string, ...a: unknown[]) => this.broadcast(ch, a), isDestroyed: () => false }
      const event = { sender }
      if (url.pathname === '/send') {
        for (const fn of this.d.listeners.get(c) ?? []) try { fn(event, ...args) } catch {}
        return void this.json(res, 200, { ok: true })
      }
      const fn = this.d.handlers.get(c)
      if (!fn) return void this.json(res, 404, { ok: false, error: `unknown call ${c}` })
      try { return void this.json(res, 200, { ok: true, result: await fn(event, ...args) }) } catch (e) { return void this.json(res, 200, { ok: false, error: (e as Error).message }) }
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write(': ok\n\n')
      this.clients.add(res)
      const beat = setInterval(() => res.write(': ping\n\n'), 20_000)
      req.on('close', () => { clearInterval(beat); this.clients.delete(res) })
      return
    }

    if (req.method !== 'GET') return void this.json(res, 405, { error: 'method not allowed' })
    if (url.pathname === '/__forge-remote.js') {
      this.shim ||= shimSource(readFileSync(this.d.preloadFile, 'utf8'))
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' })
      return void res.end(this.shim)
    }
    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': MIME['.webmanifest'] })
      return void res.end(JSON.stringify({ name: 'Forge', short_name: 'Forge', start_url: '/', display: 'standalone', background_color: '#101010', theme_color: '#101010', icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] }))
    }
    
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const abs = resolve(this.d.rendererDir, '.' + rel)
    if (abs !== resolve(this.d.rendererDir) && !abs.startsWith(resolve(this.d.rendererDir) + sep)) return void this.json(res, 403, { error: 'forbidden' })
    if (rel === '/index.html') {
      const html = (await readFile(abs, 'utf8'))
        .replace('width=device-width, initial-scale=1', 'width=device-width, initial-scale=1, viewport-fit=cover')
        .replace('</head>', '  <link rel="manifest" href="/manifest.webmanifest" />\n  <link rel="apple-touch-icon" href="/icon.png" />\n  <meta name="apple-mobile-web-app-capable" content="yes" />\n  <meta name="mobile-web-app-capable" content="yes" />\n  <meta name="apple-mobile-web-app-title" content="Forge" />\n  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />\n  <meta name="theme-color" content="#101010" />\n  <script src="/__forge-remote.js"></script>\n</head>')
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
      return void res.end(html)
    }
    await this.file2(res, abs, false)
  }

  private async file2(res: ServerResponse, abs: string, short: boolean) {
    if (!existsSync(abs)) { res.writeHead(404); return void res.end('not found') }
    res.writeHead(200, { 'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream', 'cache-control': short ? 'max-age=86400' : 'max-age=3600' })
    res.end(await readFile(abs))
  }
}
