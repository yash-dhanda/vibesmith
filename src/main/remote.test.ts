import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteServer, shimSource } from './remote'

let srv: RemoteServer | null = null
afterEach(async () => { await srv?.stop(); srv = null })

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-'))
  const rendererDir = join(dir, 'renderer')
  mkdirSync(rendererDir)
  writeFileSync(join(rendererDir, 'index.html'), '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body>forge</body></html>')
  writeFileSync(join(rendererDir, 'app.js'), 'console.log(1)')
  const preloadFile = join(dir, 'preload.mjs')
  writeFileSync(preloadFile, 'import { contextBridge, ipcRenderer } from "electron";\ncontextBridge.exposeInMainWorld("forge", { hello: (n) => ipcRenderer.invoke("hello", n) });')
  const sent: unknown[][] = []
  const handlers = new Map<string, (e: any, ...a: any[]) => unknown>([['hello', (_e, n) => `hi ${n}`], ['boom', () => { throw new Error('nope') }], ['project:pick', () => 'x'], ['ping', (e) => { e.sender.send('pong', 1) }], ['bytes', (_e, files: any) => files.map((f: any) => `${f.name}:${f.data instanceof Uint8Array}:${f.data.length}`)]])
  const listeners = new Map<string, ((e: any, ...a: any[]) => void)[]>([['note', [(_e, ...a) => { sent.push(a) }]]])
  srv = new RemoteServer({ dir, rendererDir, preloadFile, handlers, listeners, bind: '127.0.0.1' })
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
    expect(first.status).toBe(302)
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie).toMatch(/^forge_session=/)
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(403) // the link was good once only
    expect(await (await rpc(t.base, cookie, 'hello', ['phone'])).json()).toEqual({ ok: true, result: 'hi phone' })
    expect(await (await rpc(t.base, cookie, 'boom')).json()).toEqual({ ok: false, error: 'nope' })
    expect((await rpc(t.base, cookie, 'project:pick')).status).toBe(403)
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
    expect(first.status).toBe(302)
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
    expect(shimSource('import { contextBridge, ipcRenderer } from "electron";\nexposeIt();\nexport {};\n')).not.toMatch(/export\s*\{/)
  })
})
