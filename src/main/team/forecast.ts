import type { AgentName } from './events'
import type { Run } from './types'

export type TaskStat = { id: string; agent: AgentName; seconds: number; tokens: number; costUsd: number }
export type Forecast = { tasksDone: number; tasksLeft: number; avgTokensPerTask: number; avgSecondsPerTask: number; estTokensLeft: number; estMinutesLeft: number; estPlanPctLeft?: number }

// What each task cost so far: time (a running task counts up to now), tokens (every turn of the task: work, review, fixes) and API-rate cost.
export const taskStats = (run: Run, now = Date.now()): TaskStat[] =>
  run.tasks.map((t) => ({ id: t.id, agent: t.agent, seconds: t.startedAt !== undefined ? Math.max(0, ((t.endedAt ?? (t.status === 'running' ? now : t.startedAt)) - t.startedAt) / 1000) : 0, tokens: t.usage.input + t.usage.output, costUsd: t.usage.costUsd }))

// What is left, from the average finished task. Tasks that are not done or cancelled count as left. `limits` defaults to the plan-window readings the run collected.
// ponytail: minutes assume the left tasks run one after another (an upper bound, tasks of different agents run in parallel); the plan share assumes the whole reading came from this run, so it errs low.
export function forecast(run: Run, limits: Run['limits'] = run.limits, now = Date.now()): Forecast {
  const stats = taskStats(run, now)
  const done = run.tasks.filter((t) => t.status === 'done')
  const doneIds = new Set(done.map((t) => t.id))
  const sample = stats.filter((s) => doneIds.has(s.id))
  const tasksLeft = run.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length
  const avgTokensPerTask = sample.length ? Math.round(sample.reduce((n, s) => n + s.tokens, 0) / sample.length) : 0
  const avgSecondsPerTask = sample.length ? Math.round(sample.reduce((n, s) => n + s.seconds, 0) / sample.length) : 0
  const estTokensLeft = avgTokensPerTask * tasksLeft
  const f: Forecast = { tasksDone: done.length, tasksLeft, avgTokensPerTask, avgSecondsPerTask, estTokensLeft, estMinutesLeft: Math.round((avgSecondsPerTask * tasksLeft) / 6) / 10 }
  // percent of the short plan window used per token, from the busiest agent that reported one
  let pctLeft: number | undefined
  for (const [a, l] of Object.entries(limits ?? {}) as [AgentName, NonNullable<NonNullable<Run['limits']>[AgentName]>][]) {
    const u = run.usage[a]
    const tokens = u ? u.input + u.output : 0
    if (!l || !tokens) continue
    const left = Math.max(0, 100 - l.primaryPct - (estTokensLeft * l.primaryPct) / tokens)
    pctLeft = pctLeft === undefined ? left : Math.min(pctLeft, left)
  }
  if (pctLeft !== undefined) f.estPlanPctLeft = Math.round(pctLeft)
  return f
}

// The agent that wrote most of the changed files of the finished build tasks, or null when nothing was written.
export function mainAuthor(run: Run): AgentName | null {
  const n = new Map<AgentName, number>()
  for (const t of run.tasks) if (t.status === 'done' && t.kind !== 'research' && !t.lastStep) n.set(t.agent, (n.get(t.agent) ?? 0) + t.changed.length)
  return [...n].sort((a, b) => b[1] - a[1]).find(([, c]) => c > 0)?.[0] ?? null
}
