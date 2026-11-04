import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { rankProjects, scanProjects, type ProjectHit } from './projectScan'

const hang = vi.hoisted(() => ({ name: '' }))
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return { ...real, readdir: ((p: string, ...a: unknown[]) => (hang.name && String(p).endsWith(hang.name) ? new Promise(() => {}) : (real.readdir as (...x: unknown[]) => unknown)(p, ...a))) as typeof real.readdir }
})

const hit = (name: string, mtime = 1): ProjectHit => ({ path: `/home/u/code/${name}`, name, markers: ['.git'], mtime })

describe('project scan', () => {
  it('finds project folders, skips dependencies and hidden folders, and does not look inside a project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-'))
    for (const [dir, marker] of [['code/riftvault', 'package.json'], ['code/riftvault/inner', '.git'], ['code/node_modules/dep', 'package.json'], ['.cache/tool', 'package.json'], ['Documents/site', 'index.html'], ['Documents/py', 'pyproject.toml']]) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, marker), '')
    }
    const found = (await scanProjects(root)).map((h) => h.path.slice(root.length + 1)).sort()
    expect(found).toEqual(['Documents/py', 'code/riftvault'])
  })

  it('matches the folder named in the request, ahead of loose matches', () => {
    const all = [hit('riftvault'), hit('manhwamaniacs'), hit('forge'), hit('riftvault-old')]
    expect(rankProjects(all, 'fix the riftvault login page')[0].name).toBe('riftvault')
    expect(rankProjects(all, 'make the manhwa reader faster').map((p) => p.name)).toEqual(['manhwamaniacs'])
    expect(rankProjects(all, 'fix the bug')).toEqual([])
  })

  it('finds a folder named like a stop word, and the second half of a camelCase name', () => {
    expect(rankProjects([hit('site'), hit('forge')], 'open the site project').map((p) => p.name)).toEqual(['site'])
    expect(rankProjects([hit('forge')], 'open the site project')).toEqual([])
    expect(rankProjects([hit('ManhwaManiacs'), hit('forge')], 'fix maniacs reader').map((p) => p.name)).toEqual(['ManhwaManiacs'])
  })

  it('does not match unrelated short names or far weaker matches', () => {
    const all = [hit('riftvault'), hit('vaul'), hit('frontend'), hit('riftvault-old')]
    expect(rankProjects(all, 'rework the riftvault app everything new').map((p) => p.name)).toEqual(['riftvault', 'riftvault-old'])
  })

  it('prefers the more recently changed folder when names tie', () => {
    const all = [hit('recall', 1), { ...hit('recall-corpus-meta', 100) }]
    expect(rankProjects(all, 'recall cards')[0].name).toBe('recall')
  })

  it('does not offer a folder because the request mentions a common word found inside its name', () => {
    expect(rankProjects([hit('platform-tools')], 'fix the login form on the website')).toEqual([])
    expect(rankProjects([hit('passport-demo'), hit('support-portal')], 'port the code to typescript')).toEqual([])
    expect(rankProjects([hit('password-manager')], 'add a word counter')).toEqual([])
    expect(rankProjects([hit('riftvault'), hit('homepage')], 'fix the riftvault login page').map((p) => p.name)).toEqual(['riftvault'])
    expect(rankProjects([hit('login-tests'), hit('pluginlogin')], 'login problems').map((p) => p.name)).toEqual(['login-tests'])
  })

  it('finds projects under a symlinked folder once, even when links loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-'))
    const data = mkdtempSync(join(tmpdir(), 'data-'))
    for (const d of ['forge', 'recall']) { mkdirSync(join(data, d)); writeFileSync(join(data, d, 'package.json'), '') }
    symlinkSync(data, join(root, 'code'))
    symlinkSync(root, join(data, 'back')) // a loop
    symlinkSync(data, join(root, 'again')) // a second link to the same place
    const found = (await scanProjects(root)).map((h) => h.name).sort()
    expect(found).toEqual(['forge', 'recall'])
  })

  it('gives back what it found when one folder never answers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-'))
    for (const d of ['a/ok', 'b/stuck', 'c']) mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, 'a/ok/package.json'), '')
    hang.name = 'stuck'
    mkdirSync(join(root, 'b/stuck/deep'), { recursive: true })
    try {
      const t = Date.now()
      const first = scanProjects(root, Date.now, 300)
      expect(scanProjects(root)).toBe(first) // shared, not a second walk
      expect((await first).map((h) => h.name)).toEqual(['ok'])
      expect(Date.now() - t).toBeLessThan(3000)
    } finally { hang.name = '' }
  })
})
