import { describe, expect, it } from 'vitest'
import { clearSeen, excludeList, readSeen, rememberSeen, skillNote, SEEN_KEY } from './skillSuggest'

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m } }

describe('skill suggestions bookkeeping', () => {
  it('remembers suggested repos across sessions, once each, and can start over', () => {
    const s = store()
    expect(readSeen(s)).toEqual([])
    rememberSeen(s, ['Acme/One', 'acme/two'])
    expect(rememberSeen(s, ['acme/one', 'acme/three'])).toEqual(['acme/one', 'acme/two', 'acme/three'])
    expect(readSeen(s)).toEqual(['acme/one', 'acme/two', 'acme/three'])
    clearSeen(s)
    expect(readSeen(s)).toEqual([])
    s.m.set(SEEN_KEY, '{not json')
    expect(readSeen(s)).toEqual([])
  })

  it('keeps only the newest 1500', () => {
    const s = store()
    rememberSeen(s, Array.from({ length: 1600 }, (_, i) => `o/r${i}`))
    const seen = readSeen(s)
    expect(seen).toHaveLength(1500)
    expect(seen[0]).toBe('o/r100')
  })

  it('excludes the catalog, the library, earlier suggestions and what is shown, lowercased and once', () => {
    expect(excludeList(['Anthropics/Skills'], new Set(['acme/one']), ['ACME/ONE', 'x/y'], [])).toEqual(['anthropics/skills', 'acme/one', 'x/y'])
  })

  it('says how many skills an Add found, or that it kept plain files', () => {
    const sk = (p: string) => ({ name: 'n', description: '', path: p })
    expect(skillNote({ skills: [sk('/a/x/SKILL.md'), sk('/a/y/SKILL.md')] })).toEqual({ text: '2 skills found', muted: false })
    expect(skillNote({ skills: [sk('/a/x/SKILL.md')], total: 12 })).toEqual({ text: '12 skills found', muted: false })
    expect(skillNote({ skills: [sk('/a/x/SKILL.md')] }).text).toBe('1 skill found')
    expect(skillNote({ skills: [sk('/a/README.md')], total: 1 })).toEqual({ text: 'No SKILL.md found: added as plain files the agents can read', muted: true })
    expect(skillNote({ skills: [] }).muted).toBe(true)
  })
})
