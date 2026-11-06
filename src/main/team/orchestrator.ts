import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createCheckpoint, git, undoTo } from '../checkpoint'
import { detectVerify, runVerify } from '../agent/commands'
import { AGENTS, isAgent, type AgentName, type ErrorKind, type TeamEvent } from './events'
import { addTaskWorktree, abortMerge, applyResult, changedSince, commitAll, createRunBranch, diffText, finishMerge, head, mergeBranch, pruneWorktrees, removeWorktree, snapshotCommit, snapshotTreeWithoutSecrets } from './git'
import { TeamHub, type HubCtx } from './hub'
import { PERMISSION_TOOL, type TeamLink } from './link'
import { redact, redactEvent } from './redact'
import type { ApprovalAsk, ServerHandle } from './codexServer'
import { errorSignature, ProjectMemoryStore, rank, routeAgent } from './memory'
import { decideCommand, decideTool } from './policy'
import { attachmentsBlock, imagePaths, removeAttachmentDirs } from './attach'
import { historyBlock, HistoryRecorder, HISTORY_DIR, writeHistory } from './history'
import { buildReport, conflictPrompt, contextFor, finalReviewPrompt, fixPrompt, forLocal, parsePlan, parseVerdict, parseReplan, planPrompt, replanPrompt, reviewPrompt, wantsSpeed, securityReviewPrompt, verifyFixPrompt, workPrompt } from './prompts'
import { effortFor } from './effort'
import { forecast, mainAuthor, taskStats } from './forecast'
import { onlyDocsOrConfig, touchesSecurity } from './security'
import type { RunResult } from './process'
import { TeamStore } from './store'
import { isRunAppWords, isStopAppWords } from './runapp'
import { reviewImagesBlock } from './visual'
import { DEFAULT_CONFIG, emptyUsage, type Approval, type ApprovalKind, type Message, type MessageKind, type Run, type RunEvent, type RunStatus, type Task, type TaskPhase, type TeamConfig, type TeamLandings } from './types'

export type AgentCall = {
  cwd: string; prompt: string; write: boolean; resume?: string; model?: string; signal: AbortSignal; link: TeamLink | null; taskId: string
  onEvent: (e: TeamEvent) => void
  effort?: string // the reasoning effort for this agent (Claude or Codex)
  codexMode?: 'exec' | 'app-server'
  onApproval?: (a: ApprovalAsk) => Promise<boolean> // Codex app-server asks before leaving its sandbox
  onHandle?: (h: ServerHandle | null) => void // lets the orchestrator steer a running agent
  web?: boolean // may search the web and read pages
  images?: string[] // pictures to show the agent directly (Codex): the user's pictures and video frames
  addDirs?: string[] // extra folders the agent may read (the skill libraries)
}
export type AgentRunner = (agent: AgentName, o: AgentCall) => Promise<RunResult>

export type Deps = {
  store: TeamStore
  teamDir: string // worktrees live under here, outside the project
  runner: AgentRunner
  available: () => Promise<AgentName[]> // which agents are installed and signed in
  codexModels: () => Promise<string[]>
  localModels?: () => Promise<string[]>
  emit: (ev: RunEvent) => void
  projectNotes?: (project: string) => { brief: string; rules: string }
  recordUsage?: (agent: AgentName, u: { input: number; output: number }) => void // feeds the daily token ledger
  visualShots?: (run: Run) => Promise<{ route: string; size: string; path: string }[]> // screenshots of the running site for the final review
  runApp?: (run: Run) => Promise<{ ok: boolean; message: string }> // "run website": starts the project's dev server
  stopApp?: (run: Run) => { ok: boolean; message: string }
  limits?: () => Promise<Partial<Record<AgentName, { primaryPct: number; primaryResetsAt?: number; secondaryPct?: number; secondaryResetsAt?: number }>>> // plan allowance used, when an agent can say
  skills?: () => { block: string; dirs: string[] } // the skill libraries the user added: what agents are told, and folders Claude may read
  localSkills?: () => string // the debugging and verification skills as text: the local model cannot open the skill folders
  mcpScript?: string // path to the bundled team-mcp.js; without it agents run without the mailbox
  node?: string
  sleep?: (ms: number) => Promise<void>
}

// The user asked for the local model by name in a message sent to everyone.
export const asksForLocal = (text: string) => /\b(?:let|use|using|ask|by|mainly|mostly|only|with|give (?:it )?to|make)\s+(?:the\s+)?local(?:\s+(?:ai|model|agent|llm))?\b/i.test(text)

class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn, fn)
    this.tail = r.catch(() => {})
    return r
  }
}

type Live = {
  shots?: { route: string; size: string; path: string }[] // page screenshots taken for the final review

  ctl: AbortController
  stop: 'pause' | 'cancel' | null
  paused: boolean
  running: Map<string, Promise<void>>
  pending: Map<string, (a: { allow: boolean; note?: string }) => void>
  budgetAsk: boolean // one "budget reached" question at a time, however many tasks hit the limit together
  git: Mutex // short git admin steps (worktree add)
  merge: Mutex // one merge at a time, conflict resolution included
  available: AgentName[]
  finishing: boolean
  handles: Map<string, { agent: AgentName; h: ServerHandle }> // running agents that can be steered mid-turn
  planning: boolean // a planner is running: a second one must not start beside it
  replans: number // newer requests still being planned: the run is not finished while any is
  replanChain: Promise<unknown> // one request is planned at a time, in the order they were sent
  late: { body: string; to: AgentName | 'all' }[] // messages sent while the last checks ran, which no task would read
  limited: Map<AgentName, number> // agents whose plan ran out in this run, with the time it comes back (0 = unknown: out for the rest of the run)
  bg: Set<Promise<unknown>> // the planner and the last steps: turns that are not tasks, but must have stopped before a resume replaces the controller
}

// Who does a job: the strongest agent that is ready (Claude, then Codex, then the local model), optionally not the one that wrote the work.
const PREFER: AgentName[] = ['claude', 'codex', 'local']
const strongest = (avail: AgentName[], not?: AgentName): AgentName => PREFER.find((a) => a !== not && avail.includes(a)) ?? PREFER.find((a) => avail.includes(a)) ?? avail[0]
// A cap of 100 is the highest the user can allow: reaching it must not stop the run for good, and an agent that is really out answers with a limit error.
const over = (pct: number, cap: number) => (cap >= 100 ? pct > cap : pct >= cap)
const label = (a: AgentName) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : 'The local model')
const id = (p: string) => `${p}${randomUUID().slice(0, 8)}`
const MAX_PROPOSALS = 6
const MAX_MESSAGES = 1500 // the oldest fall off; decisions and handoffs are kept on the run and the project memory

export class TeamOrchestrator {
  private live = new Map<string, Live>()
  private history = new HistoryRecorder()
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
    this.flush()
    for (const l of this.live.values()) {
      l.stop = 'pause'
      l.ctl.abort()
    }
    this.hub.stop()
    this.hubReady = null // a run resumed after a cancelled quit starts a new hub
  }

  // A run found half-done at startup is not resumed by itself (that would spend quota without being asked): it is marked interrupted.
  recoverAll() {
    for (const r of this.list()) {
      if (!this.runs.has(r.id)) this.runs.set(r.id, r)
      if (!['planning', 'running', 'verifying', 'paused'].includes(r.status)) continue
      for (const t of r.tasks) {
        if (t.status !== 'running') continue
        t.status = 'interrupted'
        if (t.phase && t.phase !== 'work') t.resumeFrom = t.phase // the quit may have beaten the save of the interrupted state, so the phase is read here
      }
      // a plan waiting for the user's yes stays open: Resume must not start work nobody approved
      for (const a of r.approvals) if (a.status === 'pending' && a.kind !== 'final' && a.kind !== 'plan') (a.status = 'expired'), (a.answeredAt = Date.now())
      if (r.activeSince) (r.activeMs = (r.activeMs ?? 0) + Math.max(0, r.updatedAt - r.activeSince)), (r.activeSince = undefined) // the time Forge was closed is not working time
      r.status = 'interrupted'
      r.pausedReason = 'Forge was closed while this was running.'
      this.d.store.save(r)
    }
  }

  async start(project: string, goal: string, cfg: Partial<TeamConfig> = {}): Promise<Run> {
    const config: TeamConfig = { ...DEFAULT_CONFIG, ...cfg, budget: { ...DEFAULT_CONFIG.budget, ...cfg.budget } }
    const ready = await this.d.available()
    const { agents: available, skipped } = await this.usable(config.maxLimitPercent)
    if (!ready.length) throw new Error('No agent is ready. Sign in to Claude Code or Codex, or start Ollama with a model, first.')
    if (!available.length) throw new Error(`${skipped.join(' ')} Wait for the allowance to reset, or raise the limit in the team settings.`)
    if (available.includes('codex') && !config.codexModel) {
      const m = await this.d.codexModels()
      config.codexModel = m.find((x) => /luna/.test(x)) ?? m.find((x) => /terra/.test(x)) ?? m[0] ?? ''
    }
    if (available.includes('local') && !config.localModel) config.localModel = (await this.d.localModels?.().catch(() => []))?.[0] ?? ''
    const runId = `r${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
    const baseCommit = await snapshotCommit(project)
    const integrationBranch = `forge/${runId}`
    const integrationWorktree = join(this.d.teamDir, 'wt', runId, 'integration')
    await createRunBranch(project, integrationBranch, baseCommit, integrationWorktree)
    const run: Run = { id: runId, project, goal: goal.trim(), prompts: [{ id: 'p1', text: goal.trim(), at: Date.now() }], status: 'planning', createdAt: Date.now(), updatedAt: Date.now(), activeMs: 0, activeSince: Date.now(), baseCommit, integrationBranch, integrationWorktree, plan: { summary: '', plannedBy: null }, tasks: [], messages: [], decisions: [], errors: [], approvals: [], usage: { claude: emptyUsage(), codex: emptyUsage(), local: emptyUsage() }, config }
    if (wantsSpeed(goal) || config.speed === 'fast') this.applySpeed(run, true)
    this.runs.set(runId, run)
    this.saveNow(run)
    writeHistory(project, `Run ${runId} started. Goal: ${run.goal.replace(/\s+/g, ' ').slice(0, 800)} (${config.attachments?.length ? `attachments: ${config.attachments.map((a) => a.name).join(', ')}; ` : ''}crew: ${available.join(', ')}; review ${config.review}; web ${config.webResearch === false ? 'off' : 'on'})`)
    for (const note of skipped) this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: note })
    const live = this.newLive(available)
    this.live.set(runId, live)
    this.out(run, { type: 'run', runId, status: 'planning' })
    this.startPlan(run, live)
    return run
  }

  private track(live: Live, p: Promise<unknown>) {
    live.bg.add(p)
    void p.finally(() => live.bg.delete(p)).catch(() => {})
  }
  private startPlan(run: Run, live: Live) {
    if (live.planning) return // a soft pause left the planner running: Resume waits for its plan
    live.planning = true
    this.track(live, this.plan(run).then(() => this.afterPlan(run)).catch((e) => this.fail(run, (e as Error).message)).finally(() => (live.planning = false)))
  }

  pause(runId: string, hard = false) {
    const run = this.runOf(runId)
    const live = this.live.get(runId)
    if (!run || !live) return
    // a run paused by a budget or a sign-in problem may still have turns going: a hard stop must be able to end them
    const winding = run.status === 'paused' && hard && !live.stop && (live.running.size > 0 || live.bg.size > 0)
    if (!['running', 'planning', 'verifying'].includes(run.status) && !winding) return
    if (run.status === 'verifying') hard = true // the last checks and fixes cannot wait for a turn to end: stop them, resume runs them again
    live.paused = true
    this.setStatus(run, 'paused', hard ? 'Stopped by you. Resume continues where the agents left off.' : 'Paused by you.')
    if (hard) {
      live.stop = 'pause'
      live.ctl.abort()
      // the agents that asked are being stopped: their questions would stay open and nothing could answer them
      for (const [aid, res] of live.pending) {
        const kind = run.approvals.find((x) => x.id === aid)?.kind
        if (kind === 'plan' || kind === 'budget') continue
        this.markApproval(run, aid, 'expired', 'Stopped by you.')
        live.pending.delete(aid)
        res({ allow: false, note: 'Stopped by you.' })
      }
    }
  }

  async resume(runId: string) {
    const run = this.runOf(runId)
    if (!run || !['paused', 'interrupted'].includes(run.status)) return
    if (run.approvals.some((a) => a.kind === 'plan' && a.status === 'pending')) return void this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: 'Approve or edit the plan first; nothing starts before that.' })
    const { agents: available, skipped } = await this.usable(run.config.maxLimitPercent) // the user may have just signed an agent in
    for (const note of skipped) this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: note })
    if (!available.length) return void this.setStatus(run, run.status, 'Neither Claude Code nor Codex is signed in yet.')
    let live = this.live.get(runId)
    if (!live) {
      live = this.newLive(available)
      this.live.set(runId, live)
    }
    live.available = available
    live.limited.clear() // the user is back: whatever was out of allowance gets another try
    // a stop that is still unwinding: let the stopped turns mark their tasks interrupted before a fresh controller replaces the aborted one
    if (live.stop && (live.running.size || live.bg.size)) await Promise.allSettled([...live.running.values(), ...live.bg])
    if (live.stop) (live.ctl = new AbortController()), (live.stop = null)
    live.paused = false
    for (const t of run.tasks) {
      if (t.status === 'interrupted' || (t.status === 'running' && !live.running.has(t.id))) (t.status = 'queued'), (t.phase = null) // the second case: a fix stopped during the last checks
      else if (t.status === 'blocked' && !/depends on failed/.test(t.error ?? '')) (t.status = 'queued'), (t.error = undefined) // blocked by a missing sign-in, which may be fixed now
    }
    this.setStatus(run, run.tasks.length ? 'running' : 'planning')
    if (!run.tasks.length) this.startPlan(run, live)
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
      await Promise.allSettled([...live.running.values(), ...live.bg]) // the last steps too: they must not set a status over 'cancelled' or work in a folder that is about to go
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
    this.dirty.delete(runId) // cleanup() queued a save: left alone, the timer would write the run back
    this.runs.delete(runId)
    this.live.delete(runId)
    this.d.store.delete(runId)
    await rm(join(this.d.teamDir, 'wt', runId), { recursive: true, force: true }).catch(() => {})
    removeAttachmentDirs(join(this.d.teamDir, 'attachments'), run.config.attachments)
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
      if (r) await this.cleanup(r, false, false).catch(() => {}) // not saved: a restart must not reorder the finished runs
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
    // the final approval and a plan that outlived a restart have no waiting agent: the answer is acted on directly
    if (a.kind === 'final') {
      if (allow) void this.approveFinal(runId).catch(() => {})
      else void this.rejectFinal(runId).catch(() => {})
      return true
    }
    if (!resolve && a.kind === 'plan' && ['paused', 'interrupted'].includes(run.status)) {
      this.markApproval(run, approvalId, allow ? 'allowed' : 'denied', note)
      void (allow ? this.resume(runId) : this.cancel(runId)).catch(() => {})
      return true
    }
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

  // The run is one never-ending chat: another message always goes to the same run.
  // Still going -> steer. Waiting for the final OK -> the old result stays and a new task builds on it. Finished/failed/cancelled -> the run is
  // reopened on a fresh team branch (cut from the project as it is now when the result was applied, else from the old branch) with a new task.
  async followUp(runId: string, text: string, to: AgentName | 'all' = 'all', files?: import('./attach').TeamAttachment[]) {
    const run = this.runOf(runId)
    let body = text.trim().slice(0, 2000) || (files?.length ? 'See the attached files.' : '')
    if (!run || !body) return
    // "run website" / "stop the website" are commands for Forge, not instructions for the agents: they start or stop the dev server and report the port.
    if (this.d.runApp && isRunAppWords(body)) {
      this.post(run, { from: 'user', to: 'user', kind: 'note', body })
      void this.d.runApp(run).then((r) => this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: r.message })).catch((e) => this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: `Could not run the website: ${(e as Error).message}` }))
      return
    }
    if (this.d.stopApp && isStopAppWords(body)) {
      this.post(run, { from: 'user', to: 'user', kind: 'note', body })
      this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: this.d.stopApp(run).message })
      return
    }
    // "pause" / "stop" typed in the box stops the agents now; "resume" / "continue" starts them again. In any other state they do nothing.
    const word = body.toLowerCase().replace(/[\s.!]+$/, '')
    if (/^(pause|stop|wait|hold on|stop it|pause it)$/.test(word)) return ['planning', 'running', 'verifying', 'paused'].includes(run.status) ? this.pause(runId, true) : void this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: 'Nothing is running right now.' })
    if (/^(resume|continue|go on|keep going|go|start again|unpause)$/.test(word)) return ['paused', 'interrupted'].includes(run.status) ? this.resume(runId) : void this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: 'Nothing is paused right now.' })
    // Pictures, videos and files sent with the message: every later turn of every agent gets them (like the ones given at the start), and this
    // message names where they are so an agent that is working now can open them at once.
    if (files?.length) {
      const have = new Set((run.config.attachments ?? []).map((f) => f.path))
      run.config.attachments = [...(run.config.attachments ?? []), ...files.filter((f) => !have.has(f.path))].slice(-60)
      body = `${body}\n\nAttached files (open and look at them):\n${files.map((f) => `- ${f.name}: ${f.path}${f.frames?.length ? ` (video, frames: ${f.frames.join(', ')})` : ''}`).join('\n')}`
      this.save(run)
    }
    // Every message is a main request of its own: the run keeps them all, in order, and the team reads the newest together with the older ones.
    ;(run.prompts ??= [{ id: 'p1', text: run.goal, at: run.createdAt }]).push({ id: `p${run.prompts.length + 1}`, text: body, at: Date.now() })
    if (wantsSpeed(body)) this.applySpeed(run, true)
    if (['planning', 'running', 'paused', 'verifying', 'interrupted'].includes(run.status)) {
      // after the last task nobody is left to read a message: the final steps turn it into a task
      const finishing = run.status === 'verifying' || (['paused', 'interrupted'].includes(run.status) && run.tasks.length > 0 && run.tasks.every((t) => ['done', 'cancelled'].includes(t.status)))
      if (finishing) this.liveOf(run).late.push({ body, to })
      this.steer(runId, body, to) // agents that are working read it at the start of their next turn
      if (!finishing && to === 'all' && !asksForLocal(body)) this.queueReplan(run, this.liveOf(run), body, run.prompts?.at(-1)?.id) // and the planner adds what the new request needs, without stopping anyone
      return
    }
    const { agents: available, skipped } = await this.usable(run.config.maxLimitPercent) // also after a restart, when nothing yet says who is signed in
    if (!available.length) throw new Error(`${skipped.join(' ') || 'No agent is signed in.'} Sign in or wait, then send this again.`)
    if (run.status === 'awaiting_approval') {
      const a = run.approvals.find((x) => x.kind === 'final' && x.status === 'pending')
      if (a) this.markApproval(run, a.id, 'denied', 'You asked for more work first.')
      this.dropFailedLastSteps(run)
      this.liveOf(run).available = available
    } else {
      this.live.set(runId, this.newLive(available))
      for (const t of run.tasks) if (['failed', 'blocked'].includes(t.status)) (t.status = 'cancelled'), (t.error = 'Replaced by your next message.')
      const wt = run.integrationWorktree
      if (run.applied) {
        // the result is already in the project: the new round starts from the project as it is now
        run.baseCommit = await snapshotCommit(run.project)
        run.integrationBranch = `forge/${run.id}-${Date.now().toString(36)}`
        await createRunBranch(run.project, run.integrationBranch, run.baseCommit, wt)
      } else await addTaskWorktree(run.project, wt, run.integrationBranch, run.baseCommit) // unapplied work is still on its branch
      run.applied = false
      run.appliedCheckpoint = undefined
      run.undone = undefined
      run.final = undefined
      run.pausedReason = undefined
      writeHistory(run.project, `Run ${run.id} continued with a new message: ${body.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
    run.landedFiles = undefined // the next result is a new diff: files landed from the old one are applied again (a three-way apply copes with identical changes)
    const live = this.liveOf(run)
    this.post(run, { from: 'user', to, kind: 'steer', body })
    if (to === 'all' && !asksForLocal(body)) this.queueReplan(run, live, body, run.prompts?.at(-1)?.id)
    else this.messageTask(run, live, body, to, run.prompts?.at(-1)?.id)
    live.paused = false
    this.setStatus(run, 'running')
    this.pump(run)
  }

  // Fast mode: many sessions side by side, no cross-review, no extra test task, light effort. The user's own settings come back when they stop asking for speed.
  applySpeed(run: Run, fast: boolean) {
    const c = run.config
    if (fast && c.speed !== 'fast') {
      c.speedSaved = { review: c.review, finalReview: c.finalReview, testTask: c.testTask, securityReview: c.securityReview, maxParallelPerAgent: c.maxParallelPerAgent, claudeEffort: c.claudeEffort, codexEffort: c.codexEffort, budget: { ...c.budget } }
      Object.assign(c, { speed: 'fast', review: 'off', finalReview: false, testTask: false, securityReview: 'off', maxParallelPerAgent: 6, claudeEffort: 'low', codexEffort: 'low', budget: { ...c.budget, maxTasks: Math.max(c.budget.maxTasks ?? 12, 20) } })
    } else if (!fast && c.speed === 'fast') {
      Object.assign(c, c.speedSaved ?? {}, { speed: 'normal' })
      c.speedSaved = undefined
    }
    this.save(run)
  }
  setSpeed(runId: string, fast: boolean) {
    const run = this.runOf(runId)
    if (!run) return null
    this.applySpeed(run, fast)
    this.pump(run)
    return run.config.speed ?? 'normal'
  }

  // A newer main request: the planner reads all of them with what is done so far and adds only what is missing. Nothing that is running stops.
  private queueReplan(run: Run, live: Live, body: string, promptId?: string) {
    live.replans++
    const step = live.replanChain.then(() => this.replan(run, live, body, promptId)).catch(() => {}).finally(() => { live.replans--; this.pump(run) })
    live.replanChain = step
    this.track(live, step)
  }

  private async replan(run: Run, live: Live, body: string, promptId?: string) {
    while (live.planning && !live.ctl.signal.aborted) await new Promise((r) => setTimeout(r, 400)) // the first plan is still being made
    if (live.ctl.signal.aborted) return
    const notes = this.d.projectNotes?.(run.project) ?? { brief: '', rules: '' }
    const order: AgentName[] = run.config.planner === 'auto' ? PREFER : [run.config.planner, ...PREFER.filter((a) => a !== run.config.planner)]
    const planners = order.filter((a) => live.available.includes(a) && !live.limited.has(a))
    const fast = run.config.speed === 'fast'
    const existing = run.tasks.map((t) => t.id)
    const digest = run.tasks.slice(-40).map((t) => ({ id: t.id, title: t.title, status: t.status, agent: t.agent, summary: t.summary }))
    const asked = (run.prompts ?? [{ id: 'p1', text: run.goal, at: run.createdAt }]).map((q) => q.text + (notes.rules ? '' : ''))
    for (const agent of planners) {
      let prompt = replanPrompt(asked, digest, notes.brief + (notes.rules ? `${notes.brief ? '\n' : ''}User's rules for this project:\n${notes.rules}` : ''), live.available, fast)
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await this.agentRun(run, this.virtualTask(run, 'plan', 'Planning', agent), agent, 'plan', prompt, false, run.integrationWorktree)
        if (live.ctl.signal.aborted) return
        if (!res.ok) { if (['limit', 'auth', 'missing', 'model'].includes(res.error?.kind ?? '')) break; continue }
        try {
          const r = parseReplan(res.text, live.available, existing, fast ? 20 : run.config.budget.maxTasks ?? 12)
          this.applyReplan(run, live, r, promptId)
          return
        } catch (e) {
          prompt = `${prompt}\n\nYour previous reply was rejected: ${(e as Error).message}. Reply again with ONLY the JSON object.`
        }
      }
    }
    this.messageTask(run, live, body, 'all', promptId) // no planner could answer: the newest message still becomes one task
  }

  private applyReplan(run: Run, live: Live, r: ReturnType<typeof parseReplan>, promptId?: string) {
    for (const id of r.cancel) {
      const t = run.tasks.find((x) => x.id === id)
      if (t && t.status === 'queued') (t.status = 'cancelled'), (t.error = 'Replaced by your newer message.'), this.touch(run, t)
    }
    const made = new Map<string, string>()
    const todo = [...r.tasks]
    while (todo.length) {
      const i = Math.max(0, todo.findIndex((q) => q.deps.every((d) => !/^n\d+$/.test(d) || made.has(d))))
      const q = todo.splice(i, 1)[0]
      const t = this.addTask(run, { title: q.title, goal: q.goal, agent: q.agent ?? strongest(live.available), kind: q.kind, deps: q.deps.map((d) => made.get(d) ?? d), acceptance: q.acceptance, proposedBy: 'user', promptId })
      made.set(q.id, t.id)
    }
    this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: r.tasks.length ? `${r.summary || 'Planned your new request'}: ${r.tasks.length} new task${r.tasks.length === 1 ? '' : 's'}${r.cancel.length ? `, ${r.cancel.length} replaced` : ''}.` : r.cancel.length ? `Replaced ${r.cancel.length} planned task${r.cancel.length === 1 ? '' : 's'} for your new request.` : 'Your new request is already covered by the work planned or done.' })
    this.out(run, { type: 'plan', runId: run.id, summary: run.plan.summary, tasks: run.tasks })
  }

  private messageTask(run: Run, live: Live, body: string, to: AgentName | 'all', promptId?: string) {
    // "let local fix this", "use the local model": the words count as much as the recipient box when it says Everyone.
    const named: AgentName | null = to === 'all' && asksForLocal(body) && live.available.includes('local') ? 'local' : null
    const agent = named ?? (to !== 'all' && live.available.includes(to) ? to : strongest(this.pool(live)))
    return this.addTask(run, { title: body.replace(/\s+/g, ' ').slice(0, 70), goal: body, agent, kind: 'build', proposedBy: 'user', promptId })
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
      this.save(run)
      await this.resume(run.id)
    } else this.touch(run)
    this.pump(run)
  }

  // With `reviewPlan` the run waits here: the user can edit the plan (updatePlan) and then approves it or cancels the run.
  private afterPlan(run: Run) {
    const waiting = run.status === 'running' || (run.status === 'paused' && this.liveOf(run).paused) // a soft pause during planning still gets the plan check
    if (!run.config.reviewPlan || !run.tasks.length || !waiting || run.tasks.some((t) => t.status !== 'queued')) return this.pump(run)
    const live = this.liveOf(run)
    live.paused = true
    this.setStatus(run, 'paused', 'Review the plan, change what you want, then approve it to start.')
    void this.ask(run, { kind: 'plan', title: 'Start with this plan?', detail: `${run.tasks.length} task${run.tasks.length === 1 ? '' : 's'}. You can edit, reassign or skip tasks first.` }).then((r) => (r.allow ? this.resume(run.id) : this.cancel(run.id)))
  }

  // Edits to a plan that has not started: reword a task, change its agent or acceptance checks, change dependencies, or skip it.
  updatePlan(runId: string, edits: { id: string; title?: string; goal?: string; agent?: AgentName; acceptance?: string[]; deps?: string[]; skip?: boolean }[]): { ok: boolean; message: string } {
    const run = this.runOf(runId)
    if (!run || run.status !== 'paused' || run.tasks.some((t) => t.status !== 'queued' && t.status !== 'cancelled')) return { ok: false, message: 'The plan can only be changed before work starts.' }
    const next = run.tasks.map((t) => ({ ...t }))
    for (const e of edits) {
      const t = next.find((x) => x.id === e.id)
      if (!t) return { ok: false, message: `Unknown task ${e.id}.` }
      if (typeof e.title === 'string' && e.title.trim()) t.title = e.title.trim().slice(0, 120)
      if (typeof e.goal === 'string' && e.goal.trim()) t.goal = e.goal.trim().slice(0, 2000)
      if (isAgent(e.agent)) {
        if (!this.liveOf(run).available.includes(e.agent)) return { ok: false, message: `${e.agent} is not available for this run.` }
        t.agent = e.agent
      }
      if (Array.isArray(e.acceptance)) t.acceptance = e.acceptance.map((a) => String(a).slice(0, 300)).filter(Boolean).slice(0, 8)
      if (Array.isArray(e.deps)) t.deps = [...new Set(e.deps.filter((d) => d !== t.id && next.some((x) => x.id === d)))]
      if (e.skip === true) (t.status = 'cancelled'), (t.error = 'Skipped by you.')
      else if (e.skip === false && t.status === 'cancelled') (t.status = 'queued'), (t.error = undefined)
    }
    // no circle: every task must be reachable once its dependencies are done
    const done = new Set<string>()
    for (let progress = true; progress && done.size < next.length; ) {
      progress = false
      for (const t of next) if (!done.has(t.id) && t.deps.every((d) => done.has(d))) (done.add(t.id), (progress = true))
    }
    if (done.size < next.length) return { ok: false, message: 'Those changes make tasks wait for each other in a circle.' }
    if (!next.some((t) => t.status === 'queued')) return { ok: false, message: 'At least one task has to stay.' }
    run.tasks = next
    this.save(run)
    this.out(run, { type: 'plan', runId: run.id, summary: run.plan.summary, tasks: run.tasks })
    return { ok: true, message: 'Plan updated.' }
  }

  // The change for the diff view: one task's, or (no task) everything the team has merged so far.
  async diffFor(runId: string, taskId?: string): Promise<string> {
    const run = this.runOf(runId)
    if (!run) return ''
    const t = taskId ? run.tasks.find((x) => x.id === taskId) : undefined
    if (t) return t.worktree && t.base ? await diffText(t.worktree, t.base, 'HEAD', 60_000).catch(() => t.diff ?? '') : (t.diff ?? '')
    return diffText(run.integrationWorktree, run.baseCommit, 'HEAD', 120_000).catch(() => '')
  }

  // Raises every limit that is set by half. Any "budget reached" question still open is answered yes, so the card goes away and the run continues.
  extendBudget(runId: string, factor = 1.5) {
    const run = this.runOf(runId)
    if (!run) return
    this.raiseBudget(run, factor)
    const live = this.live.get(runId)
    for (const a of run.approvals) {
      if (a.kind !== 'budget' || a.status !== 'pending') continue
      const resolve = live?.pending.get(a.id)
      live?.pending.delete(a.id)
      this.markApproval(run, a.id, 'allowed')
      resolve?.({ allow: true })
    }
    if (run.status === 'paused') void this.resume(runId)
  }

  // Change which models the agents use for the rest of the run. Work already running keeps its model; the next task each agent starts uses the new one.
  setModels(runId: string, m: { claudeModel?: string; codexModel?: string; localModel?: string; claudeEffort?: string; codexEffort?: string; bypassPermissions?: boolean }) {
    const run = this.runOf(runId)
    if (!run) return null
    const name = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 120) : undefined)
    const c = run.config
    if (m.claudeModel !== undefined) c.claudeModel = name(m.claudeModel) || undefined
    if (m.codexModel !== undefined && name(m.codexModel)) c.codexModel = name(m.codexModel)!
    if (m.localModel !== undefined) c.localModel = name(m.localModel) || undefined
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(m.claudeEffort ?? '')) c.claudeEffort = m.claudeEffort as TeamConfig['claudeEffort']
    if (['low', 'medium', 'high', 'xhigh'].includes(m.codexEffort ?? '')) c.codexEffort = m.codexEffort as TeamConfig['codexEffort']
    if (typeof m.bypassPermissions === 'boolean') c.bypassPermissions = m.bypassPermissions
    this.save(run)
    return { claudeModel: c.claudeModel, codexModel: c.codexModel, localModel: c.localModel, claudeEffort: c.claudeEffort, codexEffort: c.codexEffort, bypassPermissions: c.bypassPermissions !== false }
  }

  private raiseBudget(run: Run, factor = 1.5) {
    const b = run.config.budget
    for (const k of ['maxTokens', 'maxMinutes', 'maxAgentRuns', 'maxCostUsd'] as const) if (b[k]) b[k] = Math.ceil(b[k]! * factor * 100) / 100
    const used = Math.max(0, ...Object.values(run.limits ?? {}).map((l) => Math.max(l?.primaryPct ?? 0, l?.secondaryPct ?? 0)))
    if (run.config.maxLimitPercent && used >= run.config.maxLimitPercent) run.config.maxLimitPercent = Math.min(100, Math.ceil(used) + 5)
    this.save(run)
  }

  // `withoutUndo`: the user agreed to apply even though no recovery point could be taken.
  // `only`: land just these files (paths from run.final.files); the final approval stays open until every file has landed.
  async approveFinal(runId: string, withoutUndo = false, only?: string[]): Promise<{ ok: boolean; message: string; checkpoint?: string }> {
    const run = this.runOf(runId)
    if (!run || run.status !== 'awaiting_approval') return { ok: false, message: 'This run is not waiting for approval.' }
    const all = (run.final?.files ?? []).map((f) => f.path)
    const landed = new Set(run.landedFiles ?? [])
    let pick: string[] | undefined // undefined = the whole diff, as before any partial landing existed
    if (only) {
      const bad = only.find((p) => typeof p !== 'string' || !all.includes(p))
      if (!only.length || bad !== undefined) return { ok: false, message: `${bad === undefined ? 'No files were chosen.' : `${String(bad).slice(0, 120)} is not one of this run's changed files.`} Nothing was applied.` }
      pick = [...new Set(only)].filter((p) => !landed.has(p))
      if (!pick.length) return { ok: false, message: 'Those files have already landed.' }
    } else if (landed.size) pick = all.filter((p) => !landed.has(p)) // the files already landed are in the project: diffing them again would conflict
    const partial = !!pick && pick.length < all.filter((p) => !landed.has(p)).length
    let checkpoint: Awaited<ReturnType<typeof createCheckpoint>> | undefined
    let message = 'Everything had already landed.'
    if (!pick || pick.length) {
      try {
        checkpoint = await createCheckpoint(run.project) // so the normal Undo can take the whole result back out
      } catch (e) {
        if (!withoutUndo) {
          const message = `Nothing was applied, because a way back could not be saved first: ${(e as Error).message.slice(0, 200)}. Fix that, or apply without Undo.`
          this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: message })
          return { ok: false, message }
        }
      }
      // a three-way apply can stop halfway, with conflict markers in the files and an unmerged index
      const index = await git(run.project, ['write-tree']).then((t) => t.trim(), () => null)
      const r = await applyResult(run.project, run.baseCommit, run.integrationBranch, checkpoint?.id, pick)
      if (!r.ok) {
        if (checkpoint) await undoTo(run.project, checkpoint).catch(() => [])
        if (index) await git(run.project, ['read-tree', index]).catch(() => '')
        this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: `Not applied, your folder is as it was: ${r.message}` })
        return { ok: false, message: r.message } // the approval stays open, so the user can fix the conflict and apply again
      }
      message = r.message
      const files = pick ?? all
      ;(run.landings ??= []).push({ at: Date.now(), files, checkpoint: checkpoint?.id })
      run.landedFiles = [...landed, ...files]
    }
    if (partial) {
      const n = pick!.length
      writeHistory(run.project, `Run ${run.id}: ${n} of its files were landed (${all.length - run.landedFiles!.length} still to land).`)
      this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: `Landed ${n} file${n === 1 ? '' : 's'}. ${all.length - run.landedFiles!.length} still waiting for your approval.` })
      this.save(run)
      return { ok: true, message: `Landed ${n} file${n === 1 ? '' : 's'}.`, checkpoint: checkpoint?.id }
    }
    const a = run.approvals.find((x) => x.kind === 'final' && x.status === 'pending')
    if (a) this.markApproval(run, a.id, 'allowed', message)
    run.applied = true
    run.appliedCheckpoint = checkpoint?.id
    run.undone = undefined
    writeHistory(run.project, `Run ${run.id} was applied to the project: ${message.replace(/\s+/g, ' ').slice(0, 300)}`)
    this.setStatus(run, 'done')
    await this.cleanup(run, true)
    return { ok: true, message, checkpoint: checkpoint?.id }
  }

  // Takes an applied result back out of the project: every file the apply changed goes back to how it was just before.
  // ponytail: edits made by hand after the apply are undone too (same rule as the chat Undo).
  async undoApply(runId: string): Promise<{ ok: boolean; paths: string[]; message: string }> {
    const run = this.runOf(runId)
    if (!run?.applied || !run.appliedCheckpoint) return { ok: false, paths: [], message: 'Nothing to undo for this run.' }
    if (run.undone) return { ok: false, paths: [], message: 'Already undone.' }
    return this.undoLanding(runId, run.appliedCheckpoint)
  }

  // Takes one landing (a partial one, or the last) back out: only the files it wrote go back, so other landings stay.
  async undoLanding(runId: string, checkpoint: string): Promise<{ ok: boolean; paths: string[]; message: string }> {
    const run = this.runOf(runId)
    const l = run?.landings?.find((x) => x.checkpoint === checkpoint)
    const isFull = !!run && run.appliedCheckpoint === checkpoint
    if (!run || (!l && !isFull)) return { ok: false, paths: [], message: 'Nothing to undo for this landing.' }
    if (l?.undone || (isFull && run.undone)) return { ok: false, paths: [], message: 'Already undone.' }
    try {
      const tree = (await git(run.project, ['rev-parse', `refs/forge/${checkpoint}^{tree}`])).trim()
      const paths = await undoTo(run.project, { id: checkpoint, tree })
      if (l) (l.undone = true), (run.landedFiles = (run.landedFiles ?? []).filter((p) => !l.files.includes(p)))
      if (isFull) run.undone = true
      writeHistory(run.project, `Run ${run.id} was undone: ${paths.length} file${paths.length === 1 ? '' : 's'} put back.`)
      this.save(run)
      this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: `Undone: ${paths.length} file${paths.length === 1 ? '' : 's'} put back.` })
      return { ok: true, paths, message: 'Undone.' }
    } catch (e) {
      return { ok: false, paths: [], message: `Could not undo: ${(e as Error).message.slice(0, 200)}` }
    }
  }

  // The result's files with whether each has landed, grouped by the task that wrote them, for the "land part of a run" card.
  landings(runId: string): TeamLandings | null {
    const run = this.runOf(runId)
    if (!run?.final) return null
    const landed = new Set(run.landedFiles ?? [])
    const files = run.final.files.map((f) => ({ ...f, state: landed.has(f.path) ? ('landed' as const) : ('pending' as const) }))
    const known = new Set(files.map((f) => f.path))
    const seen = new Set<string>()
    const tasks = run.tasks.filter((t) => t.status === 'done' && t.kind !== 'research').flatMap((t) => {
      const fs = (t.changed ?? []).map((c) => c.path).filter((p) => known.has(p))
      fs.forEach((p) => seen.add(p))
      return fs.length ? [{ id: t.id, title: t.title, files: fs }] : []
    })
    const rest = files.map((f) => f.path).filter((p) => !seen.has(p))
    if (rest.length) tasks.push({ id: '', title: 'Other changes', files: rest })
    return { files, tasks, landings: (run.landings ?? []).map((l) => ({ ...l })), pending: run.status === 'awaiting_approval' }
  }

  async rejectFinal(runId: string) {
    const run = this.runOf(runId)
    if (!run || run.status !== 'awaiting_approval') return
    const a = run.approvals.find((x) => x.kind === 'final' && x.status === 'pending')
    if (a) this.markApproval(run, a.id, 'denied', 'Not applied.')
    this.setStatus(run, 'done', 'Result was not applied; it stays on branch ' + run.integrationBranch)
    await this.cleanup(run, false)
  }

  // The agents that may be used right now: signed in, and not about to run out of their plan's allowance (the user's own work with that
  // agent would be starved). Returns the reasons for any that were left out.
  private async usable(cap: number): Promise<{ agents: AgentName[]; skipped: string[] }> {
    const all = await this.d.available()
    if (!cap || !this.d.limits) return { agents: all, skipped: [] }
    const lim = (await this.d.limits().catch(() => ({}))) as NonNullable<Awaited<ReturnType<NonNullable<Deps['limits']>>>>
    const skipped: string[] = []
    const agents = all.filter((a) => {
      const l = lim[a]
      const hit = l && (over(l.primaryPct, cap) ? ['this window', l.primaryPct, l.primaryResetsAt] : l.secondaryPct !== undefined && over(l.secondaryPct, cap) ? ['this week', l.secondaryPct, l.secondaryResetsAt] : null)
      if (!hit) return true
      const when = hit[2] ? ` It resets around ${new Date(Number(hit[2]) * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : ''
      skipped.push(`${a === 'codex' ? 'Codex' : 'Claude'} was left out: ${a === 'codex' ? 'your ChatGPT plan' : 'your Claude plan'} allowance for ${hit[0]} is ${Math.round(Number(hit[1]))}% used.${when}`)
      return false
    })
    return { agents, skipped }
  }

  // Per-task time, tokens and cost plus what is left of the plan, for the screen.
  stats(runId: string) {
    const run = this.runOf(runId)
    return run ? { tasks: taskStats(run), forecast: forecast(run) } : null
  }

  // ------------------------------------------------------------------ plumbing

  // Agents that are signed in and whose plan has not run out in this run (or has come back since). Empty when every one is out.
  private ready(live: Live): AgentName[] {
    for (const [a, back] of live.limited) if (back && back <= Date.now()) live.limited.delete(a)
    return live.available.filter((a) => !live.limited.has(a))
  }
  // Who may be given a job now: the ready agents, or all of them when every plan is out (the job then runs, hits the limit and the run pauses as before).
  private pool(live: Live): AgentName[] {
    const r = this.ready(live)
    return r.length ? r : live.available
  }
  // An agent's plan ran out. It is left out of new work, reviews and fixes from now on, and this says who takes over `what` (a task id, "the final review"...).
  // Null when switching is off or nobody else can: the caller then stops and waits for the user, as it always did. The local model never takes over:
  // its work must be reviewed by Claude or Codex, and it never reviews theirs.
  private switchAgent(run: Run, live: Live, from: AgentName, message: string, what: string, not?: AgentName): AgentName | null {
    if (run.config.autoSwitch === false) return null
    const ts = Number(/\|(\d{9,11})\b/.exec(message)?.[1]) // Claude's limit message ends with "|<unix seconds the plan comes back>"
    const lim = run.limits?.[from]
    const back = ts ? ts * 1000 : lim && lim.primaryPct >= 100 && lim.primaryResetsAt ? lim.primaryResetsAt * 1000 : 0
    if (message || !live.limited.has(from)) live.limited.set(from, back)
    const to = strongest(this.ready(live).filter((a) => a !== from && a !== 'local'), not)
    if (!to || to === from) return null
    this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: `${label(from)} hit its limit: ${label(to)} took over ${what}` })
    return to
  }

  private newLive(available: AgentName[]): Live {
    return { ctl: new AbortController(), stop: null, paused: false, running: new Map(), pending: new Map(), budgetAsk: false, git: new Mutex(), merge: new Mutex(), available, finishing: false, handles: new Map(), planning: false, replans: 0, replanChain: Promise.resolve(), late: [], limited: new Map(), bg: new Set() }
  }
  private liveOf(run: Run): Live {
    let l = this.live.get(run.id)
    if (!l) this.live.set(run.id, (l = this.newLive(AGENTS)))
    return l
  }
  // The run file is rewritten as things change. Doing that on every message and tool call makes long runs quadratic, so ordinary
  // changes are written at most every 250 ms; status changes and shutdown write at once.
  private dirty = new Map<string, Run>()
  private saveTimer: NodeJS.Timeout | null = null
  private save(run: Run) {
    this.dirty.set(run.id, run)
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 250)
      this.saveTimer.unref?.()
    }
  }
  private saveNow(run: Run) {
    this.dirty.delete(run.id)
    this.d.store.save(run)
  }
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    for (const r of this.dirty.values()) if (this.runs.get(r.id) === r) this.d.store.save(r) // a deleted run stays deleted
    this.dirty.clear()
  }

  // Live typing (deltas, growing files) arrives in bursts of tiny events. They are merged for 100 ms before reaching the screen and
  // are not written to the log: the finished text, tool results and task diff are.
  private streamBuf = new Map<string, RunEvent>()
  private streamTimer: NodeJS.Timeout | null = null
  private flushStream() {
    if (this.streamTimer) clearTimeout(this.streamTimer)
    this.streamTimer = null
    const all = [...this.streamBuf.values()]
    this.streamBuf.clear()
    for (const e of all) this.d.emit(e)
  }
  private out(run: Run, ev: RunEvent) {
    ev = redactEvent(ev)
    writeHistory(run.project, this.history.lines(run, ev))
    const live = ev.type === 'agent' && (ev.ev.type === 'delta' || ev.ev.type === 'code')
    if (live || ev.type === 'live') {
      const a = ev.type === 'agent' ? ev.ev : null
      const key = a?.type === 'code' ? `${ev.type}:${(ev as any).taskId}:c:${a.id}` : a?.type === 'delta' ? `${ev.type}:${(ev as any).taskId}:d:${a.agent}:${a.channel}:${a.id ?? ''}` : `live:${(ev as any).taskId}`
      const prev = this.streamBuf.get(key)
      if (prev && a?.type === 'delta' && prev.type === 'agent' && prev.ev.type === 'delta') this.streamBuf.set(key, { ...ev, ev: { ...a, text: prev.ev.text + a.text } } as RunEvent)
      else this.streamBuf.set(key, ev)
      this.streamTimer ??= setTimeout(() => this.flushStream(), 100)
      return
    }
    this.flushStream() // keep the order the agent worked in
    this.d.store.appendEvent(run.id, ev)
    this.d.emit(ev)
  }

  // Polls an agent's working folder while it runs and reports which files differ from where the task started, whatever wrote them
  // (a patch, a shell command, an editor tool). The patch itself is fetched on demand through liveDiff.
  private watch(run: Run, task: Task, cwd: string, base: string): () => void {
    let sig = ''
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const tree = await snapshotTreeWithoutSecrets(cwd)
        const files = await changedSince(cwd, base, tree)
        const s = JSON.stringify(files.map((f) => [f.path, f.status, f.added, f.removed]))
        if (s !== sig) {
          sig = s
          this.out(run, { type: 'live', runId: run.id, taskId: task.id, files })
        }
      } catch {} finally {
        busy = false
      }
    }
    const t = setInterval(tick, 1500)
    void tick()
    return () => {
      clearInterval(t)
      void tick()
    }
  }

  async liveDiff(runId: string, taskId: string, path?: string): Promise<string> {
    const run = this.runOf(runId)
    const task = run?.tasks.find((t) => t.id === taskId)
    if (!run) return ''
    const cwd = task?.worktree ?? run.integrationWorktree
    try {
      return await diffText(cwd, task?.base ?? run.baseCommit, await snapshotTreeWithoutSecrets(cwd), 80_000, path)
    } catch {
      return ''
    }
  }

  // Everything the team shares right now: what was decided, said, handed over and learned, plus what earlier runs on this project taught it.
  memorySnapshot(runId: string) {
    const run = this.runOf(runId)
    if (!run) return null
    const mem = this.memory(run).load()
    return {
      decisions: run.decisions,
      messages: run.messages,
      handoffs: run.tasks.filter((t) => t.handoff).map((t) => ({ taskId: t.id, title: t.title, agent: t.agent, handoff: t.handoff })),
      errors: run.errors,
      project: { decisions: mem.decisions.slice(-50), errors: mem.errors.slice(-50), stats: mem.stats },
    }
  }
  private touch(run: Run, task?: Task) {
    this.save(run)
    if (task) this.out(run, { type: 'task', runId: run.id, task })
  }
  private setStatus(run: Run, status: RunStatus, reason?: string) {
    // working time for the time budget: the clock runs only while the team is at work, so a run reopened days later starts from its own total
    const now = Date.now()
    if (run.activeSince) run.activeMs = (run.activeMs ?? 0) + now - run.activeSince
    run.activeSince = ['planning', 'running', 'verifying'].includes(status) ? now : undefined
    run.status = status
    run.pausedReason = reason
    this.saveNow(run)
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
  // A wait that a stop ends at once.
  private nap = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
      void this.sleep(ms).then(resolve)
    })

  private post(run: Run, m: { from: Message['from']; to: Message['to']; kind: MessageKind; body: string; taskId?: string }) {
    const msg: Message = { id: id('m'), at: Date.now(), readBy: [], ...m, body: redact(m.body) }
    run.messages.push(msg)
    if (run.messages.length > MAX_MESSAGES) run.messages.splice(0, run.messages.length - MAX_MESSAGES)
    this.save(run)
    this.out(run, { type: 'message', runId: run.id, message: msg })
    return msg
  }

  // Messages for this agent it has not seen, marked as seen. Steering from the user is returned separately: for a prompt (`standing`) it is
  // every instruction given so far, since each task is a fresh agent turn; through the mailbox only the ones not yet read.
  private drainInbox(run: Run, agent: AgentName, standing = false): { inbox: Message[]; steer: string[] } {
    const mine = run.messages.filter((m) => !m.readBy.includes(agent) && m.from !== agent && (m.to === agent || m.to === 'all'))
    for (const m of mine) m.readBy.push(agent)
    return { inbox: mine.filter((m) => m.kind !== 'steer'), steer: standing ? this.instructions(run, agent) : mine.filter((m) => m.kind === 'steer').map((m) => m.body) }
  }
  private instructions(run: Run, agent: AgentName): string[] {
    return run.messages.filter((m) => m.kind === 'steer' && (m.to === agent || m.to === 'all')).slice(-20).map((m) => m.body)
  }

  private markApproval(run: Run, approvalId: string, status: Approval['status'], answer?: string) {
    const a = run.approvals.find((x) => x.id === approvalId)
    if (!a) return
    a.status = status
    a.answer = answer
    a.answeredAt = Date.now()
    this.save(run)
    this.out(run, { type: 'approval', runId: run.id, approval: a })
  }

  private async ask(run: Run, p: { kind: ApprovalKind; title: string; detail: string; options?: Approval['options']; multi?: boolean; taskId?: string; agent?: AgentName }): Promise<{ allow: boolean; note?: string }> {
    const live = this.liveOf(run)
    const a: Approval = { id: id('a'), status: 'pending', at: Date.now(), ...p }
    run.approvals.push(a)
    this.save(run)
    this.out(run, { type: 'approval', runId: run.id, approval: a })
    return new Promise((res) => live.pending.set(a.id, res))
  }

  private async ensureHub(): Promise<string> {
    // a failed start is not kept: the next run tries again (and the half-open server is dropped so the retry starts clean)
    return (this.hubReady ??= this.hub.start().catch((e) => ((this.hubReady = null), this.hub.stop(), Promise.reject(e))))
  }

  private async linkFor(run: Run, task: Task, agent: AgentName): Promise<TeamLink | null> {
    if (!this.d.mcpScript) return null
    return { sock: await this.ensureHub(), token: this.hub.token, runId: run.id, taskId: task.id, agent, script: this.d.mcpScript, node: this.d.node ?? process.execPath }
  }

  // The one place an agent is run: wires events, usage, session handles and the budget.
  private async agentRun(run: Run, task: Task, agent: AgentName, phase: TaskPhase | 'plan' | 'final-review', prompt: string, write: boolean, cwd: string, resume?: string, changedFiles?: number): Promise<RunResult> {
    const live = this.liveOf(run)
    const skills = ['work', 'fix', 'plan'].includes(phase) && agent !== 'local' ? this.d.skills?.() : undefined // the local model cannot read outside its task folder
    const att = agent !== 'local' && ['work', 'fix', 'plan', 'review', 'final-review'].includes(phase) ? run.config.attachments : undefined
    if (att?.length) prompt = `${attachmentsBlock(att)}\n\n${prompt}`
    const past = ['work', 'fix', 'plan'].includes(phase) ? historyBlock(run.project) : ''
    if (past) prompt = `${past}\n\n${prompt}`
    if (skills?.block) prompt = `${skills.block}\n\n${prompt}`
    if (agent === 'local') {
      const text = ['work', 'fix'].includes(phase) ? this.d.localSkills?.() : ''
      prompt = forLocal(prompt)
      if (text) prompt = `${text}\n\n${prompt}`
    }
    this.out(run, { type: 'agent', runId: run.id, taskId: task.id, phase, ev: { type: 'prompt', agent, text: prompt.slice(0, 16_000) } })
    const stopWatching = write ? this.watch(run, task, cwd, task.base ?? run.baseCommit) : null
    const call = async (resumeId: string | undefined) => this.d.runner(agent, {
      cwd, prompt, write, resume: resumeId, signal: live.ctl.signal, taskId: task.id, link: await this.linkFor(run, task, agent),
      model: agent === 'codex' ? run.config.codexModel : agent === 'local' ? run.config.localModel : run.config.claudeModel,
      effort: effortFor({ agent, phase, kind: task.kind, changedFiles: changedFiles ?? (phase === 'review' ? task.changed.length : undefined), config: run.config }),
      codexMode: run.config.codexMode,
      addDirs: [...(skills?.dirs ?? []), ...(past ? [join(run.project, HISTORY_DIR)] : []), ...(att?.length ? [join(this.d.teamDir, 'attachments')] : []), ...(phase === 'final-review' && live.shots?.length ? [join(this.d.teamDir, 'visual', run.id)] : []), ...(existsSync(join(run.project, '.forge', 'references', 'repos')) ? [join(run.project, '.forge', 'references', 'repos')] : [])],
      images: [...imagePaths(att), ...(phase === 'final-review' && agent !== 'local' ? (live.shots ?? []).map((x) => x.path) : [])],
      web: run.config.webResearch !== false,
      onEvent: (ev) => {
        if (ev.type === 'limits') {
          const { agent: _a, type: _t, ...rest } = ev
          ;(run.limits ??= {})[agent] = rest
        }
        this.out(run, { type: 'agent', runId: run.id, taskId: task.id, phase, ev })
      },
      onApproval: async (a) => {
        // file changes outside the agent's folder are never waved through, whatever the permission mode
        const v = a.kind !== 'files' && a.command ? decideTool('Bash', { command: a.command }, cwd) : { verdict: 'ask' as const, reason: '' }
        if (v.verdict === 'deny') return false
        if (v.verdict === 'allow' || (a.kind !== 'files' && a.command && run.config.bypassPermissions !== false)) return true
        return (await this.ask(run, { kind: 'permission', taskId: task.id, agent, title: a.title, detail: a.detail || v.reason })).allow
      },
      onHandle: (h) => (h ? live.handles.set(task.id, { agent, h }) : live.handles.delete(task.id)),
    })
    let res: RunResult
    try {
      res = await call(resume)
      // A saved session can be gone (cleaned up by the CLI, or from another machine): carry on without its memory rather than failing the task.
      if (resume && !res.ok && !live.ctl.signal.aborted && /no conversation found|session.{0,40}not found|thread.{0,40}not found|could not find.{0,40}(session|thread)|no rollout found/i.test(res.error?.message ?? '')) {
        this.out(run, { type: 'agent', runId: run.id, taskId: task.id, phase, ev: { type: 'note', agent, text: `${agent} could not resume its earlier session; starting fresh.` } })
        res = await call(undefined)
      }
    } finally {
      stopWatching?.()
      // the agent is gone: its open questions have no one waiting, so a late answer must not go to a dead socket
      for (const a of run.approvals) {
        const res = a.status === 'pending' && a.taskId === task.id && (a.kind === 'permission' || a.kind === 'question' || a.kind === 'action') ? live.pending.get(a.id) : undefined
        if (!res) continue
        this.markApproval(run, a.id, 'expired', 'The agent that asked has finished.')
        live.pending.delete(a.id)
        res({ allow: false, note: 'The agent that asked has finished.' })
      }
    }
    for (const u of [(run.usage[agent] ??= emptyUsage()), task.usage]) {
      u.input += res.usage.input
      u.output += res.usage.output
      u.cached += res.usage.cached
      u.costUsd += res.usage.costUsd
      u.runs++
    }
    if (res.usage.input || res.usage.output) this.d.recordUsage?.(agent, res.usage)
    this.out(run, { type: 'usage', runId: run.id, usage: run.usage })
    this.save(run)
    return res
  }

  private overBudget(run: Run): string | null {
    const b = run.config.budget
    const u = run.usage
    const all = [u.claude, u.codex, u.local ?? emptyUsage()]
    const tokens = all.reduce((n, x) => n + x.input + x.output, 0)
    const runs = all.reduce((n, x) => n + x.runs, 0)
    const cost = all.reduce((n, x) => n + x.costUsd, 0)
    if (b.maxTokens && tokens >= b.maxTokens) return `token budget reached (${tokens.toLocaleString()} of ${b.maxTokens.toLocaleString()})`
    if (b.maxAgentRuns && runs >= b.maxAgentRuns) return `agent-run budget reached (${runs} of ${b.maxAgentRuns})`
    if (b.maxCostUsd && cost >= b.maxCostUsd) return `cost budget reached (about $${cost.toFixed(2)} of $${b.maxCostUsd})`
    if (b.maxMinutes && ((run.activeMs ?? 0) + (run.activeSince ? Date.now() - run.activeSince : 0)) / 60_000 >= b.maxMinutes) return `time budget reached (${b.maxMinutes} minutes)`
    const cap = run.config.maxLimitPercent
    if (cap)
      for (const [a, l] of Object.entries(run.limits ?? {})) {
        const who = a === 'codex' ? 'your ChatGPT plan' : 'your Claude plan'
        if (l && over(l.primaryPct, cap)) return `${who} allowance for this window is ${Math.round(l.primaryPct)}% used`
        if (l?.secondaryPct !== undefined && over(l.secondaryPct, cap)) return `${who} weekly allowance is ${Math.round(l.secondaryPct)}% used`
      }
    return null
  }

  // ------------------------------------------------------------------ planning

  private async plan(run: Run) {
    const live = this.liveOf(run)
    const notes = this.d.projectNotes?.(run.project) ?? { brief: '', rules: '' }
    const order: AgentName[] = run.config.planner === 'auto' ? PREFER : [run.config.planner, ...PREFER.filter((a) => a !== run.config.planner)]
    const planners = order.filter((a) => live.available.includes(a))
    const virtual = (): Task => ({ id: 'plan', title: 'Planning', goal: run.goal, acceptance: [], deps: [], agent: planners[0], kind: 'research', files: [], status: 'running', phase: null, attempts: 0, fixRounds: 0, reviews: [], sessions: {}, branch: null, worktree: null, summary: '', handoff: '', changed: [], usage: emptyUsage() })
    let lastErr = 'no planner'
    const blocked: string[] = [] // planners that cannot work until the user signs in or the allowance resets
    for (const agent of planners) {
      const t = virtual()
      let prompt = planPrompt(run.goal + (notes.rules ? `\n\nUser's rules for this project:\n${notes.rules}` : ''), notes.brief, live.available)
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await this.agentRun(run, t, agent, 'plan', prompt, false, run.integrationWorktree)
        if (live.ctl.signal.aborted) return
        if (!res.ok) {
          lastErr = res.error?.message ?? 'the planner failed'
          const kind = res.error?.kind ?? ''
          if (['limit', 'auth', 'missing'].includes(kind)) blocked.push(`${agent}: ${lastErr}`)
          if (kind === 'limit' && run.config.autoSwitch !== false) {
            live.limited.set(agent, 0)
            const next = planners.slice(planners.indexOf(agent) + 1).find((a) => !live.limited.has(a))
            if (next) this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: `${label(agent)} hit its limit: ${label(next)} took over planning` })
          }
          if (['auth', 'missing', 'model', 'limit'].includes(kind)) break // try the other agent
          continue
        }
        try {
          const plan = parsePlan(res.text, live.available, run.config.budget.maxTasks ?? 12)
          const mem = this.memory(run).load()
          run.plan = { summary: plan.summary, plannedBy: agent }
          const cheap = run.config.effortMode === 'cheap'
          run.tasks = plan.tasks.map((p) => ({ id: p.id, title: p.title, goal: p.goal, acceptance: p.acceptance, deps: p.deps, agent: cheap && p.kind !== 'research' && p.agent === 'claude' && live.available.includes('codex') ? 'codex' : p.agent ?? routeAgent(p.kind, live.available, mem.stats, cheap), kind: p.kind, files: p.files, status: 'queued', phase: null, attempts: 0, fixRounds: 0, reviews: [], sessions: {}, branch: null, worktree: null, summary: '', handoff: '', changed: [], usage: emptyUsage() }))
          for (const t of run.tasks) t.promptId = 'p1'
          if (!live.paused) this.setStatus(run, 'running') // a soft pause during planning stays a pause
          this.out(run, { type: 'plan', runId: run.id, summary: plan.summary, tasks: run.tasks })
          return
        } catch (e) {
          lastErr = (e as Error).message
          prompt = `${prompt}\n\nYour previous reply was rejected: ${lastErr}. Reply again with ONLY the JSON object.`
        }
      }
    }
    if (planners.length && blocked.length >= planners.length) {
      // every planner is waiting for the user (a sign-in, or the plan's allowance to reset): pause, and Resume plans again
      live.paused = true
      return void this.setStatus(run, 'paused', `${blocked.join(' ')} Resume to plan again.`)
    }
    throw new Error(`Could not make a plan: ${lastErr}`)
  }

  // ------------------------------------------------------------------ scheduling

  private pump(run: Run) {
    const live = this.liveOf(run)
    if (live.paused || run.status !== 'running') return
    const why = this.overBudget(run)
    if (why) return void this.hitBudget(run, why).catch(() => {})

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
      else if (!this.ready(live).includes(t.agent)) {
        const to = this.switchAgent(run, live, t.agent, '', t.id) // already known to be out: this only picks who takes the queued task
        if (to) (t.agent = to), this.touch(run, t)
      }
      if (perAgent(t.agent) >= (t.agent === 'local' ? 1 : run.config.maxParallelPerAgent)) continue // one local model at a time: two would fight over the GPU
      const p = this.execute(run, t).catch((e) => this.failTask(run, t, (e as Error).message)).finally(() => (live.running.delete(t.id), this.pump(run)))
      live.running.set(t.id, p)
    }

    if (live.running.size) return
    if (live.replans > 0) return // a newer request is being planned: more work may come
    const open = run.tasks.filter((t) => !settled(t))
    if (!open.length && this.addTestTask(run, live)) return void this.pump(run)
    if (!open.length && run.tasks.some((t) => t.status === 'done')) return this.track(live, this.finish(run).catch(() => {}))
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
    if (live.budgetAsk) return
    live.budgetAsk = true
    const r = await this.ask(run, { kind: 'budget', title: 'Budget reached', detail: `${why}. Allow 50% more and continue?` })
    live.budgetAsk = false
    if (r.allow && this.overBudget(run)) this.raiseBudget(run)
    if (r.allow && run.status === 'paused') void this.resume(run.id)
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
    // The local model gave up or failed its job: a cloud agent takes it over once (the task keeps whatever the local model already wrote), instead of the run waiting for the owner.
    const live = this.liveOf(run)
    const cloud = this.pool(live).filter((a) => a !== 'local')
    if (task.agent === 'local' && run.config.autoSwitch !== false && !task.escalated && cloud.length && task.id !== 'plan') {
      const to = strongest(cloud)
      this.memory(run).recordOutcome('local', task.kind, false)
      this.post(run, { from: 'orchestrator', to: 'all', kind: 'note', taskId: task.id, body: `The local model could not finish "${task.title}" (${message.slice(0, 160)}): ${label(to)} took it over.` })
      Object.assign(task, { escalated: true, agent: to, status: 'queued', phase: null, error: undefined, attempts: 0, fixRounds: 0, resumeFrom: undefined })
      this.touch(run, task)
      return
    }
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
    if (task.status === 'interrupted' && task.phase && task.phase !== 'work') task.resumeFrom = task.phase
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
    const build = task.kind !== 'research'
    const cwd = build ? await this.ensureWorktree(run, task) : run.integrationWorktree

    // ---- the work, with retries for the failures a retry can fix. A task interrupted after its work (in review, a fix or the merge)
    // goes straight back there: the agent's work is already in its folder.
    const resumeFrom = task.resumeFrom
    task.resumeFrom = undefined
    const workDone = build && !!resumeFrom && !!task.base && !!task.summary
    let res: RunResult | null = workDone ? ({ ok: true, text: task.summary, usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [] } as RunResult) : null
    for (; !workDone;) {
      const { inbox, steer } = this.drainInbox(run, task.agent, true)
      const prompt = workPrompt(run, task, contextFor(run, task, { inbox, steer, brief: notes.brief, rules: notes.rules, past }))
      res = await this.agentRun(run, task, task.agent, 'work', prompt, build, cwd, task.sessions[task.agent])
      if (res.sessionId) task.sessions[task.agent] = res.sessionId
      if (this.stopKind(run)) return this.interrupted(run, task)
      if (res.ok) break
      const kind: ErrorKind = res.error?.kind ?? 'other'
      const msg = res.error?.message ?? 'the agent failed'
      if (kind === 'limit') {
        const to = this.switchAgent(run, live, task.agent, msg, task.id)
        if (to) {
          task.agent = to
          this.touch(run, task)
          continue
        }
      }
      if (kind === 'auth' || kind === 'missing' || kind === 'model' || kind === 'limit') return this.blockTask(run, task, `${task.agent}: ${msg}`, true) // needs the user: sign in, or wait for the plan to reset
      task.attempts++
      if (kind === 'busy' && task.attempts <= 3) {
        this.post(run, { from: 'orchestrator', to: 'all', kind: 'note', taskId: task.id, body: `${task.agent} is busy right now; trying again shortly.` })
        await this.nap(30_000 * task.attempts, live.ctl.signal)
        if (this.stopKind(run)) return this.interrupted(run, task)
        continue
      }
      if (task.attempts > 2 || kind === 'busy') return this.failTask(run, task, `${task.agent}: ${msg}`)
      this.touch(run, task)
    }
    task.summary = res!.text
    if (!task.handoff) task.handoff = res!.text.slice(0, 1500)

    if (!build) return this.complete(run, task, `Research done: ${task.title}`)

    // ---- commit what the agent left, see what changed
    await commitAll(cwd, `${task.id}: ${task.title}`)
    task.changed = await changedSince(cwd, task.base!)
    this.touch(run, task)
    if (!task.changed.length) return this.complete(run, task, `${task.title}: finished without changing any file.`)

    // ---- review gate: the other agent reads the diff and says pass or fail; fail goes back to the author
    // A local model is often wrong, so its work is always reviewed by another agent, whatever the review setting says.
    if (run.config.review === 'cross' || task.agent === 'local') {
      let reviewer = strongest(this.pool(live), task.agent)
      if (reviewer === task.agent) this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', taskId: task.id, body: `Only ${task.agent} is ready, so it reviewed its own work on "${task.title}".` })
      let busyTries = 0
      for (let round = 1; ; round++) {
        if (this.stopForBudget(run, task, 'review')) return
        task.phase = 'review'
        this.touch(run, task)
        const diff = await diffText(cwd, task.base!)
        const { inbox, steer } = this.drainInbox(run, reviewer, true)
        const rr = await this.agentRun(run, task, reviewer, 'review', reviewPrompt(run, task, diff, round, contextFor(run, task, { inbox, steer, brief: notes.brief, rules: notes.rules, past: [] })), false, cwd, round > 1 ? task.reviewSession : undefined)
        if (rr.sessionId) task.reviewSession = rr.sessionId
        if (this.stopKind(run)) return this.interrupted(run, task)
        if (!rr.ok) {
          // work nobody could check does not count as checked: wait for the user, retry, or fail the task
          const kind: ErrorKind = rr.error?.kind ?? 'other'
          const msg = `${reviewer} could not review: ${rr.error?.message ?? 'unknown error'}`
          const to = kind === 'limit' ? this.switchAgent(run, live, reviewer, msg, `the review of ${task.id}`, task.agent) : null
          if (to) {
            reviewer = to
            task.reviewSession = undefined // that was the old reviewer's conversation
            round--
            continue
          }
          if (kind === 'auth' || kind === 'missing' || kind === 'model' || kind === 'limit') return (task.resumeFrom = 'review'), this.blockTask(run, task, msg, true)
          if (kind === 'busy' && ++busyTries <= 3) {
            this.post(run, { from: 'orchestrator', to: 'all', kind: 'note', taskId: task.id, body: `${reviewer} is busy right now; the review will be tried again shortly.` })
            await this.nap(30_000 * busyTries, live.ctl.signal)
            if (this.stopKind(run)) return this.interrupted(run, task)
            round--
            continue
          }
          return this.failTask(run, task, msg)
        }
        const v = parseVerdict(rr.text)
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
        if (this.stopForBudget(run, task, 'fix')) return
        task.fixRounds++
        task.phase = 'fix'
        this.touch(run, task)
        let fx = await this.agentRun(run, task, task.agent, 'fix', fixPrompt(task, v.issues, round, this.instructions(run, task.agent)), true, cwd, task.sessions[task.agent])
        const to = !fx.ok && !this.stopKind(run) && fx.error?.kind === 'limit' ? this.switchAgent(run, live, task.agent, fx.error.message, task.id) : null
        if (to) {
          task.agent = to // the new author carries on in the same folder
          fx = await this.agentRun(run, task, to, 'fix', fixPrompt(task, v.issues, round, this.instructions(run, to)), true, cwd, task.sessions[to])
        }
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
    let merged = false
    await live.merge.run(async () => {
      task.phase = 'merge'
      this.touch(run, task)
      if (this.stopKind(run)) return // stopped while waiting for the lock: nothing of this task goes in now
      await abortMerge(run.integrationWorktree) // a merge left half-done by an interruption starts over
      await this.clean(run.integrationWorktree) // so does a stopped fixer's half-written files
      const m = await mergeBranch(run.integrationWorktree, task.branch!, `${task.id}: ${task.title}`)
      if (m.ok) return void (merged = true)
      task.phase = 'conflict'
      this.touch(run, task)
      const resolver = strongest(this.pool(live))
      this.post(run, { from: 'orchestrator', to: resolver, kind: 'note', taskId: task.id, body: `Merge conflict in ${m.conflicts.join(', ')}; ${resolver} is resolving it.` })
      const rr = await this.agentRun(run, task, resolver, 'conflict', conflictPrompt(task, m.conflicts), true, run.integrationWorktree)
      const fin = rr.ok ? await finishMerge(run.integrationWorktree) : { ok: false, left: m.conflicts }
      if (!fin.ok) {
        await abortMerge(run.integrationWorktree)
        throw new Error(`Could not resolve the merge conflict in ${fin.left.join(', ')}.`)
      }
      merged = true
    })
    if (!merged) return this.interrupted(run, task) // a merge that went in is done even if a stop came a moment later
    await this.complete(run, task, `${task.title} is merged.`)
  }

  // The budget is also checked inside a task's review and fix loop and before the last steps, not only between tasks. The task is left
  // interrupted at `phase`, so the resume after "allow more" does not redo its work.
  private stopForBudget(run: Run, task: Task | null, phase?: TaskPhase): boolean {
    const why = this.overBudget(run)
    if (!why) return false
    if (task) {
      task.status = 'interrupted'
      task.resumeFrom = phase
      task.phase = null
      this.touch(run, task)
    }
    void this.hitBudget(run, why).catch(() => {})
    return true
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
      await this.clean(wt) // the checks must run on exactly what Apply will carry: committed work
      const cmd = run.config.verify === undefined ? detectVerify(wt) : run.config.verify
      let verify: { ok: boolean | null; command?: string; output?: string } = { ok: null }
      if (cmd) {
        let fixed: { fix: string; sig: string } | null = null // the last check-fix, remembered once the check passes after it
        for (let round = 0; ; round++) {
          const v = await runVerify(cmd, wt, live.ctl.signal)
          if (live.ctl.signal.aborted) return
          verify = { ok: v.ok, command: cmd, output: v.output }
          this.out(run, { type: 'verify', runId: run.id, command: cmd, ok: v.ok, output: v.output.slice(-4000) })
          if (v.ok) {
            if (fixed) this.learnFix(run, fixed.fix, fixed.sig)
            break
          }
          const sig = errorSignature(v.output)
          run.errors.push({ id: id('e'), signature: sig, text: v.output.slice(-400), at: Date.now() })
          if (round >= run.config.maxVerifyRounds) break
          if (this.stopForBudget(run, null)) return
          const fixer = strongest(this.pool(live))
          const t = this.addTask(run, { title: `Fix failing checks (attempt ${round + 1})`, goal: `Make \`${cmd}\` pass.`, agent: fixer, kind: 'build', lastStep: true })
          t.status = 'running'
          t.phase = 'fix'
          t.startedAt = Date.now()
          this.touch(run, t)
          const past = this.pastProblems(run, t)
          const res = await this.agentRun(run, t, fixer, 'fix', verifyFixPrompt(cmd, v.output, round + 1) + (past.length ? `\n\nSimilar problems met before:\n${past.map((p) => `- ${p}`).join('\n')}` : ''), true, wt)
          if (res.sessionId) t.sessions[fixer] = res.sessionId
          if (live.ctl.signal.aborted) return void (await this.clean(wt))
          t.summary = res.text
          await commitAll(wt, `fix: failing checks (attempt ${round + 1})`)
          t.changed = await changedSince(wt, run.baseCommit)
          t.status = res.ok ? 'done' : 'failed'
          t.error = res.ok ? undefined : res.error?.message
          t.endedAt = Date.now()
          this.touch(run, t)
          fixed = res.ok ? { fix: res.text, sig } : null
        }
      }
      if (this.reopen(run, live)) return

      const notes: string[] = []
      const total = await changedSince(wt, run.baseCommit).catch(() => [])
      const parts = run.tasks.filter((t) => t.status === 'done' && t.kind === 'build').length
      const localWork = run.tasks.some((t) => t.agent === 'local' && t.status === 'done' && t.changed?.length) // always checked as a whole, too
      // ---- a security look, when the change touches what one is for
      const sec = run.config.securityReview ?? 'auto'
      if (sec !== 'off' && total.length) {
        const diff = await diffText(wt, run.baseCommit)
        if (sec === 'always' || touchesSecurity(total, diff)) {
          if (this.stopForBudget(run, null)) return
          const t = this.virtualTask(run, 'security', 'Security review', this.pick(live, mainAuthor(run) ?? undefined))
          const { reviewer, rr } = await this.look(run, live, t, 'the security review', securityReviewPrompt(run, diff), wt, total.length)
          if (live.ctl.signal.aborted) return
          if (!rr.ok) {
            const kind: ErrorKind = rr.error?.kind ?? 'other'
            const msg = `${reviewer} could not do the security review: ${rr.error?.message ?? 'unknown error'}`
            if (kind === 'auth' || kind === 'missing' || kind === 'model' || kind === 'limit') {
              live.paused = true
              return this.setStatus(run, 'paused', `${msg}. Resume to try again.`)
            }
            notes.push(`Security review: could not run — ${rr.error?.message ?? 'unknown error'}`)
          } else {
            const v = parseVerdict(rr.text)
            notes.push(`Security review: ${v.verdict.toUpperCase()} — ${v.issues.replace(/\s+/g, ' ').slice(0, 500)}`)
            this.post(run, { from: reviewer, to: 'user', kind: 'review', body: `Security review: ${v.verdict.toUpperCase()}. ${v.issues.slice(0, 600)}` })
            if (v.verdict === 'fail') {
              const r = await this.fixLastStep(run, live, wt, reviewer, 'Fix problems from the security review', v.issues, 'fix: security review', cmd)
              if (r === 'stopped') return
              if (r) verify = { ok: r.ok, command: cmd!, output: r.output }
            }
          }
        }
      }

      if (((run.config.finalReview && (run.config.finalReview === true || parts >= 3) && run.config.review === 'cross') || localWork) && total.length) {
        if (this.stopForBudget(run, null)) return
        const t = this.virtualTask(run, 'final', 'Final review', strongest(this.pool(live)))
        await this.takeShots(run, live, total.map((f) => f.path))
        const images = reviewImagesBlock(live.shots ?? [], (run.config.attachments ?? []).filter((a) => a.kind === 'image').map((a) => a.path))
        const { reviewer, rr } = await this.look(run, live, t, 'the final review', finalReviewPrompt(run, await diffText(wt, run.baseCommit)) + (images ? `\n\n${images}` : ''), wt, total.length)
        if (live.ctl.signal.aborted) return
        if (!rr.ok) {
          const kind: ErrorKind = rr.error?.kind ?? 'other'
          const msg = `${reviewer} could not do the final review: ${rr.error?.message ?? 'unknown error'}`
          if (kind === 'auth' || kind === 'missing' || kind === 'model' || kind === 'limit') {
            live.paused = true
            return this.setStatus(run, 'paused', `${msg}. Resume to try again.`)
          }
          notes.push(`The final review could not run: ${rr.error?.message ?? 'unknown error'}`) // the user sees on the approval card that this result was not looked at as a whole
        } else {
          const v = parseVerdict(rr.text)
          notes.push(`${reviewer}: ${v.verdict.toUpperCase()} — ${v.issues.replace(/\s+/g, ' ').slice(0, 500)}`)
          this.post(run, { from: reviewer, to: 'user', kind: 'review', body: `Final review: ${v.verdict.toUpperCase()}. ${v.issues.slice(0, 600)}` })
          if (v.verdict === 'fail') {
            const r = await this.fixLastStep(run, live, wt, reviewer, 'Fix problems from the final review', v.issues, 'fix: final review', cmd)
            if (r === 'stopped') return
            if (r) verify = { ok: r.ok, command: cmd!, output: r.output }
          }
        }
      }

      if (live.ctl.signal.aborted) return // a stop during the final steps: no result to approve
      const files = await changedSince(wt, run.baseCommit).catch(() => [])
      if (this.reopen(run, live)) return // checked after the last await, so a message sent during it is not stranded
      const report = buildReport(run, verify, notes, files)
      run.final = { report, files, verifyOk: verify.ok, verifyOutput: (verify.output ?? '').slice(-2000), reviewNotes: notes }
      this.out(run, { type: 'final', runId: run.id, final: run.final })
      this.setStatus(run, 'awaiting_approval')
      const a: Approval = { id: id('a'), kind: 'final', status: 'pending', at: Date.now(), title: 'Apply the result to your project?', detail: `${files.length} file${files.length === 1 ? '' : 's'} changed.${verify.ok === false ? ' The final check FAILED.' : ''}` }
      run.approvals.push(a)
      this.save(run)
      this.out(run, { type: 'approval', runId: run.id, approval: a })
    } catch (e) {
      if (live.ctl.signal.aborted) return // stopped (or cancelled, and the folders are gone): the stop already set the status
      // the work is all on the team branch: keep it, and let the user try the last steps again
      live.paused = true
      this.setStatus(run, 'paused', `The last steps failed: ${(e as Error).message.slice(0, 200)}. Resume to try again.`)
    } finally {
      live.finishing = false
      if (run.status === 'running' && !live.paused) this.pump(run) // resumed while the stopped checks were still unwinding
    }
  }

  // Who does a whole-result job: the strongest ready agent, not the one given, and the local model only when it is the only one.
  private pick(live: Live, not?: AgentName): AgentName {
    const pool = this.pool(live)
    const big = pool.filter((a) => a !== 'local')
    return strongest(big.length ? big : pool, not)
  }

  // A read-only look at the whole result. If the reviewer's plan runs out, the next agent does it instead of the run stopping.
  // Page screenshots for the final review: only when the owner turned the check on, and (in auto) only when UI files changed. A failed capture never blocks the review.
  private async takeShots(run: Run, live: Live, files: string[]) {
    const mode = run.config.visualCheck ?? 'off'
    live.shots = undefined
    if (mode === 'off' || !this.d.visualShots) return
    if (mode === 'auto' && !files.some((f) => /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html?)$/i.test(f))) return
    try {
      let timer: NodeJS.Timeout
      const limit = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('it took more than two minutes')), 120_000) })
      live.shots = await Promise.race([this.d.visualShots(run), limit]).finally(() => clearTimeout(timer!))
      if (live.shots.length) this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: `Page check: ${live.shots.length} screenshots taken for the final review.` })
    } catch (e) {
      this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', body: `Page check skipped: ${(e as Error).message.slice(0, 200)}` })
    }
  }

  private async look(run: Run, live: Live, t: Task, what: string, prompt: string, wt: string, files: number): Promise<{ reviewer: AgentName; rr: RunResult }> {
    let reviewer = t.agent
    for (;;) {
      const rr = await this.agentRun(run, t, reviewer, 'final-review', prompt, false, wt, undefined, files)
      const to = !rr.ok && !live.ctl.signal.aborted && rr.error?.kind === 'limit' ? this.switchAgent(run, live, reviewer, rr.error.message, what) : null
      if (!to) return { reviewer, rr }
      reviewer = t.agent = to
    }
  }

  // A fix for problems the whole-result review found, then the project's check again on the changed result. 'stopped' when the run was stopped meanwhile.
  private async fixLastStep(run: Run, live: Live, wt: string, reviewer: AgentName, title: string, issues: string, commit: string, cmd: string | null): Promise<'stopped' | { ok: boolean; output: string } | null> {
    const author = strongest(this.pool(live), reviewer)
    const ft = this.addTask(run, { title, goal: issues, agent: author, kind: 'build', lastStep: true })
    ft.status = 'running'
    ft.phase = 'fix'
    ft.startedAt = Date.now()
    this.touch(run, ft)
    const fx = await this.agentRun(run, ft, author, 'fix', fixPrompt(ft, issues, 1, this.instructions(run, author)), true, wt)
    if (live.ctl.signal.aborted) return void (await this.clean(wt)), 'stopped'
    await commitAll(wt, commit)
    ft.changed = await changedSince(wt, run.baseCommit)
    ft.status = fx.ok ? 'done' : 'failed'
    ft.summary = fx.text
    ft.endedAt = Date.now()
    this.touch(run, ft)
    if (!cmd) return null
    // the fix changed the code: the project's check has to be run again on the result
    const v = await runVerify(cmd, wt, live.ctl.signal)
    if (live.ctl.signal.aborted) return 'stopped'
    this.out(run, { type: 'verify', runId: run.id, command: cmd, ok: v.ok, output: v.output.slice(-4000) })
    return { ok: v.ok, output: v.output }
  }

  // One task that writes or extends tests, once the build tasks are done and before the project check. Not when the project has no test command, the
  // changes are only docs or config, the user turned it off, or a test task (the planner's, or one of an earlier round that came after the builds) is there.
  private addTestTask(run: Run, live: Live): boolean {
    if (run.config.testTask === false || run.config.verify === null) return false
    const num = (t: Task) => Number(t.id.replace(/\D/g, '')) || 0
    const builds = run.tasks.filter((t) => t.kind === 'build' && !t.lastStep)
    const done = builds.filter((t) => t.status === 'done')
    const last = Math.max(0, ...builds.map(num))
    if (!done.length || run.tasks.some((t) => t.kind === 'test' && (num(t) > last || builds.every((b) => t.deps.includes(b.id))))) return false
    const files = done.flatMap((t) => t.changed)
    if (!files.length || onlyDocsOrConfig(files) || !detectVerify(run.integrationWorktree)) return false
    const t = this.addTask(run, { title: 'Write or extend tests for the changed code', goal: `Write or extend tests for the code the build tasks changed (${new Set(files.map((f) => f.path)).size} files). Look at the diff since the start of the run and add focused tests next to the code.`, agent: this.pick(live, mainAuthor(run) ?? undefined), kind: 'test', deps: builds.map((b) => b.id), acceptance: ['The new tests pass', 'Production code is unchanged, except for an obvious bug the tests found'] })
    this.post(run, { from: 'orchestrator', to: 'user', kind: 'note', taskId: t.id, body: `Added ${t.id} "${t.title}" for ${t.agent}.` })
    return true
  }

  // Puts a team folder back to its last commit: nothing that was not committed is checked, merged over or reported as done.
  private async clean(wt: string) {
    await git(wt, ['reset', '--hard', '-q']).catch(() => '')
    await git(wt, ['clean', '-fdq']).catch(() => '')
  }

  // Messages sent while the last checks ran become tasks, and the run goes back to work; the checks run again on the result.
  private dropFailedLastSteps(run: Run) {
    for (const t of run.tasks) if (t.lastStep && t.status === 'failed') (t.status = 'cancelled'), (t.error = 'Replaced by your next message.')
  }

  private reopen(run: Run, live: Live): boolean {
    if (!live.late.length) return false
    this.dropFailedLastSteps(run) // a failed check-fix would otherwise count as an open task and pause the run
    for (const m of live.late.splice(0)) this.messageTask(run, live, m.body, m.to)
    this.setStatus(run, 'running')
    return true
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
  private addTask(run: Run, p: { title: string; goal: string; agent: AgentName; kind: Task['kind']; deps?: string[]; acceptance?: string[]; proposedBy?: string; lastStep?: boolean; promptId?: string }): Task {
    const n = run.tasks.reduce((m, t) => Math.max(m, Number(t.id.replace(/\D/g, '')) || 0), 0) + 1
    const t: Task = { ...this.virtualTask(run, `t${n}`, p.title, p.agent), goal: p.goal, kind: p.kind, deps: p.deps ?? [], acceptance: p.acceptance ?? [], status: 'queued', proposedBy: p.proposedBy, lastStep: p.lastStep, promptId: p.promptId }
    run.tasks.push(t)
    this.touch(run, t)
    return t
  }

  private async cleanup(run: Run, deleteBranch: boolean, save = true) {
    const live = this.liveOf(run)
    await live.git.run(async () => {
      for (const t of run.tasks) if (t.worktree) (await removeWorktree(run.project, t.worktree, t.branch ?? undefined), (t.worktree = null))
      await removeWorktree(run.project, run.integrationWorktree, deleteBranch ? run.integrationBranch : undefined)
      await rm(join(this.d.teamDir, 'wt', run.id), { recursive: true, force: true }) // the empty run folder too
    })
    if (save) this.save(run)
  }

  // ------------------------------------------------------------------ what agents ask for through the mailbox

  private async onHub(op: string, args: any, ctx: HubCtx): Promise<unknown> {
    const run = this.runOf(ctx.runId)
    if (!run) throw new Error('unknown run')
    const task = run.tasks.find((t) => t.id === ctx.taskId)
    const str = (v: unknown, n = 2000) => String(v ?? '').slice(0, n)
    switch (op) {
      case 'post': {
        const to = isAgent(args.to) || args.to === 'user' ? args.to : 'all'
        const kind: MessageKind = ['finding', 'question', 'review', 'decision', 'note'].includes(args.kind) ? args.kind : 'note'
        this.post(run, { from: ctx.agent, to, kind, taskId: ctx.taskId, body: str(args.body) })
        return 'posted'
      }
      case 'inbox': {
        const { inbox, steer } = this.drainInbox(run, ctx.agent)
        this.save(run)
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
      case 'ask': {
        if (run.config.askQuestions === false) return 'The user does not want questions in this run. Decide it yourself, pick the most sensible option and note your choice in your handoff.'
        const options = (Array.isArray(args.options) ? args.options : []).slice(0, 6).map((o: any) => ({ label: str(o?.label, 80), description: o?.description ? str(o.description, 160) : undefined })).filter((o: { label: string }) => o.label)
        const q = str(args.question, 300).trim()
        if (!q) return 'No question was given.'
        const r = await this.ask(run, { kind: 'question', taskId: ctx.taskId, agent: ctx.agent, title: q, detail: '', options: options.length ? options : undefined, multi: args.multi === true && options.length > 1 })
        return r.allow && r.note ? `The user answered: ${r.note}` : 'The user chose not to answer. Decide it yourself, pick the most sensible option and note your choice in your handoff.'
      }
      case 'request_approval': {
        if (run.config.bypassPermissions !== false) return 'allowed (the user turned permission prompts off for this team)'
        const r = await this.ask(run, { kind: 'action', taskId: ctx.taskId, agent: ctx.agent, title: str(args.title, 200), detail: str(args.detail, 2000) })
        return r.allow ? `allowed${r.note ? `: ${r.note}` : ''}` : `denied${r.note ? `: ${r.note}` : ''}. Do not do it; find another way or stop.`
      }
      case 'permission': {
        const input = (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>
        const v = decideTool(str(args.tool_name, 80), input, task?.worktree ?? run.integrationWorktree)
        if (v.verdict === 'allow') return JSON.stringify({ behavior: 'allow', updatedInput: input })
        if (v.verdict === 'deny') return JSON.stringify({ behavior: 'deny', message: `Not allowed: ${v.reason}` })
        if (run.config.bypassPermissions !== false) return JSON.stringify({ behavior: 'allow', updatedInput: input })
        const what = args.tool_name === 'Bash' ? str(input.command, 300) : `${args.tool_name} ${str(input.file_path ?? input.path ?? '', 200)}`
        const r = await this.ask(run, { kind: 'permission', taskId: ctx.taskId, agent: ctx.agent, title: `${ctx.agent} wants to: ${what}`, detail: v.reason })
        return JSON.stringify(r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: r.note || 'The user said no.' })
      }
      case 'tasks':
        return run.tasks.map((t) => ({ id: t.id, title: t.title, agent: t.agent, status: t.status }))
      case 'propose_subtask': {
        if (!run.config.allowSubtasks) return 'Subtasks are turned off for this run.'
        if (run.status === 'verifying') return 'The team is checking the result and cannot take new tasks now. Put it in your handoff instead.'
        if (task?.proposedBy) return 'A subtask cannot propose more subtasks.'
        if (run.tasks.filter((t) => t.proposedBy).length >= MAX_PROPOSALS || run.tasks.length >= (run.config.budget.maxTasks ?? 12)) return 'The team already has as many tasks as allowed.'
        const avail = this.pool(this.liveOf(run))
        const agent: AgentName = isAgent(args.agent) ? (avail.includes(args.agent) ? args.agent : avail[0]) : routeAgent('build', avail, this.memory(run).load().stats, run.config.effortMode === 'cheap')
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
