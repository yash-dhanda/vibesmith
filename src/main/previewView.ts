import { BrowserWindow, session, shell, WebContentsView } from 'electron'

// The preview pane inside the app: a separate, sandboxed web view laid over the chat window. It has no preload and its
// own throwaway session, so the project's scripts cannot reach Forge's bridge, the shell's storage or anything else of Forge's.

export type Bounds = { x: number; y: number; width: number; height: number }
export type ViewStatus = { chatId: string; state: 'loading' | 'ready' | 'error' | 'closed'; url: string; title: string; error?: string }

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]'])
const clampBounds = (b: Bounds): Bounds => ({ x: Math.max(0, Math.round(b.x)), y: Math.max(0, Math.round(b.y)), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) })

export class PreviewViews {
  private views = new Map<string, { view: WebContentsView; origin: string }>()

  constructor(private getWin: () => BrowserWindow | null, private send: (s: ViewStatus) => void) {}

  attach(chatId: string, url: string, bounds: Bounds) {
    const win = this.getWin()
    if (!win) throw new Error('No window to show the preview in.')
    const u = new URL(url)
    if (u.protocol !== 'http:' || !LOCAL.has(u.hostname)) throw new Error('Only a page running on this computer can be previewed here.')
    const have = this.views.get(chatId)
    if (have && have.origin === u.origin) return this.setBounds(chatId, bounds)
    this.detach(chatId)

    const ses = session.fromPartition('forge-preview') // not persistent: nothing the page stores outlives the app
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.on('will-download', (e) => e.preventDefault())
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target) // links that open a new window go to the real browser
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e, to) => {
      try {
        if (new URL(to).origin !== u.origin) (e.preventDefault(), /^https?:\/\//i.test(to) && void shell.openExternal(to)) // the pane stays on the project
      } catch {
        e.preventDefault()
      }
    })
    const status = (state: ViewStatus['state'], error?: string) => this.send({ chatId, state, url: wc.getURL(), title: wc.getTitle(), ...(error ? { error } : {}) })
    wc.on('did-start-loading', () => status('loading'))
    wc.on('did-finish-load', () => status('ready'))
    wc.on('page-title-updated', () => status('ready'))
    wc.on('did-fail-load', (_e, code, desc, _u, isMain) => isMain && code !== -3 && status('error', desc)) // -3 = cancelled by a newer load

    win.contentView.addChildView(view)
    view.setBounds(clampBounds(bounds))
    this.views.set(chatId, { view, origin: u.origin })
    void wc.loadURL(url).catch(() => {})
  }

  setBounds(chatId: string, bounds: Bounds) {
    this.views.get(chatId)?.view.setBounds(clampBounds(bounds))
  }

  // Menus, dialogs and the command palette are drawn by the page, which a native view would cover: hide it while they are open.
  setVisible(chatId: string, visible: boolean) {
    this.views.get(chatId)?.view.setVisible(visible)
  }

  reload(chatId: string) {
    this.views.get(chatId)?.view.webContents.reloadIgnoringCache()
  }

  detach(chatId: string) {
    const v = this.views.get(chatId)
    if (!v) return
    this.views.delete(chatId)
    try {
      this.getWin()?.contentView.removeChildView(v.view)
      v.view.webContents.close()
    } catch {}
    this.send({ chatId, state: 'closed', url: '', title: '' })
  }

  detachAll() {
    for (const id of [...this.views.keys()]) this.detach(id)
  }
}
