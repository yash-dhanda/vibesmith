import { h } from './ui'
import { mark, type Mark } from './glyphs'

// The live checklist Claude Code shows: a hairline card, one row per step, the status mark (glyphs.ts) in a fixed column, then the words.
// Rows carry data-key, so morph() keeps them between renders: a new state flips data-state on the row and its mark, the glyphs crossfade
// in place, nothing moves and the arc never restarts.
export type CheckItem = { key: string; text: string; state: Mark; detail?: string }
const SAY: Record<Mark, string> = { pending: 'To do', active: 'In progress', done: 'Done', failed: 'Failed', skipped: 'Skipped', ask: 'Needs you' }

// At most `max` rows, from one row before the first unfinished step; the rest is counted in "+N more".
// `live` false (paused, stopped, finished) holds the arc still instead of spinning for nothing.
export function checklist(items: CheckItem[], { max = 8, live = true } = {}) {
  const list = h('ol', live ? 'ck live' : 'ck')
  const next = items.findIndex(i => i.state === 'active' || i.state === 'pending')
  const from = items.length <= max ? 0 : Math.min(Math.max(0, (next < 0 ? items.length : next) - 1), items.length - max)
  for (const item of items.slice(from, from + max)) {
    const row = h('li', 'ck-row'); row.dataset.key = item.key; row.dataset.state = item.state
    row.setAttribute('aria-label', `${SAY[item.state]}: ${item.text}${item.detail ? `, ${item.detail}` : ''}`)
    const text = h('span', 'ck-text', item.text)
    if (item.detail) text.append(h('span', 'ck-detail', item.detail))
    row.append(mark(item.state), text); list.append(row)
  }
  if (items.length > max) list.append(h('li', 'ck-more', `+${items.length - max} more`))
  return list
}

// Solo's update_plan steps as rows (saved transcripts may lack ids: the position stands in).
export const planItems = (steps: { id?: string; text: string; status: 'todo' | 'doing' | 'done'; skipped?: boolean }[]): CheckItem[] =>
  steps.map((s, i) => ({ key: s.id ?? String(i), text: s.text, state: s.skipped ? 'skipped' : s.status === 'doing' ? 'active' : s.status === 'done' ? 'done' : 'pending' }))
