import { describe, expect, it } from 'vitest'
import { applyUserPlan, emptyPlan, mergeAgentPlan, planFromTranscript, planNote } from './plan'

const agent = (...t: string[]) => t.map((text) => ({ text, status: 'todo' as const }))

describe('mergeAgentPlan', () => {
  it('keeps ids and skips across an agent rewrite, and keeps steps the user added', () => {
    const a = mergeAgentPlan(emptyPlan(), agent('one', 'two'))
    const user = applyUserPlan(a, a.revision, [...a.items.map((s) => (s.text === 'two' ? { ...s, skipped: true } : s)), { text: 'mine' }])
    expect(user.changed).toBe(true)
    const b = mergeAgentPlan(user.plan, [{ text: 'One', status: 'done' }, { text: 'two', status: 'todo' }, { text: 'three', status: 'todo' }])
    expect(b.items.map((s) => [s.text, s.skipped, s.status])).toEqual([['One', false, 'done'], ['two', true, 'todo'], ['three', false, 'todo'], ['mine', false, 'todo']])
    expect(b.items[0].id).toBe(a.items[0].id)
    expect(b.revision).toBe(user.plan.revision + 1)
  })
})

describe('applyUserPlan', () => {
  const base = mergeAgentPlan(emptyPlan(), agent('a', 'b', 'c'))
  it('refuses a stale revision and returns the current plan', () => {
    const r = applyUserPlan(base, base.revision - 1, [])
    expect(r.conflict).toBe(true)
    expect(r.plan).toBe(base)
  })
  it('reorders, renames, removes, and ignores empty or invalid steps', () => {
    const [a, b, c] = base.items
    const r = applyUserPlan(base, base.revision, [c, { ...a, text: ' A  renamed ' }, { text: '   ' }, null, { id: 'nope', text: 'new' }])
    expect(r.plan.items.map((s) => s.text)).toEqual(['c', 'A renamed', 'new'])
    expect(r.plan.items[0].id).toBe(c.id)
    expect(r.plan.items[2].id).not.toBe('nope')
    expect(r.plan.revision).toBe(base.revision + 1)
    expect(applyUserPlan(r.plan, r.plan.revision, r.plan.items).changed).toBe(false) // no-op edits do not bump the revision
    void b
  })
  it('caps the number of steps', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ text: `s${i}` }))
    expect(applyUserPlan(base, base.revision, many).plan.items).toHaveLength(30)
  })
})

describe('planNote', () => {
  it('tells the model what changed', () => {
    const a = mergeAgentPlan(emptyPlan(), agent('one', 'two', 'three'))
    const r = applyUserPlan(a, a.revision, [a.items[2], { ...a.items[1], skipped: true }, a.items[0], { text: 'extra' }])
    const note = planNote(a, r.plan)
    expect(note).toContain('skipped "two" (do not do it)')
    expect(note).toContain('added a step: "extra"')
    expect(note).toContain('1. three')
    expect(planNote(a, a)).toBe('')
  })
  it('notices a pure reorder', () => {
    const a = mergeAgentPlan(emptyPlan(), agent('one', 'two'))
    const r = applyUserPlan(a, a.revision, [a.items[1], a.items[0]])
    expect(planNote(a, r.plan)).toContain('reordered')
  })
})

describe('planFromTranscript', () => {
  it('uses the last plan and gives old plans ids', () => {
    const p = planFromTranscript([{ type: 'user' }, { type: 'plan', items: [{ text: 'x', status: 'done' }] }, { type: 'delta' }])
    expect(p.items).toHaveLength(1)
    expect(p.items[0].id).toBeTruthy()
    expect(p.items[0].status).toBe('done')
    expect(planFromTranscript([]).items).toEqual([])
  })
})
