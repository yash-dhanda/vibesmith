import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cloneTimeoutMs, confirmLine, formatKb } from './cloneSize'
import { cloneAsReference, cloneRepo, type CloneDeps } from './githubClone'
import { git } from './skills'
import { listReferences, referencesBlock, removeReference } from './references'

const made: string[] = []
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d }
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' })
// A bare repository on disk stands in for github.com/<owner>/<repo>.
function fake() {
  const root = tmp('ghclone-')
  const work = join(root, 'work')
  mkdirSync(work)
  sh(work, 'init', '-q', '-b', 'main')
  writeFileSync(join(work, 'README.md'), '# Rocket\n')
  sh(work, 'add', '.'); sh(work, 'commit', '-q', '-m', 'init')
  mkdirSync(join(root, 'gh', 'acme'), { recursive: true })
  sh(root, 'clone', '-q', '--bare', work, join(root, 'gh', 'acme', 'rocket.git'))
  const deps: CloneDeps = {
    urlOf: (n) => join(root, 'gh', `${n}.git`),
    run: (args) => git(['-c', 'protocol.file.allow=always', ...args]), // git() forbids file:// by default; the later setting wins
  }
  return { root, deps, parent: tmp('ghparent-') }
}

describe('cloneRepo', () => {
  it('clones shallowly into a new folder', async () => {
    const f = fake()
    const dest = join(f.parent, 'rocket')
    await cloneRepo({ fullName: 'acme/rocket', dest }, f.deps)
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('# Rocket\n')
    expect(existsSync(join(dest, '.git'))).toBe(true)
  })

  it('refuses an existing destination and leaves it alone', async () => {
    const f = fake()
    const dest = join(f.parent, 'rocket')
    mkdirSync(dest)
    writeFileSync(join(dest, 'mine.txt'), 'keep')
    await expect(cloneRepo({ fullName: 'acme/rocket', dest }, f.deps)).rejects.toThrow(/already exists/)
    expect(readFileSync(join(dest, 'mine.txt'), 'utf8')).toBe('keep')
  })

  it('refuses bad names, bad folders and non-GitHub URLs by default', async () => {
    const f = fake()
    for (const n of ['acme', '../x/y', 'a/..', 'a b/c', 'https://evil.com/a/b', 'a/b;rm']) await expect(cloneRepo({ fullName: n, dest: join(f.parent, 'x') }, f.deps)).rejects.toThrow(/repository name/)
    await expect(cloneRepo({ fullName: 'acme/rocket', dest: join(f.parent, '..') }, f.deps)).rejects.toThrow(/folder name/)
    await expect(cloneRepo({ fullName: 'acme/rocket', dest: join(f.parent, 'a b') }, f.deps)).rejects.toThrow(/folder name/)
    await expect(cloneRepo({ fullName: 'acme/rocket', dest: join(f.parent, 'missing', 'x') }, f.deps)).rejects.toThrow(/does not exist/)
    let url = ''
    await cloneRepo({ fullName: 'acme/rocket', dest: join(f.parent, 'u') }, { run: async (a) => { url = a[a.length - 2] } }).catch(() => {})
    expect(url).toBe('https://github.com/acme/rocket.git')
  })

  it('cleans up after a failed clone', async () => {
    const f = fake()
    const dest = join(f.parent, 'nope')
    await expect(cloneRepo({ fullName: 'acme/missing', dest }, f.deps)).rejects.toThrow(/Could not clone it/)
    expect(existsSync(dest)).toBe(false)
  })

  it('has no size limit, reports progress and scales the timeout with the size', async () => {
    const f = fake()
    const seen: number[] = []
    const timeouts: number[] = []
    const dest = join(f.parent, 'big')
    await cloneRepo({ fullName: 'acme/rocket', dest }, {
      ...f.deps, sizeKb: 3 * 1024 * 1024, pollMs: 5, onProgress: (b) => seen.push(b),
      run: async (a, t) => { timeouts.push(t); await new Promise((r) => setTimeout(r, 40)); await f.deps.run!(a, t) },
    })
    expect(existsSync(join(dest, 'README.md'))).toBe(true)
    expect(timeouts).toEqual([18 * 60_000])
    expect(seen.length).toBeGreaterThan(0)
  })
})

describe('cloneAsReference', () => {
  it('stores plain files under .forge/references/repos and lists them for the agents', async () => {
    const f = fake()
    const project = tmp('ghproj-')
    mkdirSync(join(project, '.git'))
    const ref = await cloneAsReference(project, 'acme/rocket', 'A rocket toolkit', f.deps)
    const dir = join(project, '.forge', 'references', 'repos', 'acme__rocket')
    expect(ref.path).toBe(dir)
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
    expect(existsSync(join(dir, '.git'))).toBe(false)
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.forge/')
    expect(listReferences(project)).toEqual([expect.objectContaining({ kind: 'link', url: 'https://github.com/acme/rocket', path: dir, note: 'Cloned reference: acme/rocket, A rocket toolkit' })])
    expect(referencesBlock(project)).toContain(`- https://github.com/acme/rocket (files on this computer: ${dir}): Cloned reference: acme/rocket, A rocket toolkit`)
    await expect(cloneAsReference(project, 'acme/rocket', '', f.deps)).rejects.toThrow(/already exists/)
    removeReference(project, ref.id)
    expect(existsSync(dir)).toBe(false)
    expect(listReferences(project)).toEqual([])
  })

  it('leaves nothing behind when the clone fails', async () => {
    const f = fake()
    const project = tmp('ghproj-')
    await expect(cloneAsReference(project, 'acme/missing', '', f.deps)).rejects.toThrow()
    expect(existsSync(join(project, '.forge', 'references', 'repos', 'acme__missing'))).toBe(false)
    expect(listReferences(project)).toEqual([])
  })
})

describe('size question before a clone', () => {
  const MB = 1024
  it('scales the timeout: 3 minutes plus 1 per 200 MB, at most 20', () => {
    expect(cloneTimeoutMs()).toBe(3 * 60_000)
    expect(cloneTimeoutMs(199 * MB)).toBe(3 * 60_000)
    expect(cloneTimeoutMs(400 * MB)).toBe(5 * 60_000)
    expect(cloneTimeoutMs(1024 * MB)).toBe(8 * 60_000)
    expect(cloneTimeoutMs(100 * 1024 * MB)).toBe(20 * 60_000)
  })

  it('asks only from 50 MB up, or when the disk is short', () => {
    const base = { fullName: 'acme/rocket', freeBytes: 500 * 1024 * 1024 * 1024 }
    expect(confirmLine({ ...base, sizeKb: null })).toBeNull()
    expect(confirmLine({ ...base, sizeKb: 49 * MB })).toBeNull()
    const big = confirmLine({ ...base, sizeKb: 1.2 * 1024 * MB })!
    expect(big).toMatch(/^acme\/rocket is about 1\.2 GB\. Cloning it uses that much disk space/)
    expect(big).toMatch(/shallow clone skips the history/)
    expect(big).toMatch(/Continue\?$/)
    expect(big).not.toMatch(/free on that disk/)
    expect(confirmLine({ ...base, sizeKb: 50 * MB })).not.toBeNull()
  })

  it('warns, without blocking, when the free space is less than size plus 200 MB', () => {
    const line = confirmLine({ fullName: 'acme/rocket', sizeKb: 300 * MB, freeBytes: 450 * 1024 * 1024 })!
    expect(line).toMatch(/Only 450 MB is free on that disk, which is less than the size plus 200 MB\./)
    expect(line).toMatch(/Continue\?$/)
    expect(confirmLine({ fullName: 'a/b', sizeKb: 300 * MB, freeBytes: 600 * 1024 * 1024 })).not.toMatch(/free on that disk/)
    expect(confirmLine({ fullName: 'a/tiny', sizeKb: 10, freeBytes: 100 * 1024 * 1024 })).toMatch(/Only 100 MB is free/) // short disk asks even for a small repo
    expect(formatKb(512)).toBe('512 KB')
  })
})
