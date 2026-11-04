import { CATEGORIES, type Idea, type IdeaLevel } from './ideasData'

// Pure helpers for the ideas gallery and the improve dialog, apart from the DOM code so they can be tested.

export type IdeaFilter = { category: 'all' | 'saved' | (typeof CATEGORIES)[number]; level: IdeaLevel | 'any'; time: 'any' | '2' | '4' | 'long'; query: string }

// "1-3" -> 3: the upper end is what a person plans around.
export const maxHours = (hours: string) => Number(hours.split('-').pop()) || 0

export function filterIdeas(ideas: Idea[], f: IdeaFilter, saved: ReadonlySet<string>): Idea[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean)
  return ideas.filter((i) => {
    if (f.category === 'saved' ? !saved.has(i.id) : f.category !== 'all' && i.category !== f.category) return false
    if (f.level !== 'any' && i.level !== f.level) return false
    const h = maxHours(i.hours)
    if (f.time === '2' ? h > 2 : f.time === '4' ? h > 4 : f.time === 'long' ? h <= 4 : false) return false
    const hay = `${i.title} ${i.pitch} ${i.category} ${i.stack} ${i.tags.join(' ')}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

// Several findings become one Crew goal, in the order shown (most important first).
export function combineGoals(items: { title: string; goal: string }[]): string {
  const head = items.length === 1 ? 'Fix this problem in the project.' : `Fix these ${items.length} problems in the project, one after the other in this order. Keep every change small, leave behaviour that is not mentioned alone, and run the project's checks after each fix.`
  return `${head}\n\n${items.map((s, i) => `${items.length === 1 ? '' : `${i + 1}. `}${s.title}\n${s.goal}`).join('\n\n')}`
}

export const REVIEW_GOAL = 'Review this project end to end. Do not change code. Write REVIEW.md with prioritised problems, risks and improvements, each with the file and a concrete fix.'

// A set of ids kept in localStorage; a missing or damaged entry is an empty set.
export function loadIds(key: string): Set<string> {
  try { const v = JSON.parse(localStorage.getItem(key) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []) } catch { return new Set() }
}
export function saveIds(key: string, ids: ReadonlySet<string>) {
  try { localStorage.setItem(key, JSON.stringify([...ids])) } catch { /* private mode or full: the choice just lasts this session */ }
}
