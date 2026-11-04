import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PushNotifier, checkServer } from './notify'

type Got = { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; body: string }
let srv: Server | null = null
afterEach(async () => { vi.useRealTimers(); await new Promise<void>((r) => (srv ? srv.close(() => r()) : r())); srv = null })

// A local stand-in for ntfy. The sandbox may forbid listening sockets; these tests then fail with EPERM.
async function ntfy(status = 200, delay = 0) {
  const got: Got[] = []
  srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => { got.push({ method: req.method, url: req.url, headers: req.headers, body }); setTimeout(() => { res.writeHead(status); res.end('{}') }, delay) })
  })
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r))
  return { got, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` }
}
const make = (dir = mkdtempSync(join(tmpdir(), 'push-'))) => ({ dir, n: new PushNotifier(dir) })

describe('push settings', () => {
  it('starts off, with a random url-safe topic that is kept', () => {
    const { dir, n } = make()
    const s = n.get()
    expect(s).toMatchObject({ enabled: false, server: 'https://ntfy.sh', includeProject: false })
    expect(s.topic).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(new PushNotifier(dir).get().topic).toBe(s.topic)
    expect(statSync(join(dir, 'push.json')).mode & 0o777).toBe(0o600)
    expect(n.newTopic().topic).not.toBe(s.topic)
    expect(JSON.parse(readFileSync(join(dir, 'push.json'), 'utf8')).topic).toBe(n.get().topic)
  })

  it('takes https servers, and http only for this computer', () => {
    const { n } = make()
    expect(n.set({ server: 'https://ntfy.example.org/base/' }).server).toBe('https://ntfy.example.org/base')
    expect(n.set({ server: 'http://localhost:8080' }).server).toBe('http://localhost:8080')
    expect(n.set({ server: 'http://127.0.0.1:9' }).server).toBe('http://127.0.0.1:9')
    for (const bad of ['http://ntfy.sh', 'http://192.168.1.5', 'ftp://x', 'ntfy.sh', '']) expect(() => n.set({ server: bad })).toThrow()
    expect(n.get().server).toBe('http://127.0.0.1:9') // a refused value changes nothing
    expect(() => checkServer('javascript:alert(1)')).toThrow()
  })

  it('does not trust an http server written into the file by hand', async () => {
    const t = await ntfy()
    const dir = mkdtempSync(join(tmpdir(), 'push-'))
    writeFileSync(join(dir, 'push.json'), JSON.stringify({ enabled: true, server: 'http://example.com', topic: 'abcdefghijklmnopqrstuvwx' }))
    const n = new PushNotifier(dir)
    expect(n.get().server).toBe('https://ntfy.sh')
    n.set({ enabled: true })
    ;(n as unknown as { s: { server: string } }).s.server = 'http://example.com'
    expect(await n.test()).toEqual({ ok: false, error: expect.stringMatching(/https/) })
    expect(t.got).toHaveLength(0)
  })
})

describe('push messages', () => {
  it('posts to server/topic with title, priority and a generic body, and nothing else', async () => {
    const t = await ntfy()
    const { n } = make()
    n.set({ server: t.url, enabled: true })
    expect(await n.event('question')).toEqual({ ok: true })
    expect(t.got).toHaveLength(1)
    const g = t.got[0]
    expect(g.method).toBe('POST')
    expect(g.url).toBe(`/${n.get().topic}`)
    expect(g.headers.title).toBe('Forge')
    expect(g.headers.priority).toBe('high')
    expect(g.body).toBe('Crew needs your answer')
    expect(Object.keys(g.headers).sort()).not.toContain('click')
  })

  it('sends Click when given a link', async () => {
    const t = await ntfy()
    const { n } = make()
    n.set({ server: t.url })
    await n.send({ title: 'T', body: 'B', url: 'https://box.ts.net:8787', priority: 'low', key: 'x' })
    expect(t.got[0].headers).toMatchObject({ click: 'https://box.ts.net:8787', priority: 'low', title: 'T' })
  })

  it('says only the fixed sentences: the project is a folder name when asked for, never a path', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
    const t = await ntfy()
    const { n } = make()
    n.set({ server: t.url, enabled: true })
    const project = '/home/me/secret-client/app'
    for (const kind of ['question', 'finished', 'attention', 'chatQuestion', 'chatDone'] as const) { await n.event(kind, project); vi.setSystemTime(Date.now() + 6000) }
    expect(t.got.map((g) => g.body)).toEqual(['Crew needs your answer', 'Crew run finished', 'Crew run needs attention', 'Forge needs your approval', 'Forge finished'])
    n.set({ includeProject: true })
    await n.event('finished', project)
    expect(t.got.at(-1)!.body).toBe('Crew run finished · app')
    for (const g of t.got) { expect(g.body).not.toContain('/home'); expect(g.body).not.toContain('secret-client'); expect(JSON.stringify(g.headers)).not.toContain('secret') }
  })

  it('sends nothing while it is off, but a test always goes out', async () => {
    const t = await ntfy()
    const { n } = make()
    n.set({ server: t.url })
    expect((await n.event('finished')).ok).toBe(false)
    expect(t.got).toHaveLength(0)
    expect(await n.test()).toEqual({ ok: true })
    expect(t.got[0].body).toMatch(/test/i)
  })

  it('sends one message per 5 seconds for the same kind', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
    const t = await ntfy()
    const { n } = make()
    n.set({ server: t.url, enabled: true })
    expect((await n.event('question')).ok).toBe(true)
    expect(await n.event('question')).toEqual({ ok: false, error: expect.stringMatching(/Wait \d seconds/) })
    expect((await n.event('finished')).ok).toBe(true) // another kind has its own slot
    vi.setSystemTime(Date.now() + 5001)
    expect((await n.event('question')).ok).toBe(true)
    expect(t.got).toHaveLength(3)
  })
})

describe('push failures', () => {
  it('returns the error instead of throwing', async () => {
    const { n } = make()
    n.set({ server: 'http://127.0.0.1:1' }) // nothing listens there
    const r = await n.test()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Could not reach the push server/)
    const bad = await ntfy(500)
    n.set({ server: bad.url })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 })
    expect(await n.test()).toEqual({ ok: false, error: 'The push server answered 500.' })
  })

  it('gives up after 5 seconds', async () => {
    const t = await ntfy(200, 6000)
    const { n } = make()
    n.set({ server: t.url })
    const r = await n.test()
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/within 5 seconds/) })
  }, 15_000)
})
