import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { brotliCompress, gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

const BLOCKED = (c: string) => c.startsWith('remote:') || c === 'project:pick' || c === 'app:open-data' || c === 'team:history-open' || c === 'team:export-report'
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json', '.webmanifest': 'application/manifest+json' }
const brotli = promisify(brotliCompress)
const gz = promisify(gzip)
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.webmanifest', '.ttf'])
const MAX_COMPRESS = 3_000_000 // bigger files (the editor's language workers) are sent as they are
const HASHED = /-[\w-]{8,}\.[a-z0-9]+$/i // build output names carry a hash of their content, so they can be cached for good
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
let queue = []
let timer = 0
const flush = async () => {
  timer = 0
  const batch = queue
  queue = []
  try {
    const r = await post('/batch', { calls: batch.map((b) => ({ c: b.c, a: b.a })) })
    batch.forEach((b, i) => { const x = r.results[i]; if (x && x.ok) b.res(x.result); else b.rej(new Error(x ? x.error : 'no answer')) })
  } catch (e) { batch.forEach((b) => b.rej(e)) }
}
const ipcRenderer = {
  invoke: (c, ...a) => new Promise((res, rej) => { queue.push({ c, a, res, rej }); if (!timer) timer = setTimeout(flush, 2) }),
  send: (c, ...a) => { post('/send', { c, a }).catch(() => {}) },
  on: (c, fn) => { if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(fn); return ipcRenderer },
  removeListener: (c, fn) => { listeners.get(c)?.delete(fn); return ipcRenderer },
}
let es = null
let last = Date.now()
let online = false
const setOnline = (v) => { if (v !== online) { online = v; window.dispatchEvent(new Event(v ? 'forge-remote-online' : 'forge-remote-offline')) } }
const connect = () => {
  if (es) es.close()
  es = new EventSource('/events')
  es.onopen = () => { last = Date.now(); setOnline(true) }
  es.onerror = () => setOnline(false)
  es.onmessage = (m) => {
    last = Date.now(); setOnline(true)
    try { const { c, a } = JSON.parse(m.data); if (c !== '__ping') listeners.get(c)?.forEach((fn) => fn({}, ...a)) } catch {}
  }
}
// iOS freezes a page in the background; when it wakes the link may be dead without saying so, so a silent link is replaced.
setInterval(() => { if (Date.now() - last > 40000) { setOnline(false); connect() } }, 5000)
connect()
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (Date.now() - last > 20000) connect(); window.dispatchEvent(new Event('forge-remote-resume')) } })
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
  // Messages that arrive close together (a stream of text from an agent) are written to the phones in one go, not one packet each.
  private outbox = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  broadcast(channel: string, args: unknown[]) {
    if (!this.clients.size) return
    let data: string
    try { data = JSON.stringify({ c: channel, a: args }) } catch { return }
    this.outbox += `data: ${data}\n\n`
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null
      const chunk = this.outbox
      this.outbox = ''
      for (const res of this.clients) res.write(chunk)
    }, 30)
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
    srv.keepAliveTimeout = 65_000 // phones reuse one connection instead of opening a new one for every call
    srv.on('connection', (sock) => sock.setNoDelay(true))
    await new Promise<void>((resolveStart) => {
      srv.once('error', (e: NodeJS.ErrnoException) => { this.error = e.code === 'EADDRINUSE' ? `Port ${port} is in use.` : e.message; resolveStart() })
      srv.listen(port, this.host, () => { this.server = srv; resolveStart() })
    })
  }

  async stop() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.outbox = ''
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

  private async json(res: ServerResponse, code: number, v: unknown, req?: IncomingMessage) {
    const body = Buffer.from(JSON.stringify(v))
    if (req && body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      const z = await gz(body, { level: 4 })
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-encoding': 'gzip', vary: 'Accept-Encoding' })
      return void res.end(z)
    }
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(body)
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

    // Several calls in one request: the phone batches what the page asks for at start-up, so one round trip does the work of a dozen.
    if (req.method === 'POST' && url.pathname === '/batch') {
      let msg: { calls?: { c?: unknown; a?: unknown }[] }
      try { msg = await this.body(req) } catch { return void this.json(res, 400, { error: 'bad request' }) }
      const calls = Array.isArray(msg.calls) ? msg.calls.slice(0, 40) : []
      const event = { sender: { send: (ch: string, ...a: unknown[]) => this.broadcast(ch, a), isDestroyed: () => false }, remote: true }
      const results = await Promise.all(calls.map(async (call) => {
        const c = typeof call?.c === 'string' ? call.c : ''
        if (!c || BLOCKED(c)) return { ok: false, error: 'This action is only available on the computer.' }
        const fn = this.d.handlers.get(c)
        if (!fn) return { ok: false, error: `unknown call ${c}` }
        try { return { ok: true, result: await fn(event, ...(Array.isArray(call.a) ? call.a : [])) } } catch (e) { return { ok: false, error: (e as Error).message } }
      }))
      return void (await this.json(res, 200, { results }, req))
    }

    if (req.method === 'POST' && (url.pathname === '/rpc' || url.pathname === '/send')) {
      let msg: { c?: unknown; a?: unknown }
      try { msg = await this.body(req) } catch { return void this.json(res, 400, { ok: false, error: 'bad request' }) }
      const c = typeof msg.c === 'string' ? msg.c : ''
      const args = Array.isArray(msg.a) ? msg.a : []
      if (!c || BLOCKED(c)) return void this.json(res, 403, { ok: false, error: 'This action is only available on the computer.' })
      const sender = { send: (ch: string, ...a: unknown[]) => this.broadcast(ch, a), isDestroyed: () => false }
      const event = { sender, remote: true }
      if (url.pathname === '/send') {
        for (const fn of this.d.listeners.get(c) ?? []) try { fn(event, ...args) } catch {}
        return void this.json(res, 200, { ok: true })
      }
      const fn = this.d.handlers.get(c)
      if (!fn) return void this.json(res, 404, { ok: false, error: `unknown call ${c}` })
      try { return void (await this.json(res, 200, { ok: true, result: await fn(event, ...args) }, req)) } catch (e) { return void this.json(res, 200, { ok: false, error: (e as Error).message }) }
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write(': ok\n\n')
      this.clients.add(res)
      const beat = setInterval(() => res.write('data: {"c":"__ping","a":[]}\n\n'), 15_000) // a real message, so the phone can tell the link is alive
      req.on('close', () => { clearInterval(beat); this.clients.delete(res) })
      return
    }

    if (req.method !== 'GET') return void this.json(res, 405, { error: 'method not allowed' })
    if (url.pathname === '/__forge-remote.js') {
      this.shim ||= shimSource(readFileSync(this.d.preloadFile, 'utf8'))
      const z = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) ? await gz(Buffer.from(this.shim)) : null
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache', vary: 'Accept-Encoding', ...(z ? { 'content-encoding': 'gzip' } : {}) })
      return void res.end(z ?? this.shim)
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
      const z = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) ? await gz(Buffer.from(html)) : null
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', vary: 'Accept-Encoding', ...(z ? { 'content-encoding': 'gzip' } : {}) })
      return void res.end(z ?? html)
    }
    await this.file2(req, res, abs, false)
  }

  private packed = new Map<string, { key: string; enc: 'br' | 'gzip' | ''; body: Buffer }>()

  // Static files: cached for good when the name carries a content hash, revalidated with an ETag otherwise, and compressed once and kept.
  private async file2(req: IncomingMessage, res: ServerResponse, abs: string, short: boolean) {
    let st
    try { st = statSync(abs) } catch { res.writeHead(404); return void res.end('not found') }
    if (!st.isFile()) { res.writeHead(404); return void res.end('not found') }
    const ext = extname(abs).toLowerCase()
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    const hashed = HASHED.test(abs)
    const headers: Record<string, string> = { 'content-type': MIME[ext] ?? 'application/octet-stream', etag, 'cache-control': hashed ? 'public, max-age=31536000, immutable' : short ? 'max-age=86400' : 'no-cache', vary: 'Accept-Encoding' }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return void res.end() }
    const accept = String(req.headers['accept-encoding'] ?? '')
    const want: 'br' | 'gzip' | '' = !COMPRESSIBLE.has(ext) || st.size > MAX_COMPRESS || st.size < 600 ? '' : /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : ''
    const slot = `${abs}|${want}`
    let hit = this.packed.get(slot)
    if (!hit || hit.key !== etag) {
      const raw = await readFile(abs)
      const body = want === 'br' ? await brotli(raw) : want === 'gzip' ? await gz(raw, { level: 6 }) : raw
      hit = { key: etag, enc: want, body }
      this.packed.set(slot, hit)
      if (this.packed.size > 200) this.packed.delete(this.packed.keys().next().value as string)
    }
    if (hit.enc) headers['content-encoding'] = hit.enc
    headers['content-length'] = String(hit.body.length)
    res.writeHead(200, headers)
    res.end(hit.body)
  }
}
