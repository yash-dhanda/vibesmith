import type { Run, RunEvent, Task } from '../main/team/types'

export type LoggedTeamEvent = { t: number; ev: RunEvent }
export type TeamViewState = { run: Run; log: LoggedTeamEvent[]; liveFiles: Map<string, Task['changed']> }
const AGENT_LIMIT = 240
const OTHER_LIMIT = 200

const known = new Set(['run', 'plan', 'task', 'agent', 'live', 'message', 'approval', 'verify', 'usage', 'final'])

function bounded(log: LoggedTeamEvent[]) {
  const agent = { claude: 0, codex: 0 }, other: LoggedTeamEvent[] = [], kept: LoggedTeamEvent[] = []
  for (let i = log.length - 1; i >= 0; i--) {
    const item = log[i]
    if (item.ev.type === 'agent') {
      const name = item.ev.ev.agent
      if (agent[name]++ < AGENT_LIMIT) kept.push(item)
    } else if (other.length < OTHER_LIMIT) { other.push(item); kept.push(item) }
  }
  return kept.reverse()
}

function append(log: LoggedTeamEvent[], item: LoggedTeamEvent) {
  const event = item.ev
  if (event.type !== 'agent') return bounded([...log, item])
  const next = event.ev
  const same = (entry: LoggedTeamEvent) => entry.ev.type === 'agent' && entry.ev.taskId === event.taskId && entry.ev.phase === event.phase && entry.ev.ev.agent === next.agent
  const last = (match: (entry: LoggedTeamEvent) => boolean) => { for (let i = log.length - 1; i >= 0; i--) if (match(log[i])) return i; return -1 }
  let out = [...log]
  if (next.type === 'delta') {
    const index = last(entry => same(entry) && entry.ev.type === 'agent' && entry.ev.ev.type === 'delta' && entry.ev.ev.channel === next.channel && entry.ev.ev.id === next.id)
    if (index >= 0) {
      const previous = out[index].ev
      if (previous.type === 'agent' && previous.ev.type === 'delta') out[index] = { t: item.t, ev: { ...previous, ev: { ...previous.ev, text: previous.ev.text + next.text } } }
      return bounded(out)
    }
  } else if (next.type === 'code') {
    const index = last(entry => entry.ev.type === 'agent' && entry.ev.ev.type === 'code' && entry.ev.ev.agent === next.agent && entry.ev.ev.id === next.id)
    if (index >= 0) { out[index] = item; return bounded(out) }
  } else if (next.type === 'prompt') {
    const index = last(entry => same(entry) && entry.ev.type === 'agent' && entry.ev.ev.type === 'prompt')
    if (index >= 0) { out[index] = item; return bounded(out) }
  } else if (next.type === 'text') out = out.filter(entry => !(same(entry) && entry.ev.type === 'agent' && entry.ev.ev.type === 'delta' && entry.ev.ev.channel === 'text'))
  else if (next.type === 'tool_result') out = out.filter(entry => !(same(entry) && entry.ev.type === 'agent' && entry.ev.ev.type === 'delta' && entry.ev.ev.channel === 'output' && entry.ev.ev.id === next.id))
  return bounded([...out, item])
}

export function reduceTeamView(state: TeamViewState, raw: RunEvent | { type: string; [key: string]: unknown }, t = Date.now()): TeamViewState {
  if (!raw || !known.has(raw.type) || !('runId' in raw) || raw.runId !== state.run.id) return state
  const event = raw as RunEvent
  const changesRun = event.type === 'run' || event.type === 'plan' || event.type === 'task' || event.type === 'message' || event.type === 'approval' || event.type === 'usage' || event.type === 'final'
  const run = changesRun ? structuredClone(state.run) : state.run
  const liveFiles = new Map(state.liveFiles)
  let log = state.log
  if (event.type === 'live') liveFiles.set(event.taskId, event.files)
  else log = append(log, { t, ev: structuredClone(event) })
  if (event.type === 'run') { run.status = event.status; run.pausedReason = event.reason }
  else if (event.type === 'plan') { run.plan.summary = event.summary; run.tasks = event.tasks }
  else if (event.type === 'task') { const i = run.tasks.findIndex(task => task.id === event.task.id); if (i >= 0) run.tasks[i] = event.task; else run.tasks.push(event.task); if (event.task.status !== 'running') liveFiles.delete(event.task.id) }
  else if (event.type === 'message' && !run.messages.some(message => message.id === event.message.id)) run.messages.push(event.message)
  else if (event.type === 'approval') { const i = run.approvals.findIndex(item => item.id === event.approval.id); if (i >= 0) run.approvals[i] = event.approval; else run.approvals.push(event.approval) }
  else if (event.type === 'usage') run.usage = event.usage
  else if (event.type === 'final') { run.final = event.final; run.status = 'awaiting_approval'; liveFiles.clear() }
  return { run, log, liveFiles }
}

export function replayTeamView(run: Run, events: LoggedTeamEvent[]) {
  return events.map((item, index) => ({ ...item, index })).sort((a, b) => a.t - b.t || a.index - b.index).reduce<TeamViewState>((state, item) => reduceTeamView(state, item.ev, item.t), { run: structuredClone(run), log: [], liveFiles: new Map() })
}

export function normaliseTeamEvents(events: LoggedTeamEvent[]) {
  let log: LoggedTeamEvent[] = []
  const liveFiles = new Map<string, Task['changed']>()
  for (const item of events.map((entry, index) => ({ ...entry, index })).sort((a, b) => a.t - b.t || a.index - b.index)) {
    if (item.ev.type === 'live') liveFiles.set(item.ev.taskId, item.ev.files)
    else log = append(log, { t: item.t, ev: structuredClone(item.ev) })
  }
  return { log, liveFiles }
}
