import { join } from 'node:path'
import { initRepo, isRepo } from '../checkpoint'
import { readdirSync } from 'node:fs'
import { isAgent, type AgentName } from './events'
import { cleanAttachments, saveAttachments } from './attach'
import { checkTeamTools, codexLimits, codexModels, localModels, type Health, type LimitInfo } from './health'
import { TeamOrchestrator } from './orchestrator'
import { realRunner } from './runner'
import { TeamSettingsStore } from './settings'
import { TeamStore } from './store'
import type { Run, RunEvent, TeamConfig } from './types'

export type RunSummary = { id: string; goal: string; project: string; status: Run['status']; pausedReason?: string; createdAt: number; updatedAt: number; tasks: { total: number; done: number; running: number; failed: number }; pendingApprovals: number }
export const summarize = (r: Run): RunSummary => ({
  id: r.id, goal: r.goal, project: r.project, status: r.status, pausedReason: r.pausedReason, createdAt: r.createdAt, updatedAt: r.updatedAt,
  tasks: { total: r.tasks.length, done: r.tasks.filter((t) => t.status === 'done').length, running: r.tasks.filter((t) => t.status === 'running').length, failed: r.tasks.filter((t) => t.status === 'failed' || t.status === 'blocked').length },
  pendingApprovals: r.approvals.filter((a) => a.status === 'pending').length,
})

// The renderer is not trusted with the shape of the config: only known keys, clamped.
export function sanitizeConfig(raw: unknown): Partial<TeamConfig> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined)
  const out: Partial<TeamConfig> = {}
  if (r.planner === 'auto' || isAgent(r.planner)) out.planner = r.planner
  if (typeof r.localModel === 'string' && /^[\w.:/-]{1,80}$/.test(r.localModel)) out.localModel = r.localModel
  if (typeof r.codexModel === 'string' && /^[\w.:-]{1,60}$/.test(r.codexModel)) out.codexModel = r.codexModel
  if (typeof r.bypassPermissions === 'boolean') out.bypassPermissions = r.bypassPermissions
  if (r.claudeEffort === 'low' || r.claudeEffort === 'medium' || r.claudeEffort === 'high' || r.claudeEffort === 'xhigh' || r.claudeEffort === 'max') out.claudeEffort = r.claudeEffort
  if (r.codexEffort === 'low' || r.codexEffort === 'medium' || r.codexEffort === 'high' || r.codexEffort === 'xhigh') out.codexEffort = r.codexEffort
  if (typeof r.webResearch === 'boolean') out.webResearch = r.webResearch
  if (typeof r.askQuestions === 'boolean') out.askQuestions = r.askQuestions
  if (typeof r.claudeModel === 'string' && /^[\w.:\[\]-]{1,60}$/.test(r.claudeModel)) out.claudeModel = r.claudeModel
  const par = num(r.maxParallelPerAgent, 1, 4)
  if (par) out.maxParallelPerAgent = par
  const fix = num(r.maxFixRounds, 0, 5)
  if (fix !== undefined) out.maxFixRounds = fix
  const ver = num(r.maxVerifyRounds, 0, 4)
  if (ver !== undefined) out.maxVerifyRounds = ver
  if (r.review === 'cross' || r.review === 'off') out.review = r.review
  if (typeof r.finalReview === 'boolean' || r.finalReview === 'auto') out.finalReview = r.finalReview
  if (typeof r.allowSubtasks === 'boolean') out.allowSubtasks = r.allowSubtasks
  if (typeof r.reviewPlan === 'boolean') out.reviewPlan = r.reviewPlan
  if (r.codexMode === 'exec' || r.codexMode === 'app-server') out.codexMode = r.codexMode
  const cap = num(r.maxLimitPercent, 0, 100)
  if (cap !== undefined) out.maxLimitPercent = cap
  if (typeof r.verify === 'string') out.verify = r.verify.slice(0, 300) || null
  else if (r.verify === null) out.verify = null
  if (r.budget && typeof r.budget === 'object') {
    const b = r.budget as Record<string, unknown>
    out.budget = {}
    for (const [k, hi] of [['maxTokens', 1e9], ['maxMinutes', 24 * 60], ['maxAgentRuns', 1000], ['maxTasks', 30]] as const) {
      const v = num(b[k], 1, hi)
      if (v) out.budget[k] = v
    }
    if (typeof b.maxCostUsd === 'number' && b.maxCostUsd > 0 && b.maxCostUsd < 10_000) out.budget.maxCostUsd = b.maxCostUsd
  }
  return out
}

export type TeamMemory = NonNullable<ReturnType<TeamOrchestrator['memorySnapshot']>>

// Team mode puts each agent on its own git branch. An empty folder gets a repository silently; a folder with files must already have one.
export async function ensureRepo(project: string) {
  if (await isRepo(project)) return
  if (readdirSync(project).length) throw new Error('Team mode needs a git repository so each agent can work on its own branch. Run "git init" in this folder first.')
  await initRepo(project)
}

const ACTIVE = ['planning', 'running', 'paused', 'verifying', 'awaiting_approval', 'interrupted']

export function createTeamService(o: { userData: string; mcpScript: string; emit: (ev: RunEvent) => void; projectNotes: (project: string) => { brief: string; rules: string }; recordUsage?: (agent: AgentName, u: { input: number; output: number }) => void; skills?: () => { block: string; dirs: string[] } }) {
  const teamDir = join(o.userData, 'team')
  let healthAt = 0
  let healthCache: Health[] = []
  const health = async (force = false) => {
    if (force || Date.now() - healthAt > 20_000) {
      healthCache = await checkTeamTools()
      healthAt = Date.now()
    }
    return healthCache
  }
  const orch = new TeamOrchestrator({
    store: new TeamStore(join(teamDir, 'runs')),
    teamDir,
    runner: realRunner,
    available: async () => (await health(true)).filter((h) => h.ok).map((h) => h.agent as AgentName),
    codexModels: () => codexModels(),
    localModels: () => localModels(),
    limits: async () => {
      const codex = await codexLimits()
      return codex ? { codex } : {}
    },
    emit: o.emit,
    projectNotes: o.projectNotes,
    recordUsage: o.recordUsage,
    skills: o.skills,
    mcpScript: o.mcpScript,
  })
  orch.recoverAll()
  void orch.sweep()
  const settings = new TeamSettingsStore(teamDir)

  return {
    orch,
    health: async () => ({ agents: await health(true), codexModels: await codexModels(), localModels: await localModels(), limits: { codex: (await codexLimits()) ?? undefined } as { codex?: LimitInfo } }),
    attach: (files: { name: string; data: string }[]) => saveAttachments(join(teamDir, 'attachments'), files),
    async start(project: string, goal: string, config?: Partial<TeamConfig>, attachments?: unknown) {
      if (!goal.trim()) throw new Error('Describe what the team should build.')
      if (orch.list().some((r) => r.project === project && ACTIVE.includes(r.status))) throw new Error('This project already has a team run in progress. Finish, apply or cancel it first.')
      await ensureRepo(project)
      const files = cleanAttachments(join(teamDir, 'attachments'), attachments)
      return summarize(await orch.start(project, goal, { ...settings.get(project), ...config, ...(files.length ? { attachments: files } : {}), budget: { maxTasks: settings.get(project).budget?.maxTasks, ...config?.budget } }))
    },
    // Another message for a run: the run is one never-ending chat, so this always goes to the same run (see TeamOrchestrator.followUp).
    async followUp(id: string, text: string, to: AgentName | 'all' = 'all') {
      if (!orch.get(id)) throw new Error('This run no longer exists.')
      const run = orch.get(id)!
      if (['done', 'failed', 'cancelled'].includes(run.status) && orch.list().some((r) => r.id !== id && r.project === run.project && ACTIVE.includes(r.status))) throw new Error('Another crew run in this project is in progress. Finish or cancel it first.')
      await orch.followUp(id, text, to)
    },
    list: () => orch.list().map(summarize),
    // A plain-text summary to paste into a bug report: versions, sign-ins, plan allowance, recent runs. No secrets, no file contents.
    async diagnostics(): Promise<string> {
      const [agents, models, limits] = await Promise.all([health(true), codexModels(), codexLimits()])
      const pct = (n?: number) => (n === undefined ? '?' : `${Math.round(n)}%`)
      const lines = [
        `Forge team mode diagnostics`,
        `platform: ${process.platform} ${process.arch}, electron ${process.versions.electron}, node ${process.versions.node}`,
        ...agents.map((a) => `${a.agent}: ${a.ok ? 'ready' : 'NOT READY'} ${a.version ?? ''} - ${a.detail}${a.fix ? ` (fix: ${a.fix})` : ''}`),
        `codex models: ${models.join(', ') || '(none)'}`,
        `local models (Ollama): ${(await localModels().catch(() => [])).join(', ') || '(none)'}`,
        limits ? `codex plan allowance: ${pct(limits.primaryPct)} of the 5-hour window, ${pct(limits.secondaryPct)} of the week (${limits.plan ?? 'plan unknown'})` : 'codex plan allowance: unknown',
        `recent runs:`,
        ...orch.list().slice(0, 5).map((r) => `- ${r.id} ${r.status}${r.pausedReason ? ` (${r.pausedReason.slice(0, 120)})` : ''}: ${r.tasks.filter((t) => t.status === 'done').length}/${r.tasks.length} tasks done, ${r.usage.claude.runs} Claude runs, ${r.usage.codex.runs} Codex runs`),
      ]
      return lines.join('\n')
    },
    settings: { get: (project: string) => settings.get(project), set: (project: string, cfg: unknown) => settings.set(project, sanitizeConfig(cfg)) },
  }
}
export type TeamService = ReturnType<typeof createTeamService>
