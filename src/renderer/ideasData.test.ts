import { describe, expect, it } from 'vitest'
import { CATEGORIES, IDEAS } from './ideasData'

describe('ideas data', () => {
  it('has unique ids and a sensible number of ideas', () => {
    expect(new Set(IDEAS.map((i) => i.id)).size).toBe(IDEAS.length)
    expect(IDEAS.length).toBeGreaterThanOrEqual(58)
  })
  it('covers every category with at least four ideas', () => {
    for (const c of CATEGORIES) expect(IDEAS.filter((i) => i.category === c).length, c).toBeGreaterThanOrEqual(4)
  })
  it.each(IDEAS.map((i) => [i.id, i] as const))('%s is well formed', (_id, i) => {
    expect(i.id).toMatch(/^[a-z0-9-]+$/)
    expect(CATEGORIES).toContain(i.category)
    expect(['starter', 'intermediate', 'ambitious']).toContain(i.level)
    expect(i.hours).toMatch(/^\d+-\d+$/)
    expect(i.title.length).toBeGreaterThan(5)
    expect(i.pitch.split(/[.!?]\s/).length, 'pitch is short').toBeLessThanOrEqual(2)
    expect(i.pitch.length).toBeLessThan(200)
    expect(i.stack.length).toBeGreaterThan(5)
    expect(i.features.length).toBeGreaterThanOrEqual(4)
    expect(i.features.length).toBeLessThanOrEqual(7)
    expect(i.tags.length).toBeGreaterThan(0)
    expect(i.goal.split(/[.!?]\s/).length, 'goal sentences').toBeGreaterThanOrEqual(4)
    expect(i.goal.length).toBeGreaterThan(400)
    expect(i.goal.length).toBeLessThan(2400)
    expect(i.goal).toMatch(/README/)
    expect(i.goal).toMatch(/`(npm test|pytest)`/)
  })
})
