import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Engine, expectedDigest, extractCommand, findBinary, pickAsset, sha256File, type Asset, type EngineProgress } from './engine'

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
