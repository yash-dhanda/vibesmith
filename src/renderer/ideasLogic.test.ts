import { beforeEach, describe, expect, it } from 'vitest'
import { IDEAS } from './ideasData'
import { combineGoals, filterIdeas, loadIds, maxHours, saveIds, type IdeaFilter } from './ideasLogic'

const base: IdeaFilter = { category: 'all', level: 'any', time: 'any', query: '' }

describe('filterIdeas', () => {
  it('returns everything by default', () => expect(filterIdeas(IDEAS, base, new Set())).toHaveLength(IDEAS.length))
  it('filters by category, level and time together', () => {
    const r = filterIdeas(IDEAS, { ...base, category: 'Bots', level: 'starter', time: '4' }, new Set())
    expect(r.length).toBeGreaterThan(0)
    for (const i of r) { expect(i.category).toBe('Bots'); expect(i.level).toBe('starter'); expect(maxHours(i.hours)).toBeLessThanOrEqual(4) }
  })
  it('long means more than four hours', () => {
    for (const i of filterIdeas(IDEAS, { ...base, time: 'long' }, new Set())) expect(maxHours(i.hours)).toBeGreaterThan(4)
  })
  it('searches title, stack and tags, every word must match', () => {
    expect(filterIdeas(IDEAS, { ...base, query: 'telegraf study' }, new Set()).map((i) => i.id)).toContain('telegram-study-bot')
    expect(filterIdeas(IDEAS, { ...base, query: 'zzzz-nothing' }, new Set())).toEqual([])
  })
  it('shows only saved ideas in the saved view', () => {
    expect(filterIdeas(IDEAS, { ...base, category: 'saved' }, new Set(['url-shortener'])).map((i) => i.id)).toEqual(['url-shortener'])
  })
})

describe('combineGoals', () => {
  it('numbers several goals and leaves a single one plain', () => {
    expect(combineGoals([{ title: 'A', goal: 'do a' }])).toBe('Fix this problem in the project.\n\nA\ndo a')
    const two = combineGoals([{ title: 'A', goal: 'do a' }, { title: 'B', goal: 'do b' }])
    expect(two).toContain('Fix these 2 problems')
    expect(two).toContain('1. A\ndo a\n\n2. B\ndo b')
  })
})

describe('saved ids', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  })
  it('round-trips and survives damage', () => {
    saveIds('k', new Set(['a', 'b']))
    expect([...loadIds('k')]).toEqual(['a', 'b'])
    localStorage.setItem('k', '{oops')
    expect(loadIds('k').size).toBe(0)
    localStorage.setItem('k', '[1,"x"]')
    expect([...loadIds('k')]).toEqual(['x'])
  })
})
