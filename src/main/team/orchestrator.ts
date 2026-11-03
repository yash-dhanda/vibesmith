import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createCheckpoint } from '../checkpoint'
import { detectVerify, runVerify } from '../agent/commands'
import type { AgentName, ErrorKind, TeamEvent } from './events'
import { addTaskWorktree, abortMerge, applyResult, changedSince, commitAll, createRunBranch, diffText, finishMerge, head, mergeBranch, pruneWorktrees, removeWorktree, snapshotCommit } from './git'
import { TeamHub, type HubCtx } from './hub'
import { PERMISSION_TOOL, type TeamLink } from './link'
import type { ApprovalAsk, ServerHandle } from './codexServer'
import { errorSignature, ProjectMemoryStore, rank, routeAgent } from './memory'
import { decideCommand, decideTool } from './policy'
import { buildReport, conflictPrompt, contextFor, finalReviewPrompt, fixPrompt, parsePlan, parseVerdict, planPrompt, reviewPrompt, verifyFixPrompt, workPrompt } from './prompts'
import type { RunResult } from './process'
import { TeamStore } from './store'
import { DEFAULT_CONFIG, emptyUsage, type Approval, type ApprovalKind, type Message, type MessageKind, type Run, type RunEvent, type RunStatus, type Task, type TaskPhase, type TeamConfig } from './types'

export type AgentCall = {
  cwd: string; prompt: string; write: boolean; resume?: string; model?: string; signal: AbortSignal; link: TeamLink | null; taskId: string
  onEvent: (e: TeamEvent) => void
  effort?: string // Claude only
  codexMode?: 'exec' | 'app-server'
  onApproval?: (a: ApprovalAsk) => Promise<boolean> // Codex app-server asks before leaving its sandbox
  onHandle?: (h: ServerHandle | null) => void // lets the orchestrator steer a running agent
}
export type AgentRunner = (agent: AgentName, o: AgentCall) => Promise<RunResult>

export type Deps = {
  store: TeamStore
  teamDir: string // worktrees live under here, outside the project
  runner: AgentRunner
  available: () => Promise<AgentName[]> // which agents are installed and signed in
  codexModels: () => Promise<string[]>
  emit: (ev: RunEvent) => void
  projectNotes?: (project: string) => { brief: string; rules: string }
  mcpScript?: string // path to the bundled team-mcp.js; without it agents run without the mailbox
  node?: string
  sleep?: (ms: number) => Promise<void>
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn, fn)
    this.tail = r.catch(() => {})
    return r
  }
}

type Live = {
  ctl: AbortController
  stop: 'pause' | 'cancel' | null
  paused: boolean
  running: Map<string, Promise<void>>
  pending: Map<string, (a: { allow: boolean; note?: string }) => void>
  git: Mutex // short git admin steps (worktree add)
  merge: Mutex // one merge at a time, conflict resolution included
  available: AgentName[]
  finishing: boolean
  handles: Map<string, { agent: AgentName; h: ServerHandle }> // running agents that can be steered mid-turn
}

const other = (a: AgentName): AgentName => (a === 'claude' ? 'codex' : 'claude')
const id = (p: string) => `${p}${randomUUID().slice(0, 8)}`
const MAX_PROPOSALS = 6

export class TeamOrchestrator {
  private live = new Map<string, Live>()
  private hub: TeamHub
  private hubReady: Promise<string> | null = null

  constructor(private d: Deps) {
    this.hub = new TeamHub((op, args, ctx) => this.onHub(op, args, ctx))
  }

  // ------------------------------------------------------------------ public API

  // One in-memory copy of each run, so the scheduler, the agents' requests and the user's answers all change the same object.
  private runs = new Map<string, Run>()
  private runOf(runId: string): Run | null {
    let r = this.runs.get(runId) ?? null
    if (!r) {
      r = this.d.store.load(runId)
      if (r) this.runs.set(runId, r)
    }
    return r
  }
  list(): Run[] {
    return this.d.store.list().map((r) => this.runs.get(r.id) ?? r)
  }
  get(runId: string): Run | null {
    return this.runOf(runId)
  }
  events(runId: string, limit?: number) {
    return this.d.store.events(runId, limit)
  }
  shutdown() {
    for (const l of this.live.values()) {
      l.stop = 'pause'
      l.ctl.abort()
    }
    this.hub.stop()
  }

  // A run found half-done at startup is not resumed by itself (that would spend quota without being asked): it is marked interrupted.
  recoverAll() {
    for (const r of this.list()) {
      if (!this.runs.has(r.id)) this.runs.set(r.id, r)
      if (!['planning', 'running', 'verifying', 'paused'].includes(r.status)) continue
      for (const t of r.tasks) if (t.status === 'running') t.status = 'interrupted'
      for (const a of r.approvals) if (a.status === 'pending' && a.kind !== 'final') (a.status = 'expired'), (a.answeredAt = Date.now())
      r.status = 'interrupted'
      r.pausedReason = 'Forge was closed while this was running.'
      this.d.store.save(r)
    }
  }

  async start(project: string, goal: string, cfg: Partial<TeamConfig> = {}): Promise<Run> {
    const available = await this.d.available()
    if (!available.length) throw new Error('Neither Claude Code nor Codex is ready. Sign in to at least one of them first.')
    const config: TeamConfig = { ...DEFAULT_CONFIG, ...cfg, budget: { ...DEFAULT_CONFIG.budget, ...cfg.budget } }
    if (available.includes('codex') && !config.codexModel) {
      const m = await this.d.codexModels()
      config.codexModel = m.find((x) => /luna/.test(x)) ?? m.find((x) => /terra/.test(x)) ?? m[0] ?? ''
    }
    const runId = `r${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
    const baseCommit = await snapshotCommit(project)
    const integrationBranch = `forge/${runId}`
    const integrationWorktree = join(this.d.teamDir, 'wt', runId, 'integration')
    await createRunBranch(project, integrationBranch, baseCommit, integrationWorktree)
    const run: Run = { id: runId, project, goal: goal.trim(), status: 'planning', createdAt: Date.now(), updatedAt: Date.now(), baseCommit, integrationBranch, integrationWorktree, plan: { summary: '', plannedBy: null }, tasks: [], messages: [], decisions: [], errors: [], approvals: [], usage: { claude: emptyUsage(), codex: emptyUsage() }, config }
    this.runs.set(runId, run)
    this.d.store.save(run)
    const live = this.newLive(available)
    this.live.set(runId, live)
    this.out(run, { type: 'run', runId, status: 'planning' })
    void this.plan(run).then(() => this.pump(run)).catch((e) => this.fail(run, (e as Error).message))
    return run
  }

  pause(runId: string, hard = false) {
    const run = this.runOf(runId)
    const live = this.live.get(runId)
    if (!run || !live || !['running', 'planning'].includes(run.status)) return
    live.paused = true
    this.setStatus(run, 'paused', 'Paused by you.')
    if (hard) {
      live.stop = 'pause'
      live.ctl.abort()
    }
  }

  async resume(runId: string) {
    const run = this.runOf(runId)
    if (!run || !['paused', 'interrupted'].includes(run.status)) return
    const available = await this.d.available() // the user may have just signed an agent in
    if (!available.length) return void this.setStatus(run, run.status, 'Neither Claude Code nor Codex is signed in yet.')
    let live = this.live.get(runId)
    if (!live) {
      live = this.newLive(available)
      this.live.set(runId, live)
    }
    live.available = available
    if (live.stop) (live.ctl = new AbortController()), (live.stop = null)
    live.paused = false
    for (const t of run.tasks) {
      if (t.status === 'interrupted') (t.status = 'queued'), (t.phase = null)
      else if (t.status === 'blocked' && !/depends on failed/.test(t.error ?? '')) (t.status = 'queued'), (t.error = undefined) // blocked by a missing sign-in, which may be fixed now
    }
    this.setStatus(run, run.tasks.length ? 'running' : 'planning')
    if (!run.tasks.length) void this.plan(run).then(() => this.pump(run)).catch((e) => this.fail(run, (e as Error).message))
    else this.pump(run)
  }

  async cancel(runId: string) {
    const run = this.runOf(runId)
    const live = this.live.get(runId)
    if (!run || ['done', 'cancelled', 'failed'].includes(run.status)) return
    if (live) {
      live.stop = 'cancel'
      live.paused = true
      live.ctl.abort()
      for (const [aid, res] of live.pending) (this.markApproval(run, aid, 'denied', 'Run cancelled.'), res({ allow: false, note: 'Run cancelled.' }))
      live.pending.clear()
      await Promise.allSettled([...live.running.values()])
    }
    for (const t of run.tasks) if (!['done', 'failed'].includes(t.status)) t.status = 'cancelled'
    this.setStatus(run, 'cancelled', 'Cancelled by you.')
    await this.cleanup(run, true)
  }

  // Removes a finished run completely: its branches, worktrees, saved state and log. A run still in progress must be cancelled first.
  async deleteRun(runId: string): Promise<boolean> {
    const run = this.runOf(runId)
    if (!run) return false
    if (!['done', 'failed', 'cancelled', 'awaiting_approval'].includes(run.status)) return false
    if (run.status === 'awaiting_approval') await this.cleanup(run, true)
    else await this.cleanup(run, !run.applied).catch(() => {})
    this.runs.delete(runId)
    this.live.delete(runId)
    this.d.store.delete(runId)
    await rm(join(this.d.teamDir, 'wt', runId), { recursive: true, force: true }).catch(() => {})
    return true
  }

  // At startup: worktree folders and branches that belong to runs that are over (or gone) are leftovers of a crash. Remove them.
  async sweep() {
    const known = new Map(this.list().map((r) => [r.id, r]))
    let dirs: string[] = []
    try {
      dirs = await readdir(join(this.d.teamDir, 'wt'))
    } catch {}
    for (const id of dirs) {
      const r = known.get(id)
      if (r && !['done', 'failed', 'cancelled'].includes(r.status)) continue
      if (r) await this.cleanup(r, false).catch(() => {})
      await rm(join(this.d.teamDir, 'wt', id), { recursive: true, force: true }).catch(() => {})
    }
    for (const project of new Set(this.list().map((r) => r.project))) await pruneWorktrees(project)
  }

  answerApproval(runId: string, approvalId: string, allow: boolean, note?: string) {
    const run = this.runOf(runId)
    const live = this.live.get(runId)
    if (!run) return false
    const a = run.approvals.find((x) => x.id === approvalId)
    if (!a || a.status !== 'pending') return false
    const resolve = live?.pending.get(approvalId)
    if (!resolve) {
      this.markApproval(run, approvalId, 'expired', 'The agent that asked is no longer waiting.')
      return false
    }
    live!.pending.delete(approvalId)
    this.markApproval(run, approvalId, allow ? 'allowed' : 'denied', note)
    resolve({ allow, note })
    return true
  }

  // Say something to the team mid-run. It reaches every agent at the start of its next turn.
  steer(runId: string, text: string, to: AgentName | 'all' = 'all') {
    const run = this.runOf(runId)
    if (!run || !text.trim()) return
    const msg = this.post(run, { from: 'user', to, kind: 'steer', body: text.trim().slice(0, 2000) })
    // an agent that can take it mid-turn gets it now; the others read it at the start of their next turn
    for (const { agent, h } of this.liveOf(run).handles.values()) {
      if (to !== 'all' && to !== agent) continue
      void h.steer(`The user says: ${msg.body}`).then((ok) => ok && !msg.readBy.includes(agent) && msg.readBy.push(agent))
    }
  }

  retryTask(runId: string, taskId: string) {
    const run = this.runOf(runId)
    const t = run?.tasks.find((x) => x.id === taskId)
    if (!run || !t || !['failed', 'blocked', 'interrupted', 'cancelled'].includes(t.status)) return
    t.status = 'queued'
    t.error = undefined
    t.attempts = 0
    t.fixRounds = 0
    for (const o of run.tasks) if (o.status === 'blocked' && o.deps.includes(t.id)) (o.status = 'queued'), (o.error = undefined)
    void this.resume2(run)
  }
  skipTask(runId: string, taskId: string) {
    const run = this.runOf(runId)
    const t = run?.tasks.find((x) => x.id === taskId)
    if (!run || !t || ['done', 'running'].includes(t.status)) return
    t.status = 'cancelled'
    t.error = 'Skipped by you.'
    for (const o of run.tasks) if (o.status === 'blocked' && o.deps.includes(t.id)) (o.status = 'queued'), (o.error = undefined)
    void this.resume2(run)
  }
  private async resume2(run: Run) {
    if (run.status === 'paused' || run.status === 'interrupted' || run.status === 'failed') {
      run.status = run.status === 'failed' ? 'paused' : run.status
      this.d.store.save(run)
      await this.resume(run.id)
    } else this.touch(run)
    this.pump(run)
  }

  // The change for the diff view: one task's, or (no task) everything the team has merged so far.
  async diffFor(runId: string, taskId?: string): Promise<string> {
    const run = this.runOf(runId)
    if (!run) return ''
    const t = taskId ? run.tasks.find((x) => x.id === taskId) : undefined
    if (t) return t.worktree && t.base ? await diffText(t.worktree, t.base, 'HEAD', 60_000).catch(() => t.diff ?? '') : (t.diff ?? '')
    return diffText(run.integrationWorktree, run.baseCommit, 'HEAD', 120_000).catch(() => '')
  }

  extendBudget(runId: string, factor = 1.5) {
    const run = this.runOf(runId)
    if (!run) return
    const b = run.config.budget
    for (const k of ['maxTokens', 'maxMinutes', 'maxAgentRuns', 'maxCostUsd'] as const) if (b[k]) b[k] = Math.ceil(b[k]! * factor * 100) / 100
    const used = Math.max(0, ...Object.values(run.limits ?? {}).map((l) => l?.primaryPct ?? 0))
    if (run.config.maxLimitPercent && used >= run.config.maxLimitPercent) run.config.maxLimitPercent = Math.min(100, Math.ceil(used) + 5)
    this.d.store.save(run)
    if (run.status === 'paused') void this.resume(runId)
  }

  async approveFinal(runId: string): Promise<{ ok: boolean; message: string; checkpoint?: string }> {
    const run = this.runOf(runId)
    if (!run || run.status !== 'awaiting_approval') return { ok: false, message: 'This run is not waiting for approval.' }
    let checkpoint: string | undefined
    try {
      checkpoint = (await createCheckpoint(run.project)).id // so the normal Undo can take the whole result back out
    } catch {}
    const r = await applyResult(run.project, run.baseCommit, run.integrationBranch)
    const a = run.approvals.find((x) => x.kind === 'final' && x.status === 'pending')
    if (a) this.markApproval(run, a.id, r.ok ? 'allowed' : 'denied', r.message)
    if (!r.ok) return { ok: false, message: r.message }
    run.applied = true
    this.setStatus(run, 'done')
    await this.cleanup(run, true)
    return { ok: true, message: r.message, checkpoint }
  }

  async rejectFinal(runId: string) {
    const run = this.runOf(runId)
    if (!run || run.status !== 'awaiting_approval') return
    const a = run.approvals.find((x) => x.kind === 'final' && x.status === 'pending')
    if (a) this.markApproval(run, a.id, 'denied', 'Not applied.')
    this.setStatus(run, 'done', 'Result was not applied; it stays on branch ' + run.integrationBranch)
    await this.cleanup(run, false)
  }

  // ------------------------------------------------------------------ plumbing

  private newLive(available: AgentName[]): Live {
    return { ctl: new AbortController(), stop: null, paused: false, running: new Map(), pending: new Map(), git: new Mutex(), merge: new Mutex(), available, finishing: false, handles: new Map() }
  }
  private liveOf(run: Run): Live {
    let l = this.live.get(run.id)
    if (!l) this.live.set(run.id, (l = this.newLive(['claude', 'codex'])))
    return l
  }
  private out(run: Run, ev: RunEvent) {
    this.d.store.appendEvent(run.id, ev)
    this.d.emit(ev)
  }
  private touch(run: Run, task?: Task) {
    this.d.store.save(run)
    if (task) this.out(run, { type: 'task', runId: run.id, task })
  }
  private setStatus(run: Run, status: RunStatus, reason?: string) {
    run.status = status
    run.pausedReason = reason
    this.d.store.save(run)
    this.out(run, { type: 'run', runId: run.id, status, reason })
  }
  private fail(run: Run, message: string) {
    for (const t of run.tasks) if (t.status === 'running') t.status = 'failed'
    this.setStatus(run, 'failed', message)
  }
  private memory(run: Run) {
    return new ProjectMemoryStore(this.d.teamDir, run.project)
  }
  private sleep = (ms: number) => (this.d.sleep ? this.d.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)))

  private post(run: Run, m: { from: Message['from']; to: Message['to']; kind: MessageKind; body: string; taskId?: string }) {
    const msg: Message = { id: id('m'), at: Date.now(), readBy: [], ...m }
    run.messages.push(msg)
    this.d.store.save(run)
    this.out(run, { type: 'message', runId: run.id, message: msg })
    return msg
  }

  // Messages for this agent it has not seen, marked as seen. Steering from the user is returned separately.
  private drainInbox(run: Run, agent: AgentName): { inbox: Message[]; steer: string[] } {
    const mine = run.messages.filter((m) => !m.readBy.includes(agent) && m.from !== agent && (m.to === agent || m.to === 'all'))
    for (const m of mine) m.readBy.push(agent)
    return { inbox: mine.filter((m) => m.kind !== 'steer'), steer: mine.filter((m) => m.kind === 'steer').map((m) => m.body) }
  }

  private markApproval(run: Run, approvalId: string, status: Approval['status'], answer?: string) {
    const a = run.approvals.find((x) => x.id === approvalId)
    if (!a) return
    a.status = status
    a.answer = answer
    a.answeredAt = Date.now()
    this.d.store.save(run)
    this.out(run, { type: 'approval', runId: run.id, approval: a })
  }

  private async ask(run: Run, p: { kind: ApprovalKind; title: string; detail: string; taskId?: string; agent?: AgentName }): Promise<{ allow: boolean; note?: string }> {
    const live = this.liveOf(run)
    const a: Approval = { id: id('a'), status: 'pending', at: Date.now(), ...p }
    run.approvals.push(a)
    this.d.store.save(run)
    this.out(run, { type: 'approval', runId: run.id, approval: a })
    return new Promise((res) => live.pending.set(a.id, res))
  }

  private async ensureHub(): Promise<string> {
    return (this.hubReady ??= this.hub.start())
  }

  private async linkFor(run: Run, task: Task, agent: AgentName): Promise<TeamLink | null> {
    if (!this.d.mcpScript) return null
    return { sock: await this.ensureHub(), token: this.hub.token, runId: run.id, taskId: task.id, agent, script: this.d.mcpScript, node: this.d.node ?? process.execPath }
  }

  // The one place an agent is run: wires events, usage, session handles and the budget.
  private async agentRun(run: Run, task: Task, agent: AgentName, phase: TaskPhase | 'plan' | 'final-review', prompt: string, write: boolean, cwd: string, resume?: string): Promise<RunResult> {
    const live = this.liveOf(run)
    const res = await this.d.runner(agent, {
      cwd, prompt, write, resume, signal: live.ctl.signal, taskId: task.id, link: await this.linkFor(run, task, agent),
      model: agent === 'codex' ? run.config.codexModel : run.config.claudeModel,
      effort: agent === 'claude' ? run.config.claudeEffort : undefined,
      codexMode: run.config.codexMode,
      onEvent: (ev) => {
        if (ev.type === 'limits') {
          const { agent: _a, type: _t, ...rest } = ev
          ;(run.limits ??= {})[agent] = rest
        }
        this.out(run, { type: 'agent', runId: run.id, taskId: task.id, phase, ev })
      },
      onApproval: async (a) => {
        const v = a.command ? decideCommand(a.command) : { verdict: 'ask' as const, reason: '' }
        if (v.verdict === 'deny') return false
        return (await this.ask(run, { kind: 'permission', taskId: task.id, agent, title: a.title, detail: a.detail || v.reason })).allow
      },
      onHandle: (h) => (h ? live.handles.set(task.id, { agent, h }) : live.handles.delete(task.id)),
    })
    for (const u of [run.usage[agent], task.usage]) {
      u.input += res.usage.input
      u.output += res.usage.output
      u.cached += res.usage.cached
      u.costUsd += res.usage.costUsd
      u.runs++
    }
    this.out(run, { type: 'usage', runId: run.id, usage: run.usage })
    this.d.store.save(run)
    return res
  }

  private overBudget(run: Run): string | null {
    const b = run.config.budget
    const u = run.usage
    const tokens = u.claude.input + u.claude.output + u.codex.input + u.codex.output
    const runs = u.claude.runs + u.codex.runs
    const cost = u.claude.costUsd + u.codex.costUsd
    if (b.maxTokens && tokens >= b.maxTokens) return `token budget reached (${tokens.toLocaleString()} of ${b.maxTokens.toLocaleString()})`
    if (b.maxAgentRuns && runs >= b.maxAgentRuns) return `agent-run budget reached (${runs} of ${b.maxAgentRuns})`
    if (b.maxCostUsd && cost >= b.maxCostUsd) return `cost budget reached (about $${cost.toFixed(2)} of $${b.maxCostUsd})`
    if (b.maxMinutes && (Date.now() - run.createdAt) / 60_000 >= b.maxMinutes) return `time budget reached (${b.maxMinutes} minutes)`
    const cap = run.config.maxLimitPercent
    if (cap) for (const [a, l] of Object.entries(run.limits ?? {})) if (l && l.primaryPct >= cap) return `${a === 'codex' ? 'your ChatGPT plan' : 'your Claude plan'} allowance is ${Math.round(l.primaryPct)}% used`
    return null
  }

  // ------------------------------------------------------------------ planning

  private async plan(run: Run) {
    const live = this.liveOf(run)
    const notes = this.d.projectNotes?.(run.project) ?? { brief: '', rules: '' }
    const order: AgentName[] = run.config.planner === 'auto' ? (live.available.includes('claude') ? ['claude', 'codex'] : ['codex', 'claude']) : [run.config.planner, other(run.config.planner)]
    const planners = order.filter((a) => live.available.includes(a))
    const virtual = (): Task => ({ id: 'plan', title: 'Planning', goal: run.goal, acceptance: [], deps: [], agent: planners[0], kind: 'research', files: [], status: 'running', phase: null, attempts: 0, fixRounds: 0, reviews: [], sessions: {}, branch: null, worktree: null, summary: '', handoff: '', changed: [], usage: emptyUsage() })
    let lastErr = 'no planner'
    for (const agent of planners) {
      const t = virtual()
      let prompt = planPrompt(run.goal + (notes.rules ? `\n\nUser's rules for this project:\n${notes.rules}` : ''), notes.brief, live.available)
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await this.agentRun(run, t, agent, 'plan', prompt, false, run.integrationWorktree)
        if (live.ctl.signal.aborted) return
        if (!res.ok) {
          lastErr = res.error?.message ?? 'the planner failed'
          if (['auth', 'missing', 'model'].includes(res.error?.kind ?? '')) break // try the other agent
          continue
        }
        try {
          const plan = parsePlan(res.text, live.available, run.config.budget.maxTasks ?? 12)
          const mem = this.memory(run).load()
          run.plan = { summary: plan.summary, plannedBy: agent }
          run.tasks = plan.tasks.map((p) => ({ id: p.id, title: p.title, goal: p.goal, acceptance: p.acceptance, deps: p.deps, agent: p.agent ?? routeAgent(p.kind, live.available, mem.stats), kind: p.kind, files: p.files, status: 'queued', phase: null, attempts: 0, fixRounds: 0, reviews: [], sessions: {}, branch: null, worktree: null, summary: '', handoff: '', changed: [], usage: emptyUsage() }))
          this.setStatus(run, 'running')
          this.out(run, { type: 'plan', runId: run.id, summary: plan.summary, tasks: run.tasks })
          return
        } catch (e) {
          lastErr = (e as Error).message
          prompt = `${prompt}\n\nYour previous reply was rejected: ${lastErr}. Reply again with ONLY the JSON object.`
        }
      }
    }
    throw new Error(`Could not make a plan: ${lastErr}`)
  }

  // ------------------------------------------------------------------ scheduling

  private pump(run: Run) {
    const live = this.liveOf(run)
    if (live.paused || run.status !== 'running') return
    const why = this.overBudget(run)
    if (why) return void this.hitBudget(run, why)

    const settled = (t: Task) => t.status === 'done' || t.status === 'cancelled'
    for (const t of run.tasks) {
      if (t.status === 'queued' && t.deps.some((d) => run.tasks.find((x) => x.id === d)?.status === 'failed')) {
        t.status = 'blocked'
        t.error = 'A task it depends on failed.'
        this.touch(run, t)
      }
    }
    const perAgent = (a: AgentName) => [...live.running.keys()].filter((k) => run.tasks.find((t) => t.id === k)?.agent === a).length
    for (const t of run.tasks) {
      if (t.status !== 'queued' || live.running.has(t.id)) continue
      if (!t.deps.every((d) => settled(run.tasks.find((x) => x.id === d)!))) continue
      if (!live.available.includes(t.agent)) t.agent = live.available[0] ?? t.agent
      if (perAgent(t.agent) >= run.config.maxParallelPerAgent) continue
      const p = this.execute(run, t).catch((e) => this.failTask(run, t, (e as Error).message)).finally(() => (live.running.delete(t.id), this.pump(run)))
      live.running.set(t.id, p)
    }

    if (live.running.size) return
    const open = run.tasks.filter((t) => !settled(t))
    if (!open.length && run.tasks.some((t) => t.status === 'done')) return void this.finish(run)
    if (!open.length) return void this.setStatus(run, 'done', 'Nothing was done.')
    if (open.some((t) => t.status === 'queued' && t.deps.every((d) => settled(run.tasks.find((x) => x.id === d)!)))) return // ready, about to start
    // nothing can move: failures or blocked tasks need the user
    const bad = open.find((t) => t.status === 'failed' || t.status === 'blocked')
    live.paused = true
    this.setStatus(run, 'paused', bad ? `"${bad.title}" needs attention: ${bad.error ?? bad.status}. Retry or skip it.` : 'Waiting.')
  }

  private async hitBudget(run: Run, why: string) {
    const live = this.liveOf(run)
    live.paused = true
    this.setStatus(run, 'paused', `Stopped: ${why}.`)
    const r = await this.ask(run, { kind: 'budget', title: 'Budget reached', detail: `${why}. Allow 50% more and continue?` })
    if (r.allow) this.extendBudget(run.id)
  }

  // ------------------------------------------------------------------ one task

  private async ensureWorktree(run: Run, task: Task): Promise<string> {
    const live = this.liveOf(run)
    const wt = join(this.d.teamDir, 'wt', run.id, task.id)
    const branch = `forge/${run.id}-${task.id}`
    await live.git.run(() => addTaskWorktree(run.project, wt, branch, run.integrationBranch))
    task.worktree = wt
    task.branch = branch
    task.base ??= (await head(wt)) ?? undefined
    return wt
  }

  private stopKind(run: Run): 'pause' | 'cancel' | null {
    const l = this.liveOf(run)
    return l.ctl.signal.aborted ? (l.stop ?? 'cancel') : null
  }

  private failTask(run: Run, task: Task, message: string) {
    if (this.stopKind(run)) return this.interrupted(run, task)
    task.status = 'failed'
    task.phase = null
    task.error = message.slice(0, 500)
    task.endedAt = Date.now()
    run.errors.push({ id: id('e'), taskId: task.id, signature: errorSignature(message), text: message.slice(0, 500), at: Date.now() })
    this.memory(run).recordOutcome(task.agent, task.kind, false)
    this.post(run, { from: 'orchestrator', to: 'all', kind: 'note', taskId: task.id, body: `Task "${task.title}" failed: ${message.slice(0, 300)}` })
    this.touch(run, task)
  }
  private interrupted(run: Run, task: Task) {
    task.status = this.stopKind(run) === 'pause' ? 'interrupted' : 'cancelled'
    task.phase = null
    this.touch(run, task)
  }

  private async execute(run: Run, task: Task) {
    const live = this.liveOf(run)
    task.status = 'running'
    task.phase = 'work'
    task.error = undefined
    task.startedAt ??= Date.now()
    this.touch(run, task)

    const notes = this.d.projectNotes?.(run.project) ?? { brief: '', rules: '' }
    const past = this.pastProblems(run, task)
    const build = task.kind === 'build'
    const cwd = build ? await this.ensureWorktree(run, task) : run.integrationWorktree

    // ---- the work, with retries for the failures a retry can fix
    let res: RunResult | null = null
    for (;;) {
      const { inbox, steer } = this.drainInbox(run, task.agent)
      const prompt = workPrompt(run, task, contextFor(run, task, { inbox, steer, brief: notes.brief, rules: notes.rules, past }))
      res = await this.agentRun(run, task, task.agent, 'work', prompt, build, cwd, task.sessions[task.agent])
      if (res.sessionId) task.sessions[task.agent] = res.sessionId
      if (this.stopKind(run)) return this.interrupted(run, task)
      if (res.ok) break
      const kind: ErrorKind = res.error?.kind ?? 'other'
      const msg = res.error?.message ?? 'the agent failed'
      if (kind === 'auth' || kind === 'missing' || kind === 'model') return this.blockTask(run, task, `${task.agent}: ${msg}`, true)
      task.attempts++
      if (kind === 'limit' && task.attempts <= 3) {
        this.post(run, { from: 'orchestrator', to: 'all', kind: 'note', taskId: task.id, body: `${task.agent} hit a usage limit; waiting before trying again.` })
        await this.sleep(60_000 * task.attempts)
        if (this.stopKind(run)) return this.interrupted(run, task)
        continue
      }
      if (task.attempts > 2 || kind === 'limit') return this.failTask(run, task, `${task.agent}: ${msg}`)
      this.touch(run, task)
    }
    task.summary = res.text
    if (!task.handoff) task.handoff = res.text.slice(0, 1500)

    if (!build) return this.complete(run, task, `Research done: ${task.title}`)

    // ---- commit what the agent left, see what changed
    await commitAll(cwd, `${task.id}: ${task.title}`)
    task.changed = await changedSince(cwd, task.base!)
    this.touch(run, task)
    if (!task.changed.length) return this.complete(run, task, `${task.title}: finished without changing any file.`)

    // ---- review gate: the other agent reads the diff and says pass or fail; fail goes back to the author
    if (run.config.review === 'cross') {
      const reviewer = live.available.includes(other(task.agent)) ? other(task.agent) : task.agent
      for (let round = 1; ; round++) {
        task.phase = 'review'
        this.touch(run, task)
        const diff = await diffText(cwd, task.base!)
        const { inbox, steer } = this.drainInbox(run, reviewer)
        const rr = await this.agentRun(run, task, reviewer, 'review', reviewPrompt(run, task, diff, round, contextFor(run, task, { inbox, steer, brief: notes.brief, rules: notes.rules, past: [] })), false, cwd, round > 1 ? task.reviewSession : undefined)
        if (rr.sessionId) task.reviewSession = rr.sessionId
        if (this.stopKind(run)) return this.interrupted(run, task)
        const v = rr.ok ? parseVerdict(rr.text) : { verdict: 'unclear' as const, issues: `Review could not run: ${rr.error?.message ?? 'unknown error'}` }
        task.reviews.push({ by: reviewer, verdict: v.verdict, issues: v.issues, round, at: Date.now() })
        this.post(run, { from: reviewer, to: task.agent, kind: 'review', taskId: task.id, body: `${v.verdict.toUpperCase()} (round ${round}): ${v.issues.slice(0, 600) || 'no issues listed'}` })
        this.touch(run, task)
        if (v.verdict !== 'fail') break
        if (task.fixRounds >= run.config.maxFixRounds) {
          const a = await this.ask(run, { kind: 'review_override', taskId: task.id, agent: reviewer, title: `Reviewer still rejects "${task.title}"`, detail: `After ${task.fixRounds} fix rounds ${reviewer} still reports problems:\n\n${v.issues.slice(0, 1500)}\n\nMerge it anyway?` })
          if (this.stopKind(run)) return this.interrupted(run, task)
          if (a.allow) break
          return this.failTask(run, task, `Review kept failing after ${task.fixRounds} fix rounds.`)
        }
        task.fixRounds++
        task.phase = 'fix'
        this.touch(run, task)
        const fx = await this.agentRun(run, task, task.agent, 'fix', fixPrompt(task, v.issues, round), true, cwd, task.sessions[task.agent])
        if (fx.sessionId) task.sessions[task.agent] = fx.sessionId
        if (this.stopKind(run)) return this.interrupted(run, task)
        if (!fx.ok) return this.failTask(run, task, `fix round failed: ${fx.error?.message ?? 'unknown'}`)
        task.summary = fx.text || task.summary
        await commitAll(cwd, `${task.id}: fixes after review ${round}`)
        task.changed = await changedSince(cwd, task.base!)
      }
    }

    task.diff = await diffText(cwd, task.base!, 'HEAD', 60_000).catch(() => '')

    // ---- merge into the team branch, one at a time; a conflict is handed to an agent
    await live.merge.run(async () => {
      task.phase = 'merge'
      this.touch(run, task)
      const m = await mergeBranch(run.integrationWorktree, task.branch!, `${task.id}: ${task.title}`)
      if (m.ok) return
      task.phase = 'conflict'
      this.touch(run, task)
      const resolver: AgentName = live.available.includes('claude') ? 'claude' : 'codex'
      this.post(run, { from: 'orchestrator', to: resolver, kind: 'note', taskId: task.id, body: `Merge conflict in ${m.conflicts.join(', ')}; ${resolver} is resolving it.` })
      const rr = await this.agentRun(run, task, resolver, 'conflict', conflictPrompt(task, m.conflicts), true, run.integrationWorktree)
      const fin = rr.ok ? await finishMerge(run.integrationWorktree) : { ok: false, left: m.conflicts }
      if (!fin.ok) {
        await abortMerge(run.integrationWorktree)
        throw new Error(`Could not resolve the merge conflict in ${fin.left.join(', ')}.`)
      }
    })
    if (this.stopKind(run)) return this.interrupted(run, task)
    await this.complete(run, task, `${task.title} is merged.`)
  }

  private async blockTask(run: Run, task: Task, message: string, pauseRun: boolean) {
    task.status = 'blocked'
    task.phase = null
    task.error = message.slice(0, 400)
    this.touch(run, task)
    if (pauseRun) {
      this.liveOf(run).paused = true
      this.setStatus(run, 'paused', message)
    }
  }

  private async complete(run: Run, task: Task, note: string) {
    task.status = 'done'
    task.phase = null
    task.error = undefined
    task.endedAt = Date.now()
    this.memory(run).recordOutcome(task.agent, task.kind, true)
    this.post(run, { from: task.agent, to: 'all', kind: 'handoff', taskId: task.id, body: `${note} ${task.handoff.slice(0, 600)}`.trim() })
    this.touch(run, task)
    if (task.worktree) {
      await this.liveOf(run).git.run(() => removeWorktree(run.project, task.worktree!, task.branch ?? undefined))
      task.worktree = null
    }
  }

  private pastProblems(run: Run, task: Task): string[] {
    const m = this.memory(run).load()
    const docs = m.errors.map((e) => ({ text: `${e.text}${e.fix ? ` -> fixed by: ${e.fix}` : ''}` }))
    return rank(docs, `${task.title} ${task.goal}`, 3).map((d) => d.text.slice(0, 300))
  }

  // ------------------------------------------------------------------ finishing: checks, a last look, the report

  private async finish(run: Run) {
    const live = this.liveOf(run)
    if (live.finishing) return
    live.finishing = true
    try {
      this.setStatus(run, 'verifying')
      const wt = run.integrationWorktree
      const cmd = run.config.verify === undefined ? detectVerify(wt) : run.config.verify
      let verify: { ok: boolean | null; command?: string; output?: string } = { ok: null }
      if (cmd) {
        for (let round = 0; ; round++) {
          const v = await runVerify(cmd, wt, live.ctl.signal)
          if (live.ctl.signal.aborted) return
          verify = { ok: v.ok, command: cmd, output: v.output }
          this.out(run, { type: 'verify', runId: run.id, command: cmd, ok: v.ok, output: v.output.slice(-4000) })
          if (v.ok) {
            this.learnFix(run, undefined)
            break
          }
          const sig = errorSignature(v.output)
          run.errors.push({ id: id('e'), signature: sig, text: v.output.slice(-400), at: Date.now() })
          if (round >= run.config.maxVerifyRounds) break
          const fixer: AgentName = live.available.includes('claude') ? 'claude' : 'codex'
          const t = this.addTask(run, { title: `Fix failing checks (attempt ${round + 1})`, goal: `Make \`${cmd}\` pass.`, agent: fixer, kind: 'build' })
          t.status = 'running'
          t.phase = 'fix'
          t.startedAt = Date.now()
          this.touch(run, t)
          const past = this.pastProblems(run, t)
          const res = await this.agentRun(run, t, fixer, 'fix', verifyFixPrompt(cmd, v.output, round + 1) + (past.length ? `\n\nSimilar problems met before:\n${past.map((p) => `- ${p}`).join('\n')}` : ''), true, wt)
          if (res.sessionId) t.sessions[fixer] = res.sessionId
          if (live.ctl.signal.aborted) return
          t.summary = res.text
          await commitAll(wt, `fix: failing checks (attempt ${round + 1})`)
          t.changed = await changedSince(wt, run.baseCommit)
          t.status = res.ok ? 'done' : 'failed'
          t.error = res.ok ? undefined : res.error?.message
          t.endedAt = Date.now()
          this.touch(run, t)
          this.learnFix(run, res.ok ? res.text : undefined, sig)
        }
      }

      const notes: string[] = []
      const total = await changedSince(wt, run.baseCommit).catch(() => [])
      if (run.config.finalReview && run.config.review === 'cross' && total.length) {
        const reviewer: AgentName = live.available.includes('claude') ? 'claude' : 'codex'
        const t = this.virtualTask(run, 'final', 'Final review', reviewer)
        const rr = await this.agentRun(run, t, reviewer, 'final-review', finalReviewPrompt(run, await diffText(wt, run.baseCommit)), false, wt)
        if (live.ctl.signal.aborted) return
        if (rr.ok) {
          const v = parseVerdict(rr.text)
          notes.push(`${reviewer}: ${v.verdict.toUpperCase()} — ${v.issues.replace(/\s+/g, ' ').slice(0, 500)}`)
          this.post(run, { from: reviewer, to: 'user', kind: 'review', body: `Final review: ${v.verdict.toUpperCase()}. ${v.issues.slice(0, 600)}` })
          if (v.verdict === 'fail') {
            const author: AgentName = other(reviewer) && live.available.includes(other(reviewer)) ? other(reviewer) : reviewer
            const ft = this.addTask(run, { title: 'Fix problems from the final review', goal: v.issues, agent: author, kind: 'build' })
            ft.status = 'running'
            ft.phase = 'fix'
            this.touch(run, ft)
            const fx = await this.agentRun(run, ft, author, 'fix', fixPrompt(ft, v.issues, 1), true, wt)
            if (live.ctl.signal.aborted) return
            await commitAll(wt, 'fix: final review')
            ft.changed = await changedSince(wt, run.baseCommit)
            ft.status = fx.ok ? 'done' : 'failed'
            ft.summary = fx.text
            this.touch(run, ft)
          }
        }
      }

      const files = await changedSince(wt, run.baseCommit).catch(() => [])
      const report = buildReport(run, verify, notes)
      run.final = { report, files, verifyOk: verify.ok, verifyOutput: (verify.output ?? '').slice(-2000), reviewNotes: notes }
      this.out(run, { type: 'final', runId: run.id, final: run.final })
      this.setStatus(run, 'awaiting_approval')
      const a: Approval = { id: id('a'), kind: 'final', status: 'pending', at: Date.now(), title: 'Apply the result to your project?', detail: `${files.length} file${files.length === 1 ? '' : 's'} changed.${verify.ok === false ? ' The final check FAILED.' : ''}` }
      run.approvals.push(a)
      this.d.store.save(run)
      this.out(run, { type: 'approval', runId: run.id, approval: a })
    } catch (e) {
      this.fail(run, (e as Error).message)
    } finally {
      live.finishing = false
    }
  }

  private learnFix(run: Run, fix: string | undefined, sig?: string) {
    const e = [...run.errors].reverse().find((x) => !x.taskId && (!sig || x.signature === sig))
    if (e && fix) {
      e.fix = fix.replace(/\s+/g, ' ').slice(0, 300)
      this.memory(run).update((m) => void m.errors.push(e))
    }
  }

  private virtualTask(run: Run, tid: string, title: string, agent: AgentName): Task {
    return { id: tid, title, goal: run.goal, acceptance: [], deps: [], agent, kind: 'research', files: [], status: 'running', phase: null, attempts: 0, fixRounds: 0, reviews: [], sessions: {}, branch: null, worktree: null, summary: '', handoff: '', changed: [], usage: emptyUsage() }
  }
  private addTask(run: Run, p: { title: string; goal: string; agent: AgentName; kind: Task['kind']; deps?: string[]; acceptance?: string[]; proposedBy?: string }): Task {
    const n = run.tasks.reduce((m, t) => Math.max(m, Number(t.id.replace(/\D/g, '')) || 0), 0) + 1
    const t: Task = { ...this.virtualTask(run, `t${n}`, p.title, p.agent), goal: p.goal, kind: p.kind, deps: p.deps ?? [], acceptance: p.acceptance ?? [], status: 'queued', proposedBy: p.proposedBy }
    run.tasks.push(t)
    this.touch(run, t)
    return t
  }

  private async cleanup(run: Run, deleteBranch: boolean) {
    const live = this.liveOf(run)
    await live.git.run(async () => {
      for (const t of run.tasks) if (t.worktree) (await removeWorktree(run.project, t.worktree, t.branch ?? undefined), (t.worktree = null))
      await removeWorktree(run.project, run.integrationWorktree, deleteBranch ? run.integrationBranch : undefined)
    })
    this.d.store.save(run)
  }

  // ------------------------------------------------------------------ what agents ask for through the mailbox

  private async onHub(op: string, args: any, ctx: HubCtx): Promise<unknown> {
    const run = this.runOf(ctx.runId)
    if (!run) throw new Error('unknown run')
    const task = run.tasks.find((t) => t.id === ctx.taskId)
    const str = (v: unknown, n = 2000) => String(v ?? '').slice(0, n)
    switch (op) {
      case 'post': {
        const to = args.to === 'claude' || args.to === 'codex' || args.to === 'user' ? args.to : 'all'
        const kind: MessageKind = ['finding', 'question', 'review', 'decision', 'note'].includes(args.kind) ? args.kind : 'note'
        this.post(run, { from: ctx.agent, to, kind, taskId: ctx.taskId, body: str(args.body) })
        return 'posted'
      }
      case 'inbox': {
        const { inbox, steer } = this.drainInbox(run, ctx.agent)
        this.d.store.save(run)
        return [...steer.map((b) => ({ from: 'user', kind: 'instruction', body: b })), ...inbox.map((m) => ({ from: m.from, kind: m.kind, body: m.body }))]
      }
      case 'context': {
        const mem = this.memory(run).load()
        const docs = [...run.decisions.map((d) => ({ text: `Decision: ${d.text}` })), ...run.messages.filter((m) => ['finding', 'decision', 'handoff'].includes(m.kind)).map((m) => ({ text: `${m.from}: ${m.body}` })), ...mem.decisions.map((d) => ({ text: `Earlier decision: ${d.text}` })), ...mem.errors.map((e) => ({ text: `Earlier problem: ${e.text}${e.fix ? ` (fix: ${e.fix})` : ''}` }))]
        return rank(docs, str(args.query, 300), 6).map((d) => d.text.slice(0, 500))
      }
      case 'decision': {
        const text = str(args.text, 500)
        run.decisions.push({ id: id('d'), text, by: ctx.agent, taskId: ctx.taskId, at: Date.now() })
        this.post(run, { from: ctx.agent, to: 'all', kind: 'decision', taskId: ctx.taskId, body: text })
        this.memory(run).update((m) => void m.decisions.push(run.decisions.at(-1)!))
        return 'recorded'
      }
      case 'handoff': {
        if (task) {
          task.handoff = str(args.notes, 3000)
          this.touch(run, task)
        }
        return 'recorded'
      }
      case 'request_approval': {
        const r = await this.ask(run, { kind: 'action', taskId: ctx.taskId, agent: ctx.agent, title: str(args.title, 200), detail: str(args.detail, 2000) })
        return r.allow ? `allowed${r.note ? `: ${r.note}` : ''}` : `denied${r.note ? `: ${r.note}` : ''}. Do not do it; find another way or stop.`
      }
      case 'permission': {
        const input = (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>
        const v = decideTool(str(args.tool_name, 80), input, task?.worktree ?? run.integrationWorktree)
        if (v.verdict === 'allow') return JSON.stringify({ behavior: 'allow', updatedInput: input })
        if (v.verdict === 'deny') return JSON.stringify({ behavior: 'deny', message: `Not allowed: ${v.reason}` })
        const what = args.tool_name === 'Bash' ? str(input.command, 300) : `${args.tool_name} ${str(input.file_path ?? input.path ?? '', 200)}`
        const r = await this.ask(run, { kind: 'permission', taskId: ctx.taskId, agent: ctx.agent, title: `${ctx.agent} wants to: ${what}`, detail: v.reason })
        return JSON.stringify(r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: r.note || 'The user said no.' })
      }
      case 'tasks':
        return run.tasks.map((t) => ({ id: t.id, title: t.title, agent: t.agent, status: t.status }))
      case 'propose_subtask': {
        if (!run.config.allowSubtasks) return 'Subtasks are turned off for this run.'
        if (task?.proposedBy) return 'A subtask cannot propose more subtasks.'
        if (run.tasks.filter((t) => t.proposedBy).length >= MAX_PROPOSALS || run.tasks.length >= (run.config.budget.maxTasks ?? 12)) return 'The team already has as many tasks as allowed.'
        const avail = this.liveOf(run).available
        const agent: AgentName = args.agent === 'claude' || args.agent === 'codex' ? (avail.includes(args.agent) ? args.agent : avail[0]) : routeAgent('build', avail, this.memory(run).load().stats)
        const t = this.addTask(run, { title: str(args.title, 120), goal: str(args.goal, 2000), agent, kind: 'build', acceptance: Array.isArray(args.acceptance) ? args.acceptance.map((x: unknown) => str(x, 300)).slice(0, 4) : [], proposedBy: ctx.taskId })
        this.post(run, { from: ctx.agent, to: 'all', kind: 'note', taskId: ctx.taskId, body: `Added task ${t.id} "${t.title}" for ${agent}.` })
        setTimeout(() => this.pump(run), 0)
        return `added as ${t.id}, assigned to ${agent}`
      }
      default:
        throw new Error(`unknown operation ${op}`)
    }
  }
}

export { PERMISSION_TOOL }
