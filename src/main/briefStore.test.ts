import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BriefStore } from './briefStore'

const store = () => new BriefStore(join(mkdtempSync(join(tmpdir(), 'forge-brief-')), 'briefs.json'))

describe('BriefStore', () => {
  it('starts from the folder name', () => {
    expect(store().get('/home/u/recipes')).toEqual({ name: 'recipes', description: '', priorities: [], revision: 0 })
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
})
