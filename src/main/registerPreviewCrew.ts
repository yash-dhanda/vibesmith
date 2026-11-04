import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { BrowserWindow, ipcMain, nativeImage } from 'electron'
import type { Bounds, PreviewViews } from './previewView'
import { captureRoutes, MAX_ROUTES, scaleBounds, type Size } from './team/visual'

// The Crew run screen's website preview (a native view laid over a placeholder box, keyed `crew:<runId>` in the shared PreviewViews)
// and the visual check (hidden-window screenshots of the run's pages). Show/hide/reload/detach reuse the existing preview:* channels.

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]'])
const SETTLE_MS = 900 // after the page has loaded, let late scripts and fonts finish
const IDLE_MAX_MS = 6000 // ...and wait for the network to go quiet, but never longer than this
const HARD_LIMIT_MS = 19_000 // under captureRoutes' own 20 s, so this one tears the window down

export async function electronCapture(url: string, size: Size): Promise<Buffer> {
  const u = new URL(url)
  if (u.protocol !== 'http:' || !LOCAL.has(u.hostname)) throw new Error('Only a page running on this computer can be checked.')
  const win = new BrowserWindow({ show: false, width: size.width, height: size.height, useContentSize: true, webPreferences: { offscreen: true, partition: `visual-${randomUUID()}`, nodeIntegration: false, contextIsolation: true, sandbox: true } })
  const wc = win.webContents
  const hard = setTimeout(() => win.destroy(), HARD_LIMIT_MS) // makes loadURL / capturePage fail instead of hanging
  try {
    let pending = 0
    const web = wc.session.webRequest
    web.onBeforeRequest((_d, cb) => (pending++, cb({})))
    web.onCompleted(() => { pending = Math.max(0, pending - 1) })
    web.onErrorOccurred(() => { pending = Math.max(0, pending - 1) })
    wc.session.setPermissionRequestHandler((_w, _p, cb) => cb(false))
    wc.session.on('will-download', (e) => e.preventDefault())
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e, to) => { if (new URL(to).origin !== u.origin) e.preventDefault() })
    if (size.mobile) wc.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: size.width, height: size.height }, viewPosition: { x: 0, y: 0 }, viewSize: { width: size.width, height: size.height }, deviceScaleFactor: 2, scale: 1 })
    else win.setContentSize(size.width, size.height)
    await wc.loadURL(url)
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    for (let waited = 0, quiet = 0; waited < IDLE_MAX_MS && quiet < 2; waited += 200) { // two quiet checks in a row
      await new Promise((r) => setTimeout(r, 200))
      quiet = pending === 0 ? quiet + 1 : 0
    }
    return (await wc.capturePage()).toPNG()
  } finally {
    clearTimeout(hard)
    if (!win.isDestroyed()) win.destroy()
  }
}

type AppResult = { ok: boolean; message: string; url?: string }
export type PreviewCrewDeps = {
  getWin: () => BrowserWindow | null
  views: PreviewViews
  runApp: (runId: string) => Promise<AppResult> // the team service's runApp: starts the run's dev server (or reports the running one)
  shotsDir: (runId: string) => string
}

export function registerPreviewCrew(d: PreviewCrewDeps) {
  const id = (v: unknown) => {
    if (typeof v !== 'string' || !/^[\w-]{1,60}$/.test(v)) throw new Error('bad id')
    return v
  }
  // The page is zoomed (107%), so CSS pixels the renderer measured are not window pixels.
  const place = (b: Bounds) => scaleBounds(b, d.getWin()?.webContents.getZoomFactor() ?? 1)

  ipcMain.handle('preview:crew-attach', (_e, runId: unknown, url: unknown, bounds: Bounds) => d.views.attach(`crew:${id(runId)}`, String(url), place(bounds)))
  ipcMain.on('preview:crew-bounds', (_e, runId: unknown, bounds: Bounds) => d.views.setBounds(`crew:${id(runId)}`, place(bounds)))

  ipcMain.handle('team:visual-check', async (_e, runId: unknown, routes?: unknown) => {
    const run = id(runId)
    const app = await d.runApp(run)
    if (!app.ok || !app.url) throw new Error(app.message || 'The website did not start, so there is nothing to check.')
    const list = (Array.isArray(routes) ? routes : []).filter((r): r is string => typeof r === 'string' && r.length > 0 && r.length <= 200).slice(0, MAX_ROUTES)
    const outDir = d.shotsDir(run)
    rmSync(outDir, { recursive: true, force: true }) // only the shots of this check
    const { shots, failures } = await captureRoutes({ baseUrl: app.url, routes: list, outDir, capture: electronCapture })
    const withThumbs = await Promise.all(shots.map(async (s) => ({ ...s, thumb: nativeImage.createFromBuffer(await readFile(s.path)).resize({ width: 360 }).toDataURL() })))
    return { url: app.url, shots: withThumbs, failures }
  })
}
