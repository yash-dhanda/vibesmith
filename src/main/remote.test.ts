import { execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BLOCKED, RemoteServer, shimSource, tailscaleAddress } from './remote'

const nics = vi.hoisted(() => ({ list: null as null | Record<string, { address: string; family: string; internal: boolean }[]> }))
vi.mock('node:os', async (orig) => {
  const os = await orig<typeof import('node:os')>()
  return { ...os, networkInterfaces: () => nics.list ?? os.networkInterfaces() }
})

let srv: RemoteServer | null = null
afterEach(async () => { await srv?.stop(); srv = null })

async function boot(extra: Record<string, unknown> = {}, state?: object) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-'))
  if (state) writeFileSync(join(dir, 'remote.json'), JSON.stringify(state))
  const rendererDir = join(dir, 'renderer')
  mkdirSync(rendererDir)
  writeFileSync(join(rendererDir, 'index.html'), '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body>forge</body></html>')
  writeFileSync(join(rendererDir, 'app.js'), 'console.log(1)')
  const preloadFile = join(dir, 'preload.mjs')
  writeFileSync(preloadFile, 'import { contextBridge, ipcRenderer } from "electron";\ncontextBridge.exposeInMainWorld("forge", { hello: (n) => ipcRenderer.invoke("hello", n) });')
  const sent: unknown[][] = []
  const handlers = new Map<string, (e: any, ...a: any[]) => unknown>([['hello', (_e, n) => `hi ${n}`], ['boom', () => { throw new Error('nope') }], ['project:pick', () => 'x'], ['team:export-report', () => 'x'], ['who', (e: any) => e.remote === true], ['ping', (e) => { e.sender.send('pong', 1) }], ['bytes', (_e, files: any) => files.map((f: any) => `${f.name}:${f.data instanceof Uint8Array}:${f.data.length}`)]])
  const listeners = new Map<string, ((e: any, ...a: any[]) => void)[]>([['note', [(_e, ...a) => { sent.push(a) }]]])
  srv = new RemoteServer({ dir, rendererDir, preloadFile, handlers, listeners, bind: '127.0.0.1', ...extra })
  await srv.start(0)
  const base = srv.status().url.replace(/^(http:\/\/)[^:]+/, '$1127.0.0.1')
  return { base, srv, sent }
}
const pair = async (t: { base: string; srv: RemoteServer }) => {
  const link = await t.srv.pairLink()
  const r = await fetch(link.url.replace(/^(http:\/\/)[^:]+/, '$1127.0.0.1'), { redirect: 'manual' })
  return { r, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] }
}
const rpc = (base: string, cookie: string, c: string, a: unknown[] = []) => fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ c, a }) })

describe('remote access', () => {
  it('serves nothing to a device that is not paired', async () => {
    const t = await boot()
    expect((await fetch(`${t.base}/`)).status).toBe(401)
    expect((await fetch(`${t.base}/app.js`)).status).toBe(401)
    expect((await rpc(t.base, '', 'hello', ['x'])).status).toBe(401)
    expect((await fetch(`${t.base}/events`)).status).toBe(401)
  })

  it('pairs once with a one-time link, then lets the device call the app', async () => {
    const t = await boot()
    const link = await t.srv.pairLink()
    const url = link.url.replace(/^(http:\/\/)[^:]+/, '$1127.0.0.1')
    const first = await fetch(url, { redirect: 'manual' })
    expect(first.status).toBe(200) // a page that moves on to '/', not a redirect (see the cross-site pairing test)
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie).toMatch(/^forge_session=/)
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(403) // the link was good once only
    expect(await (await rpc(t.base, cookie, 'hello', ['phone'])).json()).toEqual({ ok: true, result: 'hi phone' })
    expect(await (await rpc(t.base, cookie, 'boom')).json()).toEqual({ ok: false, error: 'nope' })
    expect((await rpc(t.base, cookie, 'project:pick')).status).toBe(403)
    expect((await rpc(t.base, cookie, 'team:export-report')).status).toBe(403)
    expect(await (await rpc(t.base, cookie, 'who')).json()).toEqual({ ok: true, result: true }) // handlers can tell the call came from a phone
    expect((await rpc(t.base, cookie, 'remote:set')).status).toBe(403)
    expect((await rpc(t.base, cookie, 'missing')).status).toBe(404)
    const html = await (await fetch(`${t.base}/`, { headers: { cookie } })).text()
    expect(html).toContain('/__forge-remote.js')
    expect(html).toContain('viewport-fit=cover')
    const shim = await (await fetch(`${t.base}/__forge-remote.js`, { headers: { cookie } })).text()
    expect(shim).toContain('window.__forgeElectron')
    expect(shim).not.toContain('from "electron"')
    expect(t.srv.status().devices).toHaveLength(1)
    t.srv.revoke(t.srv.status().devices[0].id)
    expect((await rpc(t.base, cookie, 'hello', ['x'])).status).toBe(401)
  })

  it('answers many calls in one request, and keeps blocked ones blocked', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    const res = await fetch(`${t.base}/batch`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ calls: [{ c: 'hello', a: ['a'] }, { c: 'boom', a: [] }, { c: 'project:pick', a: [] }, { c: 'nope', a: [] }, { c: 'hello', a: ['b'] }] }) })
    const { results } = await res.json()
    expect(results.map((r: { ok: boolean; result?: string }) => (r.ok ? r.result : 'x'))).toEqual(['hi a', 'x', 'x', 'x', 'hi b'])
    expect(results[2].error).toMatch(/only available on the computer/)
  })

  it('compresses, and lets the phone keep what it already has', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    const dir = (t.srv as unknown as { d: { rendererDir: string } }).d.rendererDir
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'index-AbCdEf12.js'), 'const x = "forge";\n'.repeat(400))
    const raw = await fetch(`${t.base}/assets/index-AbCdEf12.js`, { headers: { cookie, 'accept-encoding': 'identity' } })
    const rawLen = (await raw.arrayBuffer()).byteLength
    const br = await fetch(`${t.base}/assets/index-AbCdEf12.js`, { headers: { cookie, 'accept-encoding': 'br' } })
    expect(br.headers.get('content-encoding')).toBe('br')
    expect(br.headers.get('cache-control')).toMatch(/immutable/)
    expect(Number(br.headers.get('content-length'))).toBeLessThan(rawLen / 4)
    const etag = br.headers.get('etag')!
    expect((await fetch(`${t.base}/assets/index-AbCdEf12.js`, { headers: { cookie, 'if-none-match': etag } })).status).toBe(304)
    expect((await fetch(`${t.base}/app.js`, { headers: { cookie } })).headers.get('cache-control')).toBe('no-cache')
    const gzHtml = await fetch(`${t.base}/`, { headers: { cookie, 'accept-encoding': 'gzip' } })
    expect(gzHtml.headers.get('content-encoding')).toBe('gzip')
    expect(await gzHtml.text()).toContain('/__forge-remote.js')
  })

  it('turns binary arguments back into bytes', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    const res = await fetch(`${t.base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ c: 'bytes', a: [[{ name: 'a.png', data: { __u8: Buffer.from('hello').toString('base64') } }]] }) })
    expect(await res.json()).toEqual({ ok: true, result: ['a.png:true:5'] })
  })

  it('keeps pairing links and paired phones across restarts, with no expiry', async () => {
    const t = await boot()
    const link = await t.srv.pairLink()
    const dir = (t.srv as unknown as { d: { dir: string; rendererDir: string; preloadFile: string; handlers: Map<string, any>; listeners: Map<string, any> } }).d
    await t.srv.stop()
    const again = new RemoteServer({ ...dir, bind: '127.0.0.1' })
    srv = again
    await again.start(0)
    const url = link.url.replace(/^(http:\/\/)[^:]+:\d+/, `$1127.0.0.1:${again.status().port}`)
    const first = await fetch(url, { redirect: 'manual' })
    expect(first.status).toBe(200)
    expect(first.headers.get('set-cookie')).toMatch(/Max-Age=315360000/)
    await again.stop()
    const third = new RemoteServer({ ...dir, bind: '127.0.0.1' })
    srv = third
    await third.start(0)
    expect(third.status().devices).toHaveLength(1) // still paired after another restart
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]
    expect((await rpc(`http://127.0.0.1:${third.status().port}`, cookie, 'hello', ['x'])).status).toBe(200)
  })

  it('cannot be used to read files outside the app folder', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    expect((await fetch(`${t.base}/..%2f..%2fetc%2fpasswd`, { headers: { cookie } })).status).toBeGreaterThanOrEqual(403)
    expect((await fetch(`${t.base}/%2e%2e/%2e%2e/etc/passwd`, { headers: { cookie } })).status).not.toBe(200)
  })

  it('streams what the app sends to its window to the phone, and forwards plain sends', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    const res = await fetch(`${t.base}/events`, { headers: { cookie } })
    const reader = res.body!.getReader()
    await reader.read() // the opening comment
    t.srv.broadcast('team:event', [{ type: 'run' }])
    const chunk = new TextDecoder().decode((await reader.read()).value)
    expect(chunk).toContain('"c":"team:event"')
    await rpc(t.base, cookie, 'ping')
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"c":"pong"')
    await fetch(`${t.base}/send`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ c: 'note', a: ['a', 2] }) })
    expect(t.sent).toEqual([['a', 2]])
    await reader.cancel()
  })

  it('builds the phone script from the preload file', () => {
    const s = shimSource('import { contextBridge, ipcRenderer } from "electron";\ncontextBridge.exposeInMainWorld("forge", {});')
    expect(s).toContain('const { contextBridge, ipcRenderer } = window.__forgeElectron;')
    expect(() => new Function(s)).not.toThrow() // a plain script must parse
    expect(shimSource('import { contextBridge, ipcRenderer } from "electron";\nexposeIt();\nexport {};\n')).not.toMatch(/export\s*\{/)
  })

  it('refuses calls that do not come from the Forge page, even with the phone cookie (a page on another port shares it)', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    const post = (path: string, headers: Record<string, string>, body: unknown = { c: 'hello', a: ['x'] }) => fetch(`${t.base}${path}`, { method: 'POST', headers: { cookie, ...headers }, body: JSON.stringify(body) })
    const other = t.base.replace(/:\d+$/, ':1')
    for (const path of ['/rpc', '/send', '/batch']) {
      expect((await post(path, { 'content-type': 'text/plain' })).status).toBe(403) // a no-cors form post
      expect((await post(path, { 'content-type': 'application/json', origin: other })).status).toBe(403)
      expect((await post(path, { 'content-type': 'application/json', origin: 'null' })).status).toBe(403)
      expect((await post(path, { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' })).status).toBe(403)
      expect((await post(path, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    }
    expect(await (await post('/rpc', { 'content-type': 'application/json', origin: t.base, 'sec-fetch-site': 'same-origin' })).json()).toEqual({ ok: true, result: 'hi x' }) // what the phone page sends
    expect((await post('/rpc', { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200)
  })

  it('keeps every desktop-only channel of index.ts blocked, and nothing else', () => {
    const text = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const channels = [...text.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(channels.length).toBeGreaterThan(90)
    const desktopOnly = ['app:open-data', 'fs:list', 'fs:read', 'fs:write', 'open:external', 'open:folder', 'open:path', 'preview:attach', 'preview:bounds', 'preview:detach', 'preview:reload', 'preview:visible', 'project:pick', 'push:get', 'push:new-topic', 'push:set', 'push:test', 'remote:pair', 'remote:revoke', 'remote:set', 'remote:status', 'save:text', 'team:export-report', 'team:history-open', 'term:resize', 'term:spawn', 'term:write']
    expect([...new Set(channels.filter(BLOCKED))].sort()).toEqual(desktopOnly)
    expect(BLOCKED('term:anything')).toBe(true) // a channel added later in a blocked family is blocked at once
    expect(BLOCKED('agent:send') || BLOCKED('preview:start') || BLOCKED('run:start')).toBe(false)
  })

  it('does not send the desktop terminal to phones', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    const reader = (await fetch(`${t.base}/events`, { headers: { cookie } })).body!.getReader()
    await reader.read()
    t.srv.broadcast('term:data', ['$ cat .env'])
    t.srv.broadcast('team:event', [1])
    const chunk = new TextDecoder().decode((await reader.read()).value)
    expect(chunk).toContain('team:event')
    expect(chunk).not.toContain('term:data')
    await reader.cancel()
  })

  it('cuts off a revoked device event stream', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    const reader = (await fetch(`${t.base}/events`, { headers: { cookie } })).body!.getReader()
    await reader.read()
    t.srv.revoke(t.srv.status().devices[0].id)
    expect((await reader.read()).done).toBe(true)
    expect((t.srv as unknown as { clients: Map<unknown, unknown> }).clients.size).toBe(0)
  })

  it('drops an event stream that stopped reading', async () => {
    const t = await boot()
    const fake = { writableLength: 5_000_000, write: vi.fn(), end: vi.fn(), destroy: vi.fn() }
    const clients = (t.srv as unknown as { clients: Map<unknown, string> }).clients
    clients.set(fake, 'x')
    t.srv.broadcast('team:event', [1])
    await new Promise((r) => setTimeout(r, 60))
    expect(fake.destroy).toHaveBeenCalled()
    expect(fake.write).not.toHaveBeenCalled()
    expect(clients.size).toBe(0)
  })

  it('only counts wrong cookies against the limit, so a paired phone is never locked out', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    for (let i = 0; i < 12; i++) await fetch(`${t.base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect((await rpc(t.base, cookie, 'hello', ['x'])).status).toBe(200)
    for (let i = 0; i < 12; i++) await rpc(t.base, 'forge_session=aa.bb', 'hello')
    expect((await rpc(t.base, 'forge_session=aa.bb', 'hello')).status).toBe(429)
    expect((await rpc(t.base, cookie, 'hello', ['x'])).status).toBe(200)
  })

  it('serves the manifest and icon without the session cookie', async () => {
    const t = await boot()
    const dir = (t.srv as unknown as { d: { rendererDir: string } }).d.rendererDir
    writeFileSync(join(dir, 'icon.png'), 'png')
    const m = await fetch(`${t.base}/manifest.webmanifest`)
    expect(m.status).toBe(200)
    expect((await m.json()).name).toBe('Forge')
    expect((await fetch(`${t.base}/icon.png`)).status).toBe(200)
    expect((await fetch(`${t.base}/app.js`)).status).toBe(401)
  })

  it('pairs through a page that navigates, so a link opened from another site still works', async () => {
    const t = await boot()
    const { r } = await pair(t)
    expect(r.status).toBe(200)
    expect(r.headers.get('location')).toBeNull()
    expect(await r.text()).toContain('location.replace("/")')
  })

  it('renews the session cookie at most once a day', async () => {
    const t = await boot()
    const { cookie } = await pair(t)
    const a = await rpc(t.base, cookie, 'hello', ['x'])
    expect(a.headers.get('set-cookie')).toContain(`${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=`)
    expect((await rpc(t.base, cookie, 'hello', ['x'])).headers.get('set-cookie')).toBeNull()
  })

  it('tells the phone why a request was refused, and splits big queues', async () => {
    const t = await boot({ maxBody: 1000 })
    const { cookie } = await pair(t)
    const big = await fetch(`${t.base}/batch`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ calls: [{ c: 'hello', a: ['x'.repeat(2000)] }] }) })
    expect(big.status).toBe(413)
    expect((await big.json()).error).toMatch(/too big/)
    const many = await fetch(`${t.base}/batch`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ calls: Array.from({ length: 41 }, () => ({ c: 'hello', a: [] })) }) })
    expect(many.status).toBe(400)

    // the real phone script, run against a fake server
    const sizes: number[] = []
    const win: Record<string, unknown> = { dispatchEvent() {} }
    const fetchFake = async (_u: string, init: { body: string }) => {
      const calls = JSON.parse(init.body).calls
      sizes.push(calls.length)
      return { status: 200, json: async () => (calls[0].c === 'nope' ? { error: 'Too many attempts. Wait a minute.' } : { results: calls.map((c: { a: unknown[] }) => ({ ok: true, result: c.a[0] })) }) }
    }
    const src = shimSource('import { contextBridge, ipcRenderer } from "electron";\ncontextBridge.exposeInMainWorld("forge", { call: (c, ...a) => ipcRenderer.invoke(c, ...a) });')
    new Function('window', 'document', 'fetch', 'EventSource', 'setInterval', 'Event', 'btoa', src)(win, { addEventListener() {}, hidden: false }, fetchFake, class { close() {} }, () => 0, class {}, btoa)
    const forge = win.forge as { call: (c: string, ...a: unknown[]) => Promise<unknown> }
    expect(await Promise.all(Array.from({ length: 45 }, (_, i) => forge.call('x', i)))).toEqual(Array.from({ length: 45 }, (_, i) => i))
    expect(Math.max(...sizes)).toBeLessThanOrEqual(40)
    await expect(forge.call('nope')).rejects.toThrow('Too many attempts')
  })

  it('picks the Tailscale interface over another 100.64/10 address, and listens on the address that was bound', async () => {
    const nic = (address: string) => [{ address, family: 'IPv4', internal: false }]
    nics.list = { wlan0: nic('100.72.5.9'), tailscale0: nic('100.101.1.2') }
    try {
      expect(tailscaleAddress()).toBe('100.101.1.2')
      nics.list = { wlan0: nic('100.72.5.9') }
      expect(tailscaleAddress()).toBe('100.72.5.9') // fallback when nothing is named tailscale
      nics.list = { eth0: nic('192.168.1.5') }
      const dir = mkdtempSync(join(tmpdir(), 'remote-'))
      writeFileSync(join(dir, 'remote.json'), JSON.stringify({ lan: true }))
      const s = new RemoteServer({ dir, rendererDir: dir, preloadFile: join(dir, 'p'), handlers: new Map(), listeners: new Map() })
      expect((s as unknown as { wanted(): string[] }).wanted()).toEqual(['192.168.1.5']) // not 0.0.0.0
      nics.list = { tailscale0: nic('100.101.1.2'), eth0: nic('192.168.1.5') }
      expect((s as unknown as { wanted(): string[] }).wanted()).toEqual(['100.101.1.2', '192.168.1.5'])
      nics.list = {}
      expect(s.status().url).toMatch(/^http:\/\/127\.0\.0\.1:/) // nothing to listen on yet: the real address is shown, not a guess
    } finally { nics.list = null }
  })

  it('shows the address it really listens on when Tailscale comes up later', async () => {
    nics.list = {}
    try {
      const dir = mkdtempSync(join(tmpdir(), 'remote-'))
      srv = new RemoteServer({ dir, rendererDir: dir, preloadFile: join(dir, 'p'), handlers: new Map(), listeners: new Map() })
      await srv.start(0)
      nics.list = { tailscale0: [{ address: '100.101.1.2', family: 'IPv4', internal: false }] }
      expect(srv.status()).toMatchObject({ host: '127.0.0.1', listening: true, tailscale: true })
      expect(srv.status().url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    } finally { nics.list = null }
  })

  it('binds the real Wi-Fi address, not a container or VM bridge', () => {
    const nic = (address: string) => [{ address, family: 'IPv4', internal: false }]
    nics.list = { docker0: nic('172.17.0.1'), virbr0: nic('192.168.122.1'), 'vEthernet (WSL)': nic('172.28.0.1'), wlan0: nic('192.168.1.7') }
    try {
      const dir = mkdtempSync(join(tmpdir(), 'remote-'))
      writeFileSync(join(dir, 'remote.json'), JSON.stringify({ lan: true }))
      const s = new RemoteServer({ dir, rendererDir: dir, preloadFile: join(dir, 'p'), handlers: new Map(), listeners: new Map() })
      expect((s as unknown as { wanted(): string[] }).wanted()).toEqual(['192.168.1.7'])
    } finally { nics.list = null }
  })

  it('tells handlers which paired device called', async () => {
    const seen: unknown[] = []
    const t = await boot({ handlers: new Map([['x:y', (e: unknown) => { seen.push((e as { device?: string }).device) }]]) })
    const { cookie } = await pair(t)
    const id = cookie.split('=')[1].split('.')[0]
    await rpc(t.base, cookie, 'x:y')
    await fetch(`${t.base}/batch`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ calls: [{ c: 'x:y', a: [] }] }) })
    expect(seen).toEqual([id, id])
  })

  it('keeps watching after a rebind fails, and listens once the address is usable', async () => {
    const { createServer } = await import('node:net')
    const free = await new Promise<number>((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    nics.list = { tailscale0: [{ address: '192.0.2.1', family: 'IPv4', internal: false }] } // not an address of this computer: the bind fails
    try {
      const dir = mkdtempSync(join(tmpdir(), 'remote-'))
      writeFileSync(join(dir, 'remote.json'), JSON.stringify({ port: free }))
      srv = new RemoteServer({ dir, rendererDir: dir, preloadFile: join(dir, 'p'), handlers: new Map(), listeners: new Map() })
      await srv.start()
      expect(srv.status().listening).toBe(false)
      nics.list = {} // Tailscale gone: loopback is wanted and can be bound
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(srv!.status()).toMatchObject({ listening: true, host: '127.0.0.1', port: free }))
      expect(srv.status().error).toBeUndefined()
    } finally { vi.useRealTimers(); nics.list = null }
  })
})

// ---- https (a certificate from `tailscale cert`; here a throwaway self-signed one from the openssl command and an injected provider) ----
const hasOpenssl = (() => { try { execFileSync('openssl', ['version']); return true } catch { return false } })()
if (!hasOpenssl) console.warn('openssl is not installed: the https tests in remote.test.ts are skipped')
const NAME = 'forge.tail1234.ts.net'
function selfSigned(days = 30) {
  const d = mkdtempSync(join(tmpdir(), 'cert-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(d, 'k'), '-out', join(d, 'c'), '-days', '365', '-subj', `/CN=${NAME}`, '-addext', `subjectAltName=DNS:${NAME}`], { stdio: 'ignore' })
  return { name: NAME, cert: readFileSync(join(d, 'c'), 'utf8'), key: readFileSync(join(d, 'k'), 'utf8'), notAfter: Date.now() + days * 86400_000 }
}
// Talks to 127.0.0.1 but presents the Tailscale name, as a phone resolving MagicDNS would.
const sget = (url: string, ca: string, o: { method?: string; headers?: Record<string, string>; body?: string; at?: string } = {}) => new Promise<{ status: number; headers: Record<string, unknown>; text: string; fingerprint: string }>((resolve, reject) => {
  const u = new URL(url)
  const req = httpsRequest({ host: o.at ?? '127.0.0.1', port: u.port, path: u.pathname + u.search, method: o.method ?? 'GET', servername: NAME, ca, headers: { host: u.host, ...o.headers } }, (res) => {
    let text = ''
    const fingerprint = (res.socket as import('node:tls').TLSSocket).getPeerCertificate().fingerprint256 // read now: the socket is gone at 'end'
    res.on('data', (c) => (text += c))
    res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text, fingerprint }))
  })
  req.on('error', reject)
  req.end(o.body)
})

describe('remote access over https', () => {
  const secure = hasOpenssl ? it : it.skip

  secure('serves the page over https with a Secure cookie, and puts the https name in the pairing link', async () => {
    const c = selfSigned()
    const tls = vi.fn(async () => c)
    const t = await boot({ tls }, { https: true })
    const st = t.srv.status()
    expect(st).toMatchObject({ https: true, httpsActive: true, listening: true })
    expect(st.httpsError).toBeUndefined()
    expect(st.url).toBe(`https://${NAME}:${st.port}`)
    const link = await t.srv.pairLink()
    expect(link.url).toMatch(new RegExp(`^https://${NAME}:${st.port}/__pair\\?t=`))
    const first = await sget(link.url, c.cert)
    expect(first.status).toBe(200)
    expect(String(first.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/)
    const cookie = String(first.headers['set-cookie']).split(';')[0]
    const origin = `https://${NAME}:${st.port}`
    expect((await sget(`${origin}/`, c.cert)).status).toBe(401)
    const page = await sget(`${origin}/`, c.cert, { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(page.text).toContain('/manifest.webmanifest')
    const manifest = await sget(`${origin}/manifest.webmanifest`, c.cert)
    expect(JSON.parse(manifest.text)).toMatchObject({ start_url: '/' })
    const call = (headers: Record<string, string>) => sget(`${origin}/rpc`, c.cert, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ c: 'hello', a: ['x'] }) })
    expect(JSON.parse((await call({ origin })).text)).toEqual({ ok: true, result: 'hi x' })
    expect((await call({ origin: 'https://evil.example' })).status).toBe(403) // the Origin check still applies
    expect((await call({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    t.srv.revoke(t.srv.status().devices[0].id)
    expect((await call({ origin })).status).toBe(401)
  })

  secure('keeps the plain http listener on this computer only, and https on the Tailscale address', async () => {
    const c = selfSigned()
    nics.list = { tailscale0: [{ address: '127.0.0.2', family: 'IPv4', internal: false }] } // another loopback address stands in for Tailscale
    try {
      const dir = mkdtempSync(join(tmpdir(), 'remote-'))
      writeFileSync(join(dir, 'remote.json'), JSON.stringify({ https: true }))
      srv = new RemoteServer({ dir, rendererDir: dir, preloadFile: join(dir, 'p'), handlers: new Map(), listeners: new Map(), tls: async () => c })
      await srv.start(0)
      const { port, url, httpsActive } = srv.status()
      expect(httpsActive).toBe(true)
      expect(url).toBe(`https://${NAME}:${port}`)
      expect((await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)).status).toBe(200) // plain http, this computer
      await expect(fetch(`http://127.0.0.2:${port}/manifest.webmanifest`)).rejects.toThrow() // not plain http on the Tailscale address
      const r = await sget(`https://${NAME}:${port}/manifest.webmanifest`, c.cert, { at: '127.0.0.2' })
      expect(r.status).toBe(200)
    } finally { nics.list = null }
  })

  it('falls back to http and says why when no certificate can be had', async () => {
    const tls = vi.fn(async () => { throw new Error('HTTPS certificates are not enabled for your tailnet.') })
    const t = await boot({ tls }, { https: true })
    const st = t.srv.status()
    expect(st).toMatchObject({ https: true, httpsActive: false, httpsError: 'HTTPS certificates are not enabled for your tailnet.', listening: true })
    expect(st.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    const { r } = await pair(t)
    expect(r.status).toBe(200)
    expect(r.headers.get('set-cookie')).not.toMatch(/Secure/)
  })

  it('is off by default and never asks for a certificate then', async () => {
    const tls = vi.fn(async () => selfSigned())
    const t = await boot({ tls })
    expect(t.srv.status()).toMatchObject({ https: false, httpsActive: false })
    expect(t.srv.status().httpsError).toBeUndefined()
    expect(tls).not.toHaveBeenCalled()
    expect(t.base).toMatch(/^http:/)
  })

  it('shows a reason when https is wanted but Tailscale has no address yet', async () => {
    nics.list = {}
    try {
      const dir = mkdtempSync(join(tmpdir(), 'remote-'))
      writeFileSync(join(dir, 'remote.json'), JSON.stringify({ https: true }))
      srv = new RemoteServer({ dir, rendererDir: dir, preloadFile: join(dir, 'p'), handlers: new Map(), listeners: new Map(), tls: async () => selfSigned() })
      await srv.start(0)
      expect(srv.status()).toMatchObject({ httpsActive: false, httpsError: expect.stringMatching(/no address/) })
      expect(srv.status().url).toMatch(/^http:/)
    } finally { nics.list = null }
  })

  it('remembers the setting and passes it through configure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-'))
    const s = new RemoteServer({ dir, rendererDir: dir, preloadFile: join(dir, 'p'), handlers: new Map(), listeners: new Map(), bind: '127.0.0.1' })
    expect((await s.configure({ https: true })).https).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'remote.json'), 'utf8')).https).toBe(true)
    expect(new RemoteServer({ dir, rendererDir: dir, preloadFile: join(dir, 'p'), handlers: new Map(), listeners: new Map() }).status().https).toBe(true)
  })

  secure('renews a certificate with under 14 days left, every 12 hours, without a restart', async () => {
    const old = selfSigned(5)
    const next = selfSigned(90)
    const tls = vi.fn(async () => (tls.mock.calls.length === 1 ? old : next))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const t = await boot({ tls }, { https: true })
      const origin = `https://${NAME}:${t.srv.status().port}`
      expect((await sget(`${origin}/manifest.webmanifest`, old.cert)).fingerprint).toBeTruthy()
      await vi.advanceTimersByTimeAsync(12 * 3600_000)
      expect(tls).toHaveBeenCalledTimes(2)
      const r = await sget(`${origin}/manifest.webmanifest`, next.cert) // the new certificate is the one presented now
      expect(r.status).toBe(200)
      await vi.advanceTimersByTimeAsync(12 * 3600_000)
      expect(tls).toHaveBeenCalledTimes(2) // 90 days left: nothing to do
    } finally { vi.useRealTimers() }
  })

  secure('keeps the old certificate and reports it when renewing fails, and goes to https once it can', async () => {
    const c = selfSigned(5)
    let n = 0
    const tls = vi.fn(async () => { n++; if (n === 2) throw new Error('Tailscale is not running. Start Tailscale and sign in.'); return n === 1 ? c : selfSigned(90) })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const t = await boot({ tls }, { https: true })
      await vi.advanceTimersByTimeAsync(12 * 3600_000)
      expect(t.srv.status()).toMatchObject({ httpsActive: true, httpsError: expect.stringMatching(/not running/) })
      expect((await sget(`https://${NAME}:${t.srv.status().port}/manifest.webmanifest`, c.cert)).status).toBe(200)
    } finally { vi.useRealTimers() }
  })

  secure('starts https at the next check when it could not at start', async () => {
    const c = selfSigned()
    let n = 0
    const tls = vi.fn(async () => { if (n++ === 0) throw new Error('Tailscale is not running. Start Tailscale and sign in.'); return c })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const t = await boot({ tls }, { https: true })
      expect(t.srv.status()).toMatchObject({ httpsActive: false, httpsError: expect.stringMatching(/not running/) })
      await vi.advanceTimersByTimeAsync(12 * 3600_000)
      await vi.waitFor(() => expect(t.srv.status()).toMatchObject({ httpsActive: true }))
      expect(t.srv.status().httpsError).toBeUndefined()
    } finally { vi.useRealTimers() }
  })
})
