import { randomUUID } from 'node:crypto'
import type { PlanItem } from './narrate'

// The plan is shared between the agent and the user. Both can change it; every change bumps `revision`, so a screen that
// was looking at an old version cannot overwrite a newer one without being told.

export type PlanStep = PlanItem & { id: string; skipped: boolean; userAdded?: boolean }
export type PlanState = { revision: number; items: PlanStep[] }

const MAX_STEPS = 30
const key = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ')
const newId = () => randomUUID().slice(0, 8)
const clean = (t: unknown) => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 120) : '')

export const emptyPlan = (): PlanState => ({ revision: 0, items: [] })

// The agent sends its whole checklist. Steps it already had keep their id and the user's "skip"; steps the user added
// that the agent did not list stay at the end, so the agent's rewrite never throws away what the user put there.
export function mergeAgentPlan(cur: PlanState, agent: PlanItem[]): PlanState {
  const byText = new Map(cur.items.map((s) => [key(s.text), s]))
  const used = new Set<string>()
  const items: PlanStep[] = agent.slice(0, MAX_STEPS).map((a) => {
    const old = byText.get(key(a.text))
    if (old) used.add(old.id)
    return { id: old?.id ?? newId(), text: a.text, status: a.status, skipped: old?.skipped ?? false }
  })
  const keptUserSteps = cur.items.filter((s) => !used.has(s.id) && s.userAdded)
  return { revision: cur.revision + 1, items: [...items, ...keptUserSteps].slice(0, MAX_STEPS) }
}

export type UserPlanResult = { plan: PlanState; conflict: boolean; changed: boolean }

// The user's edit: reorder, rename, skip, add, remove. A stale revision is refused and the current plan comes back.
export function applyUserPlan(cur: PlanState, revision: number, incoming: unknown): UserPlanResult {
  if (revision !== cur.revision || !Array.isArray(incoming)) return { plan: cur, conflict: true, changed: false }
  const known = new Map(cur.items.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const items: PlanStep[] = []
  for (const raw of incoming.slice(0, MAX_STEPS)) {
    const r = (raw ?? {}) as Partial<PlanStep>
    const text = clean(r.text)
    if (!text) continue
    const old = typeof r.id === 'string' ? known.get(r.id) : undefined
    const id = old && !seen.has(old.id) ? old.id : newId()
    seen.add(id)
    const status = r.status === 'done' || r.status === 'doing' || r.status === 'todo' ? r.status : (old?.status ?? 'todo')
    const step: PlanStep = { id, text, status, skipped: !!r.skipped }
    if (!old || old.userAdded) step.userAdded = true
    items.push(step)
  }
  const same = JSON.stringify(items.map(strip)) === JSON.stringify(cur.items.map(strip))
  return { plan: same ? cur : { revision: cur.revision + 1, items }, conflict: false, changed: !same }
}
const strip = (s: PlanStep) => ({ id: s.id, text: s.text, status: s.status, skipped: s.skipped })

// What the model is told after the user changes the plan.
export function planNote(before: PlanState, after: PlanState): string {
  const parts: string[] = []
  const was = new Map(before.items.map((s) => [s.id, s]))
  for (const s of after.items) {
    const o = was.get(s.id)
    if (!o) parts.push(`added a step: "${s.text}"`)
    else if (s.skipped && !o.skipped) parts.push(`skipped "${s.text}" (do not do it)`)
    else if (!s.skipped && o.skipped) parts.push(`brought back "${s.text}"`)
    else if (o.text !== s.text) parts.push(`renamed "${o.text}" to "${s.text}"`)
  }
  for (const o of before.items) if (!after.items.some((s) => s.id === o.id)) parts.push(`removed "${o.text}"`)
  const order = (p: PlanState) => p.items.filter((s) => was.has(s.id)).map((s) => s.id).join()
  if (!parts.length && order(before) !== order(after)) parts.push('reordered the steps')
  if (!parts.length) return ''
  const list = after.items.map((s, i) => `${i + 1}. ${s.skipped ? '(skipped) ' : ''}${s.text}`).join('\n')
  return `[Forge: the user changed your plan: ${parts.join('; ')}. The plan is now:\n${list}\nFollow it in this order and skip nothing marked skipped.]`
}

// A reopened chat: the last plan in the transcript is the current one. Old transcripts have no ids, so they are given some.
export function planFromTranscript(transcript: { type: string; items?: unknown; revision?: unknown }[]): PlanState {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i]
    if (t.type !== 'plan' || !Array.isArray(t.items)) continue
    const items = (t.items as Partial<PlanStep>[]).map((s) => ({ id: s.id ?? newId(), text: clean(s.text), status: s.status ?? 'todo', skipped: !!s.skipped })) as PlanStep[]
    return { revision: typeof t.revision === 'number' ? t.revision : 1, items }
  }
  return emptyPlan()
}
