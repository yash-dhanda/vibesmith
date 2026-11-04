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
  const handlers = new Map<string, (e: any, ...a: any[]) => unknown>([['hello', (_e, n) => `hi ${n}`], ['boom', () => { throw new Error('nope') }], ['project:pick', () => 'x'], ['ping', (e) => { e.sender.send('pong', 1) }]])
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
  })
})
