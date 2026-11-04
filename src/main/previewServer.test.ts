import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PreviewServer } from './previewServer'

let dir: string
let srv: PreviewServer
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-prev-'))
  writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>')
  writeFileSync(join(dir, 'app.js'), 'x=1')
  writeFileSync(join(dir, '.env'), 'SECRET=1')
  writeFileSync(join(dir, 'notes.py'), 'print(1)')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'index.html'), 'sub')
  srv = new PreviewServer(dir)
})
afterEach(() => srv.stop())

const get = async (path: string, headers?: Record<string, string>) => {
  const r = await fetch(srv.url.slice(0, -1) + path, { headers })
  return { status: r.status, text: await r.text(), type: r.headers.get('content-type') }
}

describe('PreviewServer', () => {
  it('two starts in the same tick share one server', async () => {
    const [a, b] = await Promise.all([srv.start(), srv.start()])
    expect(a).toBe(b)
    expect((await get('/')).status).toBe(200)
    expect(srv.url).toBe(a)
    expect((await fetch(a)).status).toBe(200)
  })

  it('a request that arrives after stop is refused instead of throwing', async () => {
    await srv.start()
    const rejections: unknown[] = []
    const on = (e: unknown) => rejections.push(e)
    process.on('unhandledRejection', on)
    const handle = (srv as unknown as { handle: (u: string, h: string, r: unknown) => Promise<void> }).handle.bind(srv)
    srv.stop()
    const res = { writeHead: () => ({ end: () => {} }) }
    await handle('/', '127.0.0.1:1', res)
    process.off('unhandledRejection', on)
    expect(rejections).toEqual([])
  })

  it('refuses to start without an index.html', async () => {
    writeFileSync(join(dir, 'index.html'), '')
    const empty = new PreviewServer(mkdtempSync(join(tmpdir(), 'forge-empty-')))
    await expect(empty.start()).rejects.toThrow(/no index.html/)
  })

  it('serves pages with the reload script, assets and folder indexes', async () => {
    await srv.start()
    const page = await get('/')
    expect(page.status).toBe(200)
    expect(page.text).toContain('<h1>hi</h1>')
    expect(page.text).toContain('/__forge/events')
    expect((await get('/app.js')).type).toContain('javascript')
    expect((await get('/sub/')).text).toContain('sub')
  })

  it('keeps private and non-web files out, and the jail closed', async () => {
    await srv.start()
    expect((await get('/.env')).status).toBe(404)
    expect((await get('/notes.py')).status).toBe(404)
    expect((await get('/..%2f..%2fetc%2fpasswd')).status).toBe(404)
    symlinkSync('/etc/hostname', join(dir, 'link.txt'))
    expect((await get('/link.txt')).status).toBe(404)
  })

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    await srv.start()
    const r = await new Promise<number>((ok) => {
      import('node:http').then(({ request }) => {
        const u = new URL(srv.url)
        request({ host: u.hostname, port: u.port, path: '/', headers: { host: 'evil.example' } }, (res) => ok(res.statusCode ?? 0)).end()
      })
    })
    expect(r).toBe(403)
  })

  it('stop() during start() does not leave a server listening', async () => {
    const starting = srv.start()
    srv.stop()
    await expect(starting).rejects.toThrow(/stopped/)
    expect(srv.url).toBe('')
    expect(await srv.start()).toMatch(/^http/) // and it can be started again afterwards
  })

  it('redirects a folder to its trailing-slash form so relative links work, without leaking dot folders', async () => {
    await srv.start()
    mkdirSync(join(dir, '.git'))
    const r = await fetch(srv.url + 'sub?x=1', { redirect: 'manual' })
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('./sub/?x=1')
    expect((await fetch(srv.url + '.git', { redirect: 'manual' })).status).toBe(404)
  })
})
