import type { AgentName, TeamEvent } from './events'

// ---- the shared model of one team run: everything the orchestrator, the agents (through the mailbox) and the UI agree on ----

export type TaskKind = 'build' | 'research' // research reads and reports, build changes files
export type TaskStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'proposed'
export type TaskPhase = 'work' | 'review' | 'fix' | 'merge' | 'conflict'

export type Review = { by: AgentName; verdict: 'pass' | 'fail' | 'unclear'; issues: string; round: number; at: number }
export type Usage = { input: number; output: number; cached: number; costUsd: number; runs: number }
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cached: 0, costUsd: 0, runs: 0 })

export type Task = {
  id: string
  title: string
  goal: string
  acceptance: string[]
  deps: string[]
  agent: AgentName
  kind: TaskKind
  files: string[] // files the planner expects it to touch (a hint, used to spot overlapping tasks)
  status: TaskStatus
  phase: TaskPhase | null
  attempts: number // runs of the author that failed and were retried
  fixRounds: number
  reviews: Review[]
  sessions: Partial<Record<AgentName, string>> // resume handles, so a restart or a fix round keeps the agent's memory
  branch: string | null
  worktree: string | null
  base?: string // the team branch commit this task's worktree started from
  reviewSession?: string // the reviewer's resume handle, so round 2 remembers round 1
  summary: string // the author's closing words
  handoff: string // what the next task needs to know (recorded through the mailbox, or the summary)
  changed: { path: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number }[]
  usage: Usage
  diff?: string // the task's change as the reviewer saw it (capped), kept for the diff view after the worktree is gone
  proposedBy?: string
  error?: string
  startedAt?: number
  endedAt?: number
}

export type MessageKind = 'finding' | 'question' | 'review' | 'handoff' | 'decision' | 'note' | 'steer'
export type Message = { id: string; from: AgentName | 'orchestrator' | 'user'; to: AgentName | 'all' | 'user'; taskId?: string; kind: MessageKind; body: string; at: number; readBy: string[] }

export type Decision = { id: string; text: string; by: string; taskId?: string; at: number }
export type ErrorRecord = { id: string; taskId?: string; signature: string; text: string; fix?: string; at: number }

export type ApprovalKind = 'action' | 'permission' | 'question' | 'review_override' | 'subtask' | 'budget' | 'final'
export type Approval = {
  id: string
  kind: ApprovalKind
  title: string
  detail: string
  taskId?: string
  agent?: AgentName
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  answer?: string
  at: number
  answeredAt?: number
}

export type RunStatus = 'planning' | 'running' | 'paused' | 'verifying' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export type Budget = { maxTokens?: number; maxMinutes?: number; maxAgentRuns?: number; maxCostUsd?: number; maxTasks?: number }

export type TeamConfig = {
  planner: AgentName | 'auto'
  codexModel: string
  claudeModel?: string
  claudeEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxParallelPerAgent: number
  maxFixRounds: number
  maxVerifyRounds: number
  review: 'cross' | 'off'
  finalReview: boolean
  verify?: string | null // null = none, undefined = detect from the project
  allowSubtasks: boolean
  budget: Budget
  codexMode: 'exec' | 'app-server' // app-server: live steering, approvals, plan-allowance readout
  maxLimitPercent: number // pause when a subscription's short-window allowance is this used (0 = never)
}

export const DEFAULT_CONFIG: TeamConfig = { planner: 'auto', codexModel: '', maxParallelPerAgent: 2, maxFixRounds: 3, maxVerifyRounds: 2, review: 'cross', finalReview: true, allowSubtasks: true, budget: { maxTasks: 12 }, codexMode: 'app-server', maxLimitPercent: 90 }

export type RunFinal = { report: string; files: Task['changed']; verifyOk: boolean | null; verifyOutput: string; reviewNotes: string[] }

export type Run = {
  id: string
  project: string
  goal: string
  status: RunStatus
  pausedReason?: string
  createdAt: number
  updatedAt: number
  baseCommit: string // a snapshot of the project (uncommitted work included) the team started from
  integrationBranch: string
  integrationWorktree: string
  plan: { summary: string; plannedBy: AgentName | null }
  tasks: Task[]
  messages: Message[]
  decisions: Decision[]
  errors: ErrorRecord[]
  approvals: Approval[]
  usage: Record<AgentName, Usage>
  config: TeamConfig
  limits?: Partial<Record<AgentName, { primaryPct: number; primaryResetsAt?: number; secondaryPct?: number; secondaryResetsAt?: number }>>
  final?: RunFinal
  applied?: boolean
  appliedCheckpoint?: string // the recovery point taken just before the result was applied; teamUndo puts the folder back
  undone?: boolean
}

// What the UI and the log follow. `agent` carries the raw normalised agent events (text, tools, usage) with the task they belong to.
export type RunEvent =
  | { type: 'run'; runId: string; status: RunStatus; reason?: string }
  | { type: 'plan'; runId: string; summary: string; tasks: Task[] }
  | { type: 'task'; runId: string; task: Task }
  | { type: 'agent'; runId: string; taskId: string; phase: TaskPhase | 'plan' | 'final-review'; ev: TeamEvent }
  // What an agent's folder holds right now compared with where the task started: changes while it works, before anything is committed.
  | { type: 'live'; runId: string; taskId: string; files: Task['changed'] }
  | { type: 'message'; runId: string; message: Message }
  | { type: 'approval'; runId: string; approval: Approval }
  | { type: 'verify'; runId: string; command: string; ok: boolean; output: string }
  | { type: 'usage'; runId: string; usage: Record<AgentName, Usage> }
  | { type: 'final'; runId: string; final: RunFinal }
