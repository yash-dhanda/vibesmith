import { createServer, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { resolveIn } from './project'

// Live preview of a web project the agent built: a tiny static server on 127.0.0.1, jailed to the project folder.
// The page is shown in the app (sandboxed iframe) or the user's browser, and reloads itself when the agent changes a file.
// ponytail: static files only. Projects that need `npm run dev` get a "run it yourself" message; add a process runner if that matters.

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
}
const RELOAD = '<script>new EventSource("/__forge/events").onmessage=function(){location.reload()}</script>'

export class PreviewServer {
  private server: Server | null = null
  private clients = new Set<ServerResponse>()
  private timer: NodeJS.Timeout | null = null
  private starting: Promise<string> | null = null // two start() calls in one tick must share one server
  private epoch = 0 // bumped by stop(), so a start() still in flight can tell it was cancelled
  url = ''

  constructor(private root: string) {}

  start(): Promise<string> {
    if (this.server) return Promise.resolve(this.url)
    if (this.starting) return this.starting
    const p: Promise<string> = this.listen().finally(() => this.starting === p && (this.starting = null))
    return (this.starting = p)
  }

  private async listen(): Promise<string> {
    const epoch = this.epoch
    const entry = await stat(join(this.root, 'index.html')).catch(() => null)
    if (!entry?.isFile()) throw new Error('Nothing to preview yet: this project has no index.html.')
    const server = createServer((req, res) => void this.handle(req.url ?? '/', req.headers.host ?? '', res))
    await new Promise<void>((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok))
    if (epoch !== this.epoch) { // stop() ran while we were starting: nobody holds this server any more, so it would listen forever
      server.close()
      throw new Error('The preview was stopped.')
    }
    this.server = server
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    return this.url
  }

  // Tell open pages to reload. Many edits in a row become one reload.
  reload() {
    if (!this.clients.size || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      for (const c of this.clients) c.write('data: reload\n\n')
    }, 200)
  }

  stop() {
    this.epoch++
    this.starting = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const c of this.clients) c.end()
    this.clients.clear()
    this.server?.close()
    this.server = null
    this.url = ''
  }

  private async handle(rawUrl: string, host: string, res: ServerResponse) {
    const fail = (code: number, msg: string) => res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }).end(msg)
    // A page on another site must not be able to read the project through this port (DNS rebinding).
    if (!this.url || host !== new URL(this.url).host) return fail(403, 'forbidden')
    let path: string
    let url: URL
    try {
      url = new URL(rawUrl, this.url)
      path = decodeURIComponent(url.pathname)
    } catch {
      return fail(400, 'bad request')
    }
    if (path === '/__forge/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(': connected\n\n')
      this.clients.add(res)
      res.on('close', () => this.clients.delete(res))
      return
    }
    if (/(^|\/)\./.test(path)) return fail(404, 'not found') // dotfiles and dot folders stay private
    try {
      let file = resolveIn(this.root, path.replace(/^\/+/, '') || '.')
      if ((await stat(file)).isDirectory()) {
        // /sub must become /sub/, or the page's relative links (style.css) resolve against the parent folder. Relative Location: never leaves this host.
        if (!path.endsWith('/')) return void res.writeHead(301, { location: `./${url.pathname.split('/').pop()}/${url.search}` }).end()
        file = join(file, 'index.html')
      }
      const type = TYPES[extname(file).slice(1).toLowerCase()]
      if (!type) return fail(404, 'not found') // only web file types are served: never .env, keys or sources of other kinds
      let body = await readFile(file)
      if (type.startsWith('text/html')) body = Buffer.from(body.toString('utf8') + RELOAD)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(body)
    } catch {
      fail(404, 'not found')
    }
  }
}
