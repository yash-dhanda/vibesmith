import type { SkillRepo } from '../main/skills'

// Bookkeeping for "More suggestions" in Settings > Skills: which repositories were already suggested (kept across sessions) and what to leave out.
export const SEEN_KEY = 'forge.skillSeen'
const MAX_SEEN = 1500 // the main process accepts up to 3000 names in one request
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readSeen(s: Pick<Storage, 'getItem'>): string[] {
  try { const v = JSON.parse(s.getItem(SEEN_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
// Adds names (case-insensitive, no duplicates), keeps the newest MAX_SEEN, saves and returns the list.
export function rememberSeen(s: Store, names: string[]): string[] {
  const out = [...new Set([...readSeen(s), ...names].map((n) => n.toLowerCase()))].slice(-MAX_SEEN)
  try { s.setItem(SEEN_KEY, JSON.stringify(out)) } catch {}
  return out
}
export const clearSeen = (s: Store) => { try { s.removeItem(SEEN_KEY) } catch {} }

// Everything a new round must not return: the catalog, the library, what was suggested before, and what is on screen.
export const excludeList = (...lists: Iterable<string>[]): string[] => [...new Set(lists.flatMap((l) => [...l].map((n) => n.toLowerCase())))]

// What an Add found, in words. Only folders with a SKILL.md count as skills; a repo with none is kept as plain files the agents can read.
export function skillNote(repo: Pick<SkillRepo, 'skills' | 'total'>): { text: string; muted: boolean } {
  const real = repo.skills.filter((s) => /(^|[\\/])SKILL\.md$/.test(s.path))
  if (!real.length) return { text: 'No SKILL.md found: added as plain files the agents can read', muted: true }
  const n = Math.max(repo.total ?? 0, real.length)
  return { text: `${n} ${n === 1 ? 'skill' : 'skills'} found`, muted: false }
}
