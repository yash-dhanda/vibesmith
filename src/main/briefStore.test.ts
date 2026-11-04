import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BriefStore } from './briefStore'

const store = () => new BriefStore(join(mkdtempSync(join(tmpdir(), 'forge-brief-')), 'briefs.json'))

describe('BriefStore', () => {
  it('starts from the folder name', () => {
    expect(store().get('/home/u/recipes')).toEqual({ name: 'recipes', description: '', rules: '', priorities: [], revision: 0 })
  })
  it('saves, bumps the revision, cleans input and keeps priority ids', () => {
    const s = store()
    const a = s.set('/p/x', { revision: 0, name: '  My   app ', description: 'a\n\nthing', priorities: [{ text: 'dark mode' }, { text: '  ' }, { text: 'fast', included: false }] })
    expect(a.conflict).toBe(false)
    expect(a.brief).toMatchObject({ name: 'My app', description: 'a thing', revision: 1 })
    expect(a.brief.priorities.map((p) => [p.text, p.included])).toEqual([['dark mode', true], ['fast', false]])
    const id = a.brief.priorities[0].id
    const b = s.set('/p/x', { revision: 1, priorities: [{ id, text: 'dark mode!' }] })
    expect(b.brief.priorities[0].id).toBe(id)
    expect(b.brief.name).toBe('My app') // a field left out keeps its value
  })
  it('keeps rules with their line breaks, caps them, and leaves them alone when not sent', () => {
    const s = store()
    const a = s.set('/p/x', { revision: 0, rules: '  Always use plain JavaScript.\r\nNo frameworks.  ' })
    expect(a.brief.rules).toBe('Always use plain JavaScript.\nNo frameworks.')
    expect(s.set('/p/x', { revision: 1, name: 'n' }).brief.rules).toBe('Always use plain JavaScript.\nNo frameworks.')
    expect(s.set('/p/x', { revision: 2, rules: 'x'.repeat(5000) }).brief.rules).toHaveLength(3000)
  })
  it('refuses a stale revision', () => {
    const s = store()
    s.set('/p/x', { revision: 0, name: 'one' })
    const r = s.set('/p/x', { revision: 0, name: 'two' })
    expect(r.conflict).toBe(true)
    expect(r.brief.name).toBe('one')
  })
  it('persists between instances', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'forge-brief-')), 'b.json')
    new BriefStore(file).set('/p/x', { revision: 0, name: 'kept' })
    expect(new BriefStore(file).get('/p/x').name).toBe('kept')
  })

  it.each(['{"/p/a":{"name":"cut', 'null', '[]'])('an unreadable file (%j) is set aside, not overwritten by the next save', (bad) => {
    const file = join(mkdtempSync(join(tmpdir(), 'forge-brief-')), 'b.json')
    writeFileSync(file, bad)
    const s = new BriefStore(file)
    expect(s.set('/p/b', { revision: 0, name: 'B' }).conflict).toBe(false)
    expect(readFileSync(file + '.corrupt', 'utf8')).toBe(bad)
    expect(s.get('/p/b').name).toBe('B')
    expect(existsSync(file + '.tmp')).toBe(false)
  })
})
