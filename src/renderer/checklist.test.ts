// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { checklist, patchDetail, planItems, type CheckItem } from './checklist'
import { morph } from './morph'

const keys = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.ck-row')].map(r => r.dataset.key)
const steps = (n: number, done: number, active = done): CheckItem[] => Array.from({ length: n }, (_, i) => ({ key: `t${i}`, text: `Step ${i}`, state: i < done ? 'done' : i === active ? 'active' : 'pending' }))

describe('checklist', () => {
  it('shows a long list from one row before the first unfinished step and counts the rest', () => {
    const el = checklist(steps(30, 3))
    expect(keys(el)).toEqual(['t2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'])
    expect(el.querySelector('.ck-more')!.textContent).toBe('+22 more')
  })
  it('ends on the last rows when all are done, and shows a short list whole', () => {
    expect(keys(checklist(steps(10, 10, -1)))).toEqual(['t2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'])
    const short = checklist(steps(3, 1), { live: false })
    expect(keys(short)).toEqual(['t0', 't1', 't2']); expect(short.querySelector('.ck-more')).toBeNull(); expect(short.className).toBe('ck')
    expect(short.querySelector<HTMLElement>('[data-key="t1"]')!.dataset.state).toBe('active')
  })
  it('keeps its rows and marks through a morph: a new state only flips data-state', () => {
    const live = checklist(steps(3, 0)), row = live.querySelector('[data-key="t0"]')!, m = row.querySelector<HTMLElement>('.ck-mark')!
    morph(live, checklist(steps(3, 1), { live: false }))
    expect(live.querySelector('[data-key="t0"]')).toBe(row); expect(row.querySelector('.ck-mark')).toBe(m)
    expect(m.dataset.state).toBe('done'); expect(live.className).toBe('ck')
  })
  it('patches a running row\'s step in place, and its name for screen readers with it', () => {
    const row = checklist([{ key: 'a', text: 'Fix login', state: 'active', detail: 'Codex is reading a.ts' }]).querySelector('.ck-row')!
    patchDetail(row, 'Codex is editing b.ts')
    expect(row.querySelector('.ck-detail')!.textContent).toBe('Codex is editing b.ts')
    expect(row.getAttribute('aria-label')).toBe('In progress: Fix login, Codex is editing b.ts')
  })
  it('maps Solo plan steps: skipped wins, doing is active, no id falls back to the position', () => {
    expect(planItems([{ id: 'a', text: 'x', status: 'doing' }, { text: 'y', status: 'done', skipped: true }, { text: 'z', status: 'todo' }]).map(i => [i.key, i.state])).toEqual([['a', 'active'], ['1', 'skipped'], ['2', 'pending']])
  })
})
