import { describe, expect, it } from 'vitest'
import { applyRepoFilters, DIALOG_FILTERS, loadFilters, saveFilters, SKILL_FILTERS, type FilterItem, type RepoFilters } from './repoFilters'
import type { OwnerMap } from './ownerFilter'

const NOW = Date.parse('2026-11-05T00:00:00Z')
const off: RepoFilters = { verified: false, hideFake: false, hideForks: false, licensed: false, recent: false, minStars: 0 }
const repo = (fullName: string, o: Partial<FilterItem> = {}): FilterItem => ({ fullName, description: 'A fine tool', topics: [], stars: 500, sizeKb: 5000, pushedAt: '2026-10-01T00:00:00Z', license: 'MIT', ...o })
const own = (verified: boolean, checked = true) => ({ type: 'org' as const, verified, checked })
const names = (items: FilterItem[]) => items.map((x) => x.fullName)
const run = (items: FilterItem[], f: Partial<RepoFilters>, owners: OwnerMap = {}) => names(applyRepoFilters(items, { ...off, ...f }, owners, { now: NOW }))

describe('applyRepoFilters', () => {
  const all = [repo('a/ok'), repo('b/fork', { fork: true }), repo('c/old', { archived: true }), repo('d/stale', { pushedAt: '2024-01-01T00:00:00Z' }), repo('e/nolicense', { license: undefined }), repo('f/small', { stars: 50 }),
    repo('g/unlocker', { description: 'Full version unlocker 2026, ready to run', sizeKb: 1, stars: 300 }), repo('h/trending', { pushedAt: null, license: undefined, stars: 2000 })]

  it('shows everything with every switch off', () => expect(run(all, {})).toHaveLength(8))
  it('hides forks and archived', () => expect(run(all, { hideForks: true })).toEqual(names(all).filter((n) => n !== 'b/fork' && n !== 'c/old')))
  it('keeps only licensed repos, but not the ones whose details are unknown (trending)', () => expect(run(all, { licensed: true })).not.toContain('e/nolicense'))
  it('keeps trending items under the license and update filters', () => {
    expect(run(all, { licensed: true })).toContain('h/trending')
    expect(run(all, { recent: true })).toContain('h/trending')
  })
  it('keeps only repos pushed in the last year', () => expect(run(all, { recent: true })).not.toContain('d/stale'))
  it('hides fake-looking repos', () => { expect(run(all, { hideFake: true })).not.toContain('g/unlocker'); expect(run(all, { hideFake: true })).toContain('a/ok') })
  it('applies a minimum star count', () => { expect(run(all, { minStars: 100 })).not.toContain('f/small'); expect(run(all, { minStars: 1000 })).toEqual(['h/trending']) })

  it('verified owners only: drops checked-unverified owners, keeps unknown and verified ones', () => {
    const items = [repo('Acme/one'), repo('loose/two'), repo('who/three'), repo('bob/four')]
    const owners: OwnerMap = { acme: own(true), loose: own(false), bob: own(false, false) }
    expect(run(items, { verified: true }, owners)).toEqual(['Acme/one', 'who/three', 'bob/four'])
    expect(run(items, { verified: false }, owners)).toHaveLength(4)
  })

  it('combines filters', () => {
    const owners: OwnerMap = { a: own(true), b: own(true), c: own(false) }
    expect(run(all, { verified: true, hideFake: true, hideForks: true, licensed: true, recent: true, minStars: 100 }, owners)).toEqual(['a/ok', 'h/trending'])
  })

  it('uses a size learned elsewhere for the fake check', () => {
    const x = repo('g/unlocker', { description: 'Full version unlocker, ready to run', sizeKb: undefined, stars: 300 })
    expect(applyRepoFilters([x], { ...off, hideFake: true }, {}, { sizeOf: () => 1 })).toHaveLength(0)
  })
})

describe('stored filters', () => {
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
  it('has the dialog defaults and the Skills default (verified off)', () => {
    expect(DIALOG_FILTERS).toEqual({ verified: true, hideFake: true, hideForks: true, licensed: false, recent: false, minStars: 0 })
    expect(SKILL_FILTERS.verified).toBe(false)
  })
  it('round-trips, keeps defaults for missing or bad values', () => {
    const s = store()
    expect(loadFilters(s, 'k', DIALOG_FILTERS)).toEqual(DIALOG_FILTERS)
    saveFilters(s, 'k', { ...DIALOG_FILTERS, verified: false, minStars: 1000 })
    expect(loadFilters(s, 'k', DIALOG_FILTERS)).toMatchObject({ verified: false, minStars: 1000, hideFake: true })
    s.setItem('k', JSON.stringify({ verified: 'yes', minStars: 7, licensed: true }))
    expect(loadFilters(s, 'k', DIALOG_FILTERS)).toMatchObject({ verified: true, minStars: 0, licensed: true })
    s.setItem('k', '{bad')
    expect(loadFilters(s, 'k', SKILL_FILTERS)).toEqual(SKILL_FILTERS)
  })
})
