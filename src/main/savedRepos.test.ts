import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_SAVED, SavedStore, type NewSaved } from './savedRepos'

const made: string[] = []
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'saved-')); made.push(d); return d }
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const repo = (n: string, o: Partial<NewSaved> = {}): NewSaved => ({ fullName: n, url: 'ignored', description: 'A tool', stars: 120, topics: ['a'], language: 'Go', ...o })

describe('saved repositories', () => {
  it('saves, lists newest first, keeps the note on re-save, and removes', () => {
    const d = dir()
    const s = new SavedStore(join(d, 'savedRepos.json'))
    expect(s.list()).toEqual([])
    s.set(repo('acme/one'), 1000)
    s.set(repo('acme/two', { note: ' to read  later ' }), 2000)
    expect(s.list().map((r) => r.fullName)).toEqual(['acme/two', 'acme/one'])
    expect(s.list()[0]).toMatchObject({ note: 'to read later', url: 'https://github.com/acme/two', savedAt: 2000, stars: 120, language: 'Go' })
    s.set(repo('Acme/ONE', { stars: 999 }), 3000)
    expect(s.list().find((r) => r.fullName === 'Acme/ONE')).toMatchObject({ savedAt: 1000, stars: 999 })
    expect(s.list()).toHaveLength(2)
    s.set(repo('acme/two', { note: '' }))
    expect(s.list()[0].note).toBe('')
    s.remove('acme/one')
    s.remove('acme/missing')
    expect(s.list().map((r) => r.fullName)).toEqual(['acme/two'])
    expect(new SavedStore(join(d, 'savedRepos.json')).list()).toHaveLength(1) // it is on disk
  })

  it('writes atomically, leaving no temp files', () => {
    const d = dir()
    const s = new SavedStore(join(d, 'savedRepos.json'))
    for (let i = 0; i < 5; i++) s.set(repo(`acme/r${i}`))
    expect(readdirSync(d)).toEqual(['savedRepos.json'])
  })

  it('refuses bad names, caps at 500 and ignores a damaged file', () => {
    const d = dir()
    const file = join(d, 'savedRepos.json')
    const s = new SavedStore(file)
    for (const bad of ['acme', '../x/y', 'a/..', 'a b/c']) expect(() => s.set(repo(bad))).toThrow(/repository name/)
    writeFileSync(file, '{broken')
    expect(s.list()).toEqual([])
    writeFileSync(file, JSON.stringify(Array.from({ length: MAX_SAVED }, (_, i) => ({ fullName: `o/r${i}`, savedAt: i }))))
    expect(() => s.set(repo('o/extra'))).toThrow(/up to 500/)
    expect(() => s.set(repo('o/r3'))).not.toThrow() // updating one that is there is fine
    expect(existsSync(file)).toBe(true)
  })

  it('stores refreshed star counts without touching the count at the time of saving', () => {
    const s = new SavedStore(join(dir(), 'savedRepos.json'))
    s.set(repo('acme/one', { stars: 100 }), 1)
    s.set(repo('acme/two'), 2)
    const out = s.updateStars({ 'acme/one': { stars: 250, description: 'New words' }, 'nobody/here': { stars: 1, description: '' } }, 5000)
    expect(out.find((r) => r.fullName === 'acme/one')).toMatchObject({ stars: 100, starsNow: 250, refreshedAt: 5000, description: 'New words' })
    expect(out.find((r) => r.fullName === 'acme/two')?.starsNow).toBeUndefined()
    s.set(repo('acme/one', { stars: 300 }))
    expect(s.list().find((r) => r.fullName === 'acme/one')?.starsNow).toBe(250)
  })
})
