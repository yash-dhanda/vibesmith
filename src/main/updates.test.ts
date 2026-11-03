import { describe, expect, it } from 'vitest'
import { checkForUpdate, newerThan } from './updates'

const reply = (body: unknown, ok = true) => async () => ({ ok, json: async () => body })

describe('updates', () => {
  it('compares versions numerically', () => {
    expect(newerThan('v0.10.0', '0.9.5')).toBe(true)
    expect(newerThan('0.1.0', '0.1.0')).toBe(false)
    expect(newerThan('1.0.0-beta', '0.9.0')).toBe(true)
    expect(newerThan('0.1.0', '0.2.0')).toBe(false)
  })
  it('reports a newer release and ignores drafts, prereleases, old tags and failures', async () => {
    const rel = { tag_name: 'v0.2.0', html_url: 'https://github.com/x/y/releases/tag/v0.2.0', body: 'notes' }
    expect(await checkForUpdate('0.1.0', reply(rel))).toEqual({ available: true, version: '0.2.0', url: rel.html_url, notes: 'notes' })
    expect((await checkForUpdate('0.1.0', reply({ ...rel, prerelease: true }))).available).toBe(false)
    expect((await checkForUpdate('0.2.0', reply(rel))).available).toBe(false)
    expect((await checkForUpdate('0.1.0', reply({}, false))).available).toBe(false)
    expect((await checkForUpdate('0.1.0', async () => { throw new Error('offline') })).available).toBe(false)
  })
})
