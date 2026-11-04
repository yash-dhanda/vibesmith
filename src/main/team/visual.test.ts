import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureRoutes, reviewImagesBlock, routeSlug, routeUrl, scaleBounds, type Capture } from './visual'

const dir = () => mkdtempSync(join(tmpdir(), 'forge-visual-'))
const fake: Capture = async (url, size) => Buffer.from(`${url}|${size.name}`)

describe('captureRoutes', () => {
  it('writes <route-slug>-<size>.png for every route and size', async () => {
    const outDir = dir()
    const { shots, failures } = await captureRoutes({ baseUrl: 'http://localhost:5173', routes: ['/', '/about', '/shop/cart/'], outDir, capture: fake })
    expect(failures).toEqual([])
    expect(readdirSync(outDir).sort()).toEqual(['about-desktop.png', 'about-phone.png', 'home-desktop.png', 'home-phone.png', 'shop-cart-desktop.png', 'shop-cart-phone.png'])
    expect(shots).toHaveLength(6)
    expect(readFileSync(shots[2].path, 'utf8')).toBe('http://localhost:5173/about|desktop')
  })

  it('defaults to the home page and the two standard sizes, and passes the phone as mobile', async () => {
    const seen: string[] = []
    await captureRoutes({ baseUrl: 'http://127.0.0.1:3000/app', outDir: dir(), capture: async (u, s) => (seen.push(`${u} ${s.width}x${s.height}${s.mobile ? ' mobile' : ''}`), Buffer.from('x')) })
    expect(seen).toEqual(['http://127.0.0.1:3000/ 1440x900', 'http://127.0.0.1:3000/ 390x844 mobile'])
  })

  it('limits to 8 routes and 2 sizes and keeps colliding slugs apart', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `/p${i}`)
    const r = await captureRoutes({ baseUrl: 'http://localhost:1', routes: many, sizes: [{ name: 'a', width: 1, height: 1 }, { name: 'b', width: 1, height: 1 }, { name: 'c', width: 1, height: 1 }], outDir: dir(), capture: fake })
    expect(r.shots).toHaveLength(16)
    const same = await captureRoutes({ baseUrl: 'http://localhost:1', routes: ['/a/b', '/a-b'], outDir: dir(), capture: fake })
    expect(new Set(same.shots.map((s) => s.path)).size).toBe(4)
  })

  it('collects failures and timeouts instead of throwing, and keeps going', async () => {
    const capture: Capture = async (url, size) => {
      if (url.endsWith('/bad')) throw new Error('boom')
      if (url.endsWith('/slow')) return new Promise<Buffer>(() => {})
      return fake(url, size)
    }
    const r = await captureRoutes({ baseUrl: 'http://localhost:1', routes: ['/bad', '/slow', '/ok'], sizes: [{ name: 'desktop', width: 1, height: 1 }], outDir: dir(), capture, timeoutMs: 50 })
    expect(r.shots.map((s) => s.route)).toEqual(['/ok'])
    expect(r.failures.map((f) => [f.route, f.error])).toEqual([['/bad', 'boom'], ['/slow', 'Took longer than 0 s']])
  })

  it('keeps every route on the website', () => {
    expect(routeUrl('http://localhost:1', '//evil.example/x')).toBe('http://localhost:1/evil.example/x') // "//" is trimmed to a path on this host
    expect(routeUrl('http://localhost:1', 'a b?x=1')).toBe('http://localhost:1/a%20b?x=1')
    expect(() => routeUrl('http://localhost:1', '/\\evil.example')).toThrow(/Not a page/) // a backslash reads as "/" in a URL
  })

  it('slugs routes', () => {
    expect([routeSlug('/'), routeSlug('/About Us/'), routeSlug('/a?b=1')]).toEqual(['home', 'about-us', 'a-b-1'])
  })
})

describe('reviewImagesBlock', () => {
  it('lists screenshots and references with the comparison instructions', () => {
    const t = reviewImagesBlock([{ route: '/', size: 'phone', path: '/x/home-phone.png' }], ['/refs/design.png'])
    expect(t).toContain('/x/home-phone.png (page /, phone)')
    expect(t).toContain('Reference design: /refs/design.png')
    expect(t).toMatch(/layout, spacing, colour, text overflow and phone usability/)
    expect(t).toMatch(/concrete differences/)
  })
  it('is empty when there is nothing to show', () => expect(reviewImagesBlock([], [])).toBe(''))
})

describe('end to end against a local server', () => {
  it('resolves routes to the right pages', async () => {
    const server = createServer((req, res) => res.end(req.url === '/pricing' ? '<h1>Pricing</h1>' : '<h1>Home</h1>'))
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
      const capture: Capture = async (url) => Buffer.from(await (await fetch(url)).text())
      const outDir = dir()
      const { shots, failures } = await captureRoutes({ baseUrl: base, routes: ['/', 'pricing'], sizes: [{ name: 'desktop', width: 1440, height: 900 }], outDir, capture })
      expect(failures).toEqual([])
      expect(shots.map((s) => readFileSync(s.path, 'utf8'))).toEqual(['<h1>Home</h1>', '<h1>Pricing</h1>'])
    } finally {
      server.close()
    }
  })
})

describe('scaleBounds', () => {
  it('converts CSS pixels to window pixels at the page zoom', () => expect(scaleBounds({ x: 100, y: 50, width: 400, height: 300 }, 1.07)).toEqual({ x: 107, y: 54, width: 428, height: 321 }))
})
