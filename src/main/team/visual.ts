import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Visual check: screenshots of a run's pages at desktop and phone sizes, for the reviewer. Pure and injectable: the real
// capture (a hidden Electron window) lives in registerPreviewCrew.ts, so everything here runs under plain node.

export type Size = { name: string; width: number; height: number; mobile?: boolean }
export const DEFAULT_SIZES: Size[] = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844, mobile: true }]
export const MAX_ROUTES = 8
export const MAX_SIZES = 2
export const CAPTURE_TIMEOUT_MS = 20_000

export type Shot = { route: string; size: string; path: string }
export type ShotFailure = { route: string; size: string; error: string }
export type Capture = (url: string, size: Size) => Promise<Buffer>

// Routes are paths on the run's own server. A leading "//" would make the URL point at another host, so it is never trusted.
export function routeUrl(baseUrl: string, route: string): string {
  const base = new URL(baseUrl)
  const u = new URL('/' + route.trim().replace(/^\/+/, ''), base)
  if (u.origin !== base.origin) throw new Error(`Not a page of this website: ${route}`)
  return u.href
}

export const routeSlug = (route: string) => route.replace(/^\/+|\/+$/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'home'

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`Took longer than ${Math.round(ms / 1000)} s`)), ms) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

export async function captureRoutes(o: { baseUrl: string; routes?: string[]; sizes?: Size[]; outDir: string; capture: Capture; timeoutMs?: number }): Promise<{ shots: Shot[]; failures: ShotFailure[] }> {
  const routes = [...new Set((o.routes?.length ? o.routes : ['/']).map((r) => String(r)))].slice(0, MAX_ROUTES)
  const sizes = (o.sizes?.length ? o.sizes : DEFAULT_SIZES).slice(0, MAX_SIZES)
  const shots: Shot[] = []
  const failures: ShotFailure[] = []
  const slugs = new Set<string>()
  mkdirSync(o.outDir, { recursive: true })
  for (const route of routes) {
    let slug = routeSlug(route)
    for (let n = 2; slugs.has(slug); n++) slug = `${routeSlug(route)}-${n}` // /a/b and /a-b both slug to a-b
    slugs.add(slug)
    for (const size of sizes) {
      try {
        const png = await withTimeout(o.capture(routeUrl(o.baseUrl, route), size), o.timeoutMs ?? CAPTURE_TIMEOUT_MS)
        const path = join(o.outDir, `${slug}-${size.name}.png`)
        writeFileSync(path, png)
        shots.push({ route, size: size.name, path })
      } catch (e) {
        failures.push({ route, size: size.name, error: (e as Error).message })
      }
    }
  }
  return { shots, failures }
}

// Text for the final-review prompt; the reviewer opens the files itself. Empty when there is nothing to look at.
export function reviewImagesBlock(shots: Shot[], references: string[] = []): string {
  if (!shots.length && !references.length) return ''
  const lines = ['## Screenshots of the running website', '']
  for (const s of shots) lines.push(`- ${s.path} (page ${s.route}, ${s.size})`)
  for (const r of references) lines.push(`- Reference design: ${r}`)
  lines.push('', 'Open every image above. Compare layout, spacing, colour, text overflow and phone usability' + (references.length ? ', and compare the screenshots with the reference design' : '') + '. Report concrete differences and defects (which page, which size, what is wrong, what it should look like), not general impressions. If a screenshot looks fine, say so in one line.')
  return lines.join('\n')
}

// The renderer measures in CSS pixels; a native view is placed in window pixels, which differ by the page zoom (Forge opens at 107%).
export const scaleBounds = (b: { x: number; y: number; width: number; height: number }, zoom: number) => ({ x: Math.round(b.x * zoom), y: Math.round(b.y * zoom), width: Math.round(b.width * zoom), height: Math.round(b.height * zoom) })
