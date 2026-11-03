import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { patientFetch } from './net'
import { getHost } from './ollamaHost'

// The AI engine is Ollama. Forge uses one that is already running; if there is none it can download the official build
// into its own folder and run it privately. Nothing is installed system-wide, and removing the Forge data folder removes it.

export type Asset = { name: string; browser_download_url: string; size: number; digest?: string }

// The official release assets for this system. Only the main archive: not the AMD, Jetson or checksum files.
export function pickAsset(assets: Asset[], platform: NodeJS.Platform, arch: string): Asset | null {
  const a = arch === 'arm64' ? 'arm64' : 'amd64'
  const re = platform === 'linux' ? new RegExp(`^ollama-linux-${a}\\.(tar\\.zst|tgz|tar\\.gz)$`) : platform === 'win32' ? new RegExp(`^ollama-windows-${a}\\.zip$`) : null
  if (!re) return null
  const hits = assets.filter((x) => re.test(x.name))
  return hits.find((x) => x.name.endsWith('.tgz') || x.name.endsWith('.tar.gz')) ?? hits[0] ?? null // gzip is extractable everywhere; zstd needs the zstd tool
}

export const expectedDigest = (a: Asset): string | null => (a.digest?.startsWith('sha256:') ? a.digest.slice(7).toLowerCase() : null)

export function extractCommand(file: string, dest: string): { cmd: string; args: string[] } {
  if (file.endsWith('.tar.zst')) return { cmd: 'tar', args: ['--zstd', '-xf', file, '-C', dest] }
  if (file.endsWith('.tgz') || file.endsWith('.tar.gz')) return { cmd: 'tar', args: ['-xzf', file, '-C', dest] }
  return { cmd: 'tar', args: ['-xf', file, '-C', dest] } // zip: bsdtar ships with Windows 10 and later
}

export function findBinary(dir: string, platform: NodeJS.Platform = process.platform): string | null {
  const want = platform === 'win32' ? 'ollama.exe' : 'ollama'
  const walk = (d: string, depth: number): string | null => {
    if (depth > 4) return null
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) if (e.isFile() && e.name === want) return join(d, e.name)
    for (const e of entries) if (e.isDirectory()) {
      const f = walk(join(d, e.name), depth + 1)
      if (f) return f
    }
    return null
  }
  return walk(dir, 0)
}

export const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })

export type EngineProgress = { phase: 'lookup' | 'download' | 'verify' | 'extract' | 'start' | 'done'; done: number; total: number; bytesPerSec?: number }
export type EngineStatus = { state: 'ready-external' | 'ready-managed' | 'installed' | 'missing'; version?: string; binary?: string }

type Opts = { host?: string; fetchFn?: (url: string, init?: RequestInit) => Promise<Response>; platform?: NodeJS.Platform; arch?: string; releaseUrl?: string }

export class Engine {
  private child: ChildProcess | null = null
  private fixedHost: string | undefined
  get host(): string {
    return this.fixedHost ?? getHost()
  }
  private f: NonNullable<Opts['fetchFn']>
  private platform: NodeJS.Platform
  private arch: string
  private releaseUrl: string

  constructor(private dir: string, private modelsDir: string, o: Opts = {}) {
    this.fixedHost = o.host
    this.f = o.fetchFn ?? patientFetch
    this.platform = o.platform ?? process.platform
    this.arch = o.arch ?? process.arch
    this.releaseUrl = o.releaseUrl ?? 'https://api.github.com/repos/ollama/ollama/releases/latest'
  }

  private binDir = () => join(this.dir, 'bin')
  binary = () => findBinary(this.binDir(), this.platform)

  private async version(): Promise<string | null> {
    try {
      const res = await this.f(`${this.host}/api/version`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return null
      return ((await res.json()) as { version?: string }).version ?? 'unknown'
    } catch {
      return null
    }
  }

  async status(): Promise<EngineStatus> {
    const v = await this.version()
    const bin = this.binary() ?? undefined
    if (v) return { state: this.child && this.child.exitCode === null ? 'ready-managed' : 'ready-external', version: v, binary: bin }
    return bin ? { state: 'installed', binary: bin } : { state: 'missing' }
  }

  async install(onProgress: (p: EngineProgress) => void, signal: AbortSignal): Promise<void> {
    onProgress({ phase: 'lookup', done: 0, total: 0 })
    const rel = await this.f(this.releaseUrl, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'forge-app' }, signal })
    if (!rel.ok) throw new Error(`Could not look up the latest Ollama release (GitHub answered ${rel.status}). Check your connection and try again.`)
    const { assets } = (await rel.json()) as { assets: Asset[] }
    const asset = pickAsset(assets, this.platform, this.arch)
    if (!asset) throw new Error(`There is no Ollama download for this system (${this.platform} ${this.arch}). Install Ollama yourself from ollama.com.`)

    const dl = join(this.dir, 'downloads')
    rmSync(dl, { recursive: true, force: true })
    mkdirSync(dl, { recursive: true })
    const file = join(dl, asset.name)

    // download
    const res = await this.f(asset.browser_download_url, { signal, headers: { 'user-agent': 'forge-app' } })
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`)
    const total = Number(res.headers.get('content-length')) || asset.size
    const out = createWriteStream(file + '.part')
    let got = 0
    let last = { t: Date.now(), n: 0 }
    let bps = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
        got += chunk.length
        const now = Date.now()
        if (now - last.t >= 500) {
          bps = ((got - last.n) / (now - last.t)) * 1000
          last = { t: now, n: got }
          onProgress({ phase: 'download', done: got, total, bytesPerSec: bps })
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(r))
    }
    renameSync(file + '.part', file)
    onProgress({ phase: 'download', done: got, total: got })

    // verify: the release lists a SHA-256 for each file
    onProgress({ phase: 'verify', done: 0, total: 1 })
    const want = expectedDigest(asset)
    if (want && (await sha256File(file)) !== want) {
      rmSync(dl, { recursive: true, force: true })
      throw new Error('The download is corrupt (its checksum does not match). Nothing was installed. Try again.')
    }

    // extract
    onProgress({ phase: 'extract', done: 0, total: 1 })
    rmSync(this.binDir(), { recursive: true, force: true })
    mkdirSync(this.binDir(), { recursive: true })
    const { cmd, args } = extractCommand(file, this.binDir())
    await new Promise<void>((resolve, reject) =>
      execFile(cmd, args, { timeout: 300_000, windowsHide: true }, (err, _o, stderr) =>
        err ? reject(new Error(asset.name.endsWith('.zst') ? 'Could not unpack the download. The zstd tool is needed on Linux: install the "zstd" package.' : `Could not unpack the download: ${stderr || err.message}`)) : resolve(),
      ),
    )
    const bin = this.binary()
    if (!bin) throw new Error('The download did not contain the Ollama program.')
    if (this.platform !== 'win32') chmodSync(bin, 0o755)
    rmSync(dl, { recursive: true, force: true })
    onProgress({ phase: 'done', done: 1, total: 1 })
  }

  // Starts the installed copy and waits until it answers.
  async start(): Promise<void> {
    if (await this.version()) return
    const bin = this.binary()
    if (!bin) throw new Error('The AI engine is not installed.')
    mkdirSync(this.modelsDir, { recursive: true })
    const port = new URL(this.host).host
    this.child = spawn(bin, ['serve'], {
      env: { ...process.env, OLLAMA_HOST: port, OLLAMA_MODELS: this.modelsDir, OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' },
      stdio: 'ignore',
      windowsHide: true,
    })
    let exited = false
    this.child.on('exit', () => (exited = true))
    for (let i = 0; i < 80; i++) {
      if (await this.version()) return
      if (exited) throw new Error('The AI engine stopped right after starting.')
      await new Promise((r) => setTimeout(r, 500))
    }
    this.stop()
    throw new Error('The AI engine did not start in time.')
  }

  stop() {
    if (this.child && this.child.exitCode === null) this.child.kill()
    this.child = null
  }
}

