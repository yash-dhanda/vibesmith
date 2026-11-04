import { beforeEach, describe, expect, it } from 'vitest'
import { checkOwners, ownerMap, ownerOf, ownersToCheck, ownerStatus, verifiedCount } from './ownerFilter'

const items = ['Acme/one', 'acme/two', 'loose/x', 'bob/y', 'zed/z'].map((fullName) => ({ fullName }))
const set = (o: string, verified: boolean, checked = true) => { ownerMap[o] = { type: 'org', verified, checked } }
beforeEach(() => { for (const k of Object.keys(ownerMap)) delete ownerMap[k] })

describe('verified owners filter', () => {
  it('counts the repos of verified organisations, ignoring case', () => {
    set('acme', true); set('loose', false)
    expect(ownerOf('Acme/one')).toBe('acme')
    expect(verifiedCount(items)).toBe(2)
  })

  it('lists the owners still to check, once each, in list order', () => {
    set('acme', true)
    expect(ownersToCheck(items)).toEqual(['loose', 'bob', 'zed'])
  })

  it('words the progress and the rate-limit stop', () => {
    expect(ownerStatus({ checked: 40, total: 95, stop: null, done: false })).toBe('Checking owners: 40 of 95')
    expect(ownerStatus({ checked: 60, total: 95, stop: 'rate', done: true })).toBe('Checked 60 of 95 owners. Sign in with the GitHub CLI (gh auth login) to check all of them.')
    expect(ownerStatus({ checked: 95, total: 95, stop: null, done: true })).toBe('')
    expect(ownerStatus(null)).toBe('')
  })

  it('checks owners in batches of eight, progressively, and stops at a rate limit', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ fullName: `o${i}/r` }))
    const batches: string[][] = []
    ;(globalThis as { window?: unknown }).window = { forge: { githubOwners: async (names: string[]) => {
      batches.push(names)
      if (batches.length === 3) return { owners: {}, checked: 0, total: names.length, stopped: 'rate' }
      return { owners: Object.fromEntries(names.map((n) => [n, { type: 'org', verified: n !== 'o3', checked: true }])), checked: names.length, total: names.length, stopped: null }
    } } }
    const seen: string[] = []
    await checkOwners(many, (p) => seen.push(ownerStatus(p)))
    expect(batches.map((b) => b.length)).toEqual([8, 8, 4])
    expect(seen).toEqual(['Checking owners: 0 of 20', 'Checking owners: 8 of 20', 'Checking owners: 16 of 20', 'Checked 16 of 20 owners. Sign in with the GitHub CLI (gh auth login) to check all of them.'])
    expect(verifiedCount(many)).toBe(15)
    delete (globalThis as { window?: unknown }).window
  })
})
