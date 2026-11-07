import type { CrewStats } from '../main/registerProjectKnowledge'
import { formatTokens } from './format'
import { icon } from './icons'
import { AGENT_NAME } from './names'
import { cleanErr, h } from './ui'

const REFRESH_MS = 5000

export const seconds = (s: number) => (s < 1 ? '–' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`)
export const dollars = (n: number) => (n <= 0 ? '–' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

// Only says what the numbers support: nothing before a task has finished, and the plan share only when Codex reported its window.
export function forecastLine(f: CrewStats['forecast']): string {
  if (f.tasksLeft === 0) return f.tasksDone ? 'Every task is finished.' : ''
  const left = `${f.tasksLeft} remaining task${f.tasksLeft === 1 ? '' : 's'}`
  if (!f.tasksDone) return `No task has finished yet, so there is nothing to base an estimate on for the ${left}.`
  const mins = f.estMinutesLeft < 1 ? 'under a minute' : `about ${Math.round(f.estMinutesLeft)} min`
  const plan = f.estPlanPctLeft === undefined ? '' : ` and ~${f.estPlanPctLeft}% of the Codex window left afterwards`
  return `For the ${left}: up to ${mins} and about ${formatTokens(f.estTokensLeft)} tokens${plan}. This is an estimate from the average finished task, so it can be off.`
}

// "Cost and time" for the run screen: one row per task, the totals and the forecast. Read when opened, then at most every 5 seconds while the run
// is active, on the run page's 1 s clock (team.ts sends 'tick'). A fold that took it off the page and put it back gets fresh numbers on the next tick.
export function renderCrewStats(runId: string): HTMLDetailsElement {
  const root = h('details', 'crew-stats') as HTMLDetailsElement
  const sum = h('summary', '', 'Cost and time')
  sum.prepend(icon('coin', 'sm'))
  const body = h('div', 'cs-body')
  root.append(sum, body)

  let active = true
  let last = 0
  let busy = false

  function paint(s: CrewStats | null) {
    if (!s) return body.replaceChildren(h('p', 'cs-note', 'No numbers for this run yet.'))
    const table = document.createElement('table')
    table.className = 'cs-table'
    const hr = table.createTHead().insertRow()
    for (const t of ['Task', 'Time', 'Tokens', 'API-equivalent cost']) hr.append(Object.assign(document.createElement('th'), { textContent: t, scope: 'col' }))
    const tb = table.createTBody()
    let time = 0, tokens = 0, cost = 0
    for (const t of s.tasks) {
      time += t.seconds; tokens += t.tokens; cost += t.costUsd
      const tr = tb.insertRow()
      const who = h('span', 'cs-who')
      const dot = h('i', 'cs-dot')
      dot.dataset.agent = t.agent
      who.append(dot, h('span', 'cs-agent', AGENT_NAME[t.agent]))
      const first = tr.insertCell()
      first.append(who, h('span', 'cs-title', t.title))
      first.title = `${AGENT_NAME[t.agent]}: ${t.title}`
      tr.insertCell().textContent = seconds(t.seconds)
      tr.insertCell().textContent = t.tokens ? formatTokens(t.tokens) : '–'
      tr.insertCell().textContent = dollars(t.costUsd)
    }
    if (s.tasks.length > 1) {
      const tr = table.createTFoot().insertRow()
      tr.insertCell().textContent = 'Total'
      tr.insertCell().textContent = seconds(time)
      tr.insertCell().textContent = tokens ? formatTokens(tokens) : '–'
      tr.insertCell().textContent = dollars(cost)
    }
    const line = forecastLine(s.forecast)
    body.replaceChildren(table, ...(line ? [h('p', 'cs-forecast', line)] : []), h('p', 'cs-note', 'Cost is what the work would cost at API prices. Nothing is billed for it here.'))
    active = s.active
  }

  async function load() {
    if (busy || !root.open || !root.isConnected || Date.now() - last < REFRESH_MS - 250) return
    busy = true
    try { paint(await window.forge.teamStats(runId)); last = Date.now() } catch (e) { body.replaceChildren(h('p', 'errtext', cleanErr(e))) } finally { busy = false }
  }

  root.addEventListener('toggle', () => { if (root.open) { last = 0; active = true; void load() } })
  root.addEventListener('tick', () => { if (active) void load() })
  return root
}
