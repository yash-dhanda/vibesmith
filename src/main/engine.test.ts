import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, expectedDigest, extractCommand, findBinary, pickAsset, sha256File, type Asset, type EngineProgress } from './engine'

// lets one test swap in a write stream that fails like a full disk
const hook = vi.hoisted(() => ({ cws: null as null | (() => unknown) }))
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>()
  return { ...fs, createWriteStream: (...a: Parameters<typeof fs.createWriteStream>) => (hook.cws ? hook.cws() : fs.createWriteStream(...a)) }
})

const A = (name: string, extra: Partial<Asset> = {}): Asset => ({ name, browser_download_url: `https://x/${name}`, size: 100, ...extra })
const RELEASE = [A('ollama-linux-amd64.tar.zst'), A('ollama-linux-amd64-rocm.tar.zst'), A('ollama-linux-arm64.tar.zst'), A('ollama-linux-arm64-jetpack5.tar.zst'), A('ollama-windows-amd64.zip'), A('ollama-windows-arm64.zip'), A('ollama-darwin.tgz'), A('sha256sum.txt'), A('OllamaSetup.exe')]

describe('pickAsset', () => {
  it('picks the main archive for the system, never the AMD, Jetson, installer or checksum files', () => {
    expect(pickAsset(RELEASE, 'linux', 'x64')?.name).toBe('ollama-linux-amd64.tar.zst')
    expect(pickAsset(RELEASE, 'linux', 'arm64')?.name).toBe('ollama-linux-arm64.tar.zst')
    expect(pickAsset(RELEASE, 'win32', 'x64')?.name).toBe('ollama-windows-amd64.zip')
  })
  it('prefers gzip when offered, since every system can unpack it', () => {
    expect(pickAsset([A('ollama-linux-amd64.tar.zst'), A('ollama-linux-amd64.tgz')], 'linux', 'x64')?.name).toBe('ollama-linux-amd64.tgz')
  })
  it('returns null where there is nothing to offer', () => {
    expect(pickAsset(RELEASE, 'darwin', 'arm64')).toBeNull()
    expect(pickAsset([A('sha256sum.txt')], 'linux', 'x64')).toBeNull()
  })
})

describe('small helpers', () => {
  it('expectedDigest reads GitHub sha256 digests', () => {
    expect(expectedDigest(A('x', { digest: 'sha256:ABCDEF' }))).toBe('abcdef')
    expect(expectedDigest(A('x'))).toBeNull()
    expect(expectedDigest(A('x', { digest: 'md5:1' }))).toBeNull()
  })
  it('extractCommand per archive type', () => {
    expect(extractCommand('/d/a.tar.zst', '/o')).toEqual({ cmd: 'tar', args: ['--zstd', '-xf', '/d/a.tar.zst', '-C', '/o'] })
    expect(extractCommand('/d/a.tgz', '/o').args[0]).toBe('-xzf')
    expect(extractCommand('/d/a.zip', '/o').args).toEqual(['-xf', '/d/a.zip', '-C', '/o'])
  })
  it('findBinary finds the program in a nested folder, and only the exact name', () => {
    const d = mkdtempSync(join(tmpdir(), 'forge-bin-'))
    mkdirSync(join(d, 'lib/ollama'), { recursive: true })
    mkdirSync(join(d, 'bin'), { recursive: true })
    writeFileSync(join(d, 'lib/ollama/ollama-helper'), 'x')
    expect(findBinary(d, 'linux')).toBeNull()
    writeFileSync(join(d, 'bin/ollama'), 'x')
    expect(findBinary(d, 'linux')).toBe(join(d, 'bin/ollama'))
    expect(findBinary(d, 'win32')).toBeNull()
  })
  it('sha256File', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'forge-h-')), 'a')
    writeFileSync(f, 'hello')
    expect(await sha256File(f)).toBe(createHash('sha256').update('hello').digest('hex'))
  })
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-engine-'))
})

// a fake archive: bin/ollama is a shell script that answers like the real thing when asked to serve
function makeArchive(name: string) {
  const src = mkdtempSync(join(tmpdir(), 'forge-src-'))
  mkdirSync(join(src, 'bin'), { recursive: true })
  writeFileSync(join(src, 'bin/ollama'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(src, 'bin/ollama'), 0o755)
  const out = join(mkdtempSync(join(tmpdir(), 'forge-arc-')), name)
  execFileSync('tar', ['-czf', out, '-C', src, 'bin'])
  return readFileSync(out)
}

const fakeNet = (archive: Buffer, opts: { digest?: string | null; version?: string | null } = {}) => {
  const urls: string[] = []
  const digest = opts.digest === undefined ? 'sha256:' + createHash('sha256').update(archive).digest('hex') : (opts.digest ?? undefined)
  const f = async (url: string) => {
    urls.push(url)
    if (url.includes('api.github.com')) return new Response(JSON.stringify({ assets: [A('ollama-linux-amd64.tgz', { digest, size: archive.length })] }))
    if (url.endsWith('/api/version')) return opts.version ? new Response(JSON.stringify({ version: opts.version })) : new Response('', { status: 500 })
    return new Response(new Uint8Array(archive), { headers: { 'content-length': String(archive.length) } })
  }
  return { f, urls }
}

describe('Engine.status', () => {
  it('missing, installed, and ready (using one that was already running)', async () => {
    const e = new Engine(dir, join(dir, 'models'), { fetchFn: fakeNet(Buffer.from(''), { version: null }).f, platform: 'linux' })
    expect(await e.status()).toEqual({ state: 'missing' })
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin/ollama'), 'x')
    expect((await e.status()).state).toBe('installed')
    const up = new Engine(dir, join(dir, 'models'), { fetchFn: fakeNet(Buffer.from(''), { version: '0.40.13' }).f, platform: 'linux' })
    expect(await up.status()).toMatchObject({ state: 'ready-external', version: '0.40.13' })
  })
})

describe('Engine.install', () => {
  it('downloads, verifies, unpacks and makes the program runnable, reporting each phase', async () => {
    const archive = makeArchive('a.tgz')
    const net = fakeNet(archive)
    const e = new Engine(dir, join(dir, 'models'), { fetchFn: net.f, platform: 'linux', arch: 'x64' })
    const phases: EngineProgress['phase'][] = []
    await e.install((p) => phases.push(p.phase), new AbortController().signal)
    expect([...new Set(phases)]).toEqual(['lookup', 'download', 'verify', 'extract', 'done'])
    const bin = e.binary()!
    expect(bin).toBe(join(dir, 'bin/bin/ollama'))
    expect(statSync(bin).mode & 0o111).not.toBe(0) // executable
    expect(existsSync(join(dir, 'downloads'))).toBe(false) // the archive is cleaned up
    expect(net.urls.some((u) => u.endsWith('ollama-linux-amd64.tgz'))).toBe(true)
  })

  it('refuses a corrupt download and installs nothing', async () => {
    const e = new Engine(dir, join(dir, 'models'), { fetchFn: fakeNet(makeArchive('a.tgz'), { digest: 'sha256:' + '0'.repeat(64) }).f, platform: 'linux', arch: 'x64' })
    await expect(e.install(() => {}, new AbortController().signal)).rejects.toThrow(/corrupt/)
    expect(e.binary()).toBeNull()
  })

  it('explains an unreachable GitHub and a system with no download', async () => {
    const down = new Engine(dir, join(dir, 'models'), { fetchFn: async () => new Response('', { status: 403 }), platform: 'linux' })
    await expect(down.install(() => {}, new AbortController().signal)).rejects.toThrow(/GitHub answered 403/)
    const mac = new Engine(dir, join(dir, 'models'), { fetchFn: fakeNet(Buffer.from('x')).f, platform: 'darwin', arch: 'arm64' })
    await expect(mac.install(() => {}, new AbortController().signal)).rejects.toThrow(/no Ollama download for this system/)
  })

  it('a cancelled install leaves no program behind', async () => {
    const ctl = new AbortController()
    const f = async (url: string, init?: RequestInit) => {
      if (url.includes('api.github.com')) return new Response(JSON.stringify({ assets: [A('ollama-linux-amd64.tgz')] }))
      ctl.abort()
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Response('')
    }
    const e = new Engine(dir, join(dir, 'models'), { fetchFn: f, platform: 'linux', arch: 'x64' })
    await expect(e.install(() => {}, ctl.signal)).rejects.toThrow()
    expect(e.binary()).toBeNull()
  })
})

// a release whose download is whatever stream `body` makes; the abort signal errors the body the way a real fetch does
const streamNet = (name: string, body: (c: ReadableStreamDefaultController<Uint8Array>) => void, digest?: string) => async (url: string, init?: RequestInit) => {
  if (url.includes('api.github.com')) return new Response(JSON.stringify({ assets: [A(name, { digest, size: 100 })] }))
  return new Response(new ReadableStream<Uint8Array>({ start(c) { init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); body(c) } }))
}
const install = (e: Engine, signal = new AbortController().signal) => e.install(() => {}, signal)
const mk = (f: ReturnType<typeof streamNet>, platform: NodeJS.Platform = 'linux') => new Engine(dir, join(dir, 'models'), { fetchFn: f, platform, arch: 'x64' })

describe('Engine.install failures', () => {
  it('a full disk ends the install with a clear message instead of hanging, and removes the partial file', async () => {
    hook.cws = () => new Writable({ write: (_c, _e, cb) => cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })) })
    try {
      const e = mk(streamNet('ollama-linux-amd64.tgz', (c) => c.enqueue(new Uint8Array(1000))))
      await expect(install(e)).rejects.toThrow(/Not enough disk space/)
    } finally {
      hook.cws = null
    }
    expect(existsSync(join(dir, 'downloads'))).toBe(false)
  }, 4000)

  it('Cancel stops the download, removes the partial file and rejects as an abort', async () => {
    const ctl = new AbortController()
    const e = mk(streamNet('ollama-linux-amd64.tgz', (c) => c.enqueue(new Uint8Array(1000))))
    const p = install(e, ctl.signal)
    await new Promise((r) => setTimeout(r, 200))
    ctl.abort()
    await expect(p).rejects.toThrow(/abort/i)
    expect(existsSync(join(dir, 'downloads'))).toBe(false)
  }, 4000)

  it('a dropped connection says so and leaves no partial file', async () => {
    const e = mk(streamNet('ollama-linux-amd64.tgz', (c) => { c.enqueue(new Uint8Array(1000)); setTimeout(() => c.error(new TypeError('terminated')), 50) }))
    await expect(install(e)).rejects.toThrow(/interrupted/)
    expect(existsSync(join(dir, 'downloads'))).toBe(false)
  }, 4000)

  it('an archive that will not unpack reports tar\'s own reason, not a zstd hint, and is removed', async () => {
    const junk = Buffer.from('not an archive at all')
    const e = mk(streamNet('ollama-linux-amd64.tgz', (c) => (c.enqueue(new Uint8Array(junk)), c.close()), 'sha256:' + createHash('sha256').update(junk).digest('hex')))
    const err = await install(e).catch((x: Error) => x)
    expect((err as Error).message).toMatch(/Could not unpack the download: .+/)
    expect((err as Error).message).not.toMatch(/install the "zstd"/)
    expect(existsSync(join(dir, 'downloads'))).toBe(false)
  })
})

describe('Engine.start', () => {
  const script = (body: string, mode = 0o755) => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin/ollama'), body)
    chmodSync(join(dir, 'bin/ollama'), mode)
  }
  const down = async () => new Response('', { status: 500 })

  it('a program that cannot run fails at once with the reason', async () => {
    script('#!/bin/sh\nexit 0\n', 0o644)
    const t = Date.now()
    await expect(new Engine(dir, join(dir, 'models'), { fetchFn: down, platform: 'linux' }).start()).rejects.toThrow(/Could not start the AI engine \(EACCES\)/)
    expect(Date.now() - t).toBeLessThan(3000)
  }, 8000)

  it('an engine that dies at once says what it printed', async () => {
    script('#!/bin/sh\necho "address already in use" >&2\nexit 1\n')
    await expect(new Engine(dir, join(dir, 'models'), { fetchFn: down, platform: 'linux' }).start()).rejects.toThrow(/stopped right after starting\. address already in use/)
  }, 8000)

  it('two overlapping starts spawn one engine', async () => {
    const count = join(dir, 'count')
    script(`#!/bin/sh\necho x >> ${count}\nexec sleep 5\n`)
    let up = false
    setTimeout(() => (up = true), 1200)
    const f = async () => (up ? new Response(JSON.stringify({ version: '1' })) : new Response('', { status: 500 }))
    const e = new Engine(dir, join(dir, 'models'), { fetchFn: f, platform: 'linux' })
    const a = e.start()
    await new Promise((r) => setTimeout(r, 300))
    await Promise.all([a, e.start()])
    expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1)
    expect((await e.status()).state).toBe('ready-managed')
    e.stop()
  }, 8000)
})
