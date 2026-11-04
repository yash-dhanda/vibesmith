import { icon } from './icons'
import { cleanErr, h, toast, writeClipboard } from './ui'

// What the ideas gallery and the improve dialog share: how a goal is handed to the Crew screen, and the expandable row that shows one.
// The Crew screen listens for 'forge-start-crew-goal'; newFolder asks for a fresh folder, reviewPlan for a plan the owner approves first.
export type CrewGoal = { goal: string; path?: string; newFolder?: boolean; reviewPlan?: boolean }
export const startCrewGoal = (d: CrewGoal) => window.dispatchEvent(new CustomEvent('forge-start-crew-goal', { detail: d }))

export const button = (label: string, run: () => void, cls = 'btn') => {
  const b = h('button', cls, label) as HTMLButtonElement
  b.type = 'button'
  b.onclick = run
  return b
}

export const copyText = (text: string) => writeClipboard(text).then(() => toast('Copied.'), (e) => toast(cleanErr(e), 4000))

// The goal as readable text that turns into a text box when the person wants to change it.
export function goalBox(goal: string) {
  const pre = h('pre', 'goal-text', goal)
  const area = document.createElement('textarea')
  area.className = 'goal-edit'
  area.value = goal
  area.rows = 9
  area.hidden = true
  area.setAttribute('aria-label', 'Goal for the crew')
  const el = h('div', 'goal-box')
  el.append(pre, area)
  return {
    el,
    text: () => (area.hidden ? goal : area.value.trim() || goal),
    edit() { pre.hidden = true; area.hidden = false; area.focus() },
  }
}

export type GoalItem = {
  title: string
  why: string
  goal: string
  startLabel: string
  path: string
  evidence?: string[]
  severity?: 'high' | 'medium' | 'low'
  meta?: string
  check?: HTMLInputElement
  onSkip?: () => void
  onStart?: () => void
}

// One row: a title that opens to the reason, the evidence, the goal text and the buttons that send it to the crew.
export function goalItem(o: GoalItem): HTMLElement {
  const row = h('article', 'gi')
  const head = h('div', 'gi-head')
  const toggle = h('button', 'gi-toggle') as HTMLButtonElement
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'false')
  if (o.severity) {
    const dot = h('span', 'gi-dot')
    dot.dataset.sev = o.severity
    dot.title = `${o.severity[0].toUpperCase()}${o.severity.slice(1)} severity`
    dot.setAttribute('role', 'img')
    dot.setAttribute('aria-label', dot.title)
    toggle.append(dot)
  }
  toggle.append(h('span', 'gi-title', o.title))
  if (o.meta) toggle.append(h('span', 'gi-meta', o.meta))
  toggle.append(icon('chevron', 'sm'))
  if (o.check) head.append(o.check)
  head.append(toggle)

  const body = h('div', 'gi-body')
  body.hidden = true
  const box = goalBox(o.goal)
  const act = h('div', 'gi-actions')
  act.append(button(o.startLabel, () => { startCrewGoal({ goal: box.text(), path: o.path }); o.onStart?.() }, 'btn primary'), button('Edit goal', box.edit))
  if (o.onSkip) act.append(button('Skip', o.onSkip, 'link-btn'))
  body.append(h('p', 'gi-why', o.why))
  if (o.evidence?.length) {
    const ev = h('ul', 'gi-evidence')
    for (const e of o.evidence) ev.append(h('li', '', e))
    body.append(ev)
  }
  body.append(box.el, act)
  toggle.onclick = () => { body.hidden = !body.hidden; toggle.setAttribute('aria-expanded', String(!body.hidden)) }
  row.append(head, body)
  return row
}
