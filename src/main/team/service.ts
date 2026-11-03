import { join } from 'node:path'
import { initRepo, isRepo } from '../checkpoint'
import { readdirSync } from 'node:fs'
import type { AgentName } from './events'
import { checkTeamTools, codexModels, type Health } from './health'
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
  if (r.planner === 'auto' || r.planner === 'claude' || r.planner === 'codex') out.planner = r.planner
  if (typeof r.codexModel === 'string' && /^[\w.:-]{1,60}$/.test(r.codexModel)) out.codexModel = r.codexModel
  if (r.claudeEffort === 'low' || r.claudeEffort === 'medium' || r.claudeEffort === 'high' || r.claudeEffort === 'xhigh' || r.claudeEffort === 'max') out.claudeEffort = r.claudeEffort
  if (typeof r.claudeModel === 'string' && /^[\w.:\[\]-]{1,60}$/.test(r.claudeModel)) out.claudeModel = r.claudeModel
  const par = num(r.maxParallelPerAgent, 1, 4)
  if (par) out.maxParallelPerAgent = par
  const fix = num(r.maxFixRounds, 0, 5)
  if (fix !== undefined) out.maxFixRounds = fix
  const ver = num(r.maxVerifyRounds, 0, 4)
  if (ver !== undefined) out.maxVerifyRounds = ver
  if (r.review === 'cross' || r.review === 'off') out.review = r.review
  if (typeof r.finalReview === 'boolean') out.finalReview = r.finalReview
  if (typeof r.allowSubtasks === 'boolean') out.allowSubtasks = r.allowSubtasks
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

const ACTIVE = ['planning', 'running', 'paused', 'verifying', 'awaiting_approval', 'interrupted']

export function createTeamService(o: { userData: string; mcpScript: string; emit: (ev: RunEvent) => void; projectNotes: (project: string) => { brief: string; rules: string } }) {
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
    emit: o.emit,
    projectNotes: o.projectNotes,
    mcpScript: o.mcpScript,
  })
  orch.recoverAll()
  void orch.sweep()
  const settings = new TeamSettingsStore(teamDir)

  return {
    orch,
    health: async () => ({ agents: await health(true), codexModels: await codexModels() }),
    async start(project: string, goal: string, config?: Partial<TeamConfig>) {
      if (!goal.trim()) throw new Error('Describe what the team should build.')
      if (orch.list().some((r) => r.project === project && ACTIVE.includes(r.status))) throw new Error('This project already has a team run in progress. Finish, apply or cancel it first.')
      if (!(await isRepo(project))) {
        if (readdirSync(project).length) throw new Error('Team mode needs a git repository so each agent can work on its own branch. Run "git init" in this folder first.')
        await initRepo(project)
      }
      return summarize(await orch.start(project, goal, { ...settings.get(project), ...config, budget: { ...settings.get(project).budget, ...config?.budget } }))
    },
    list: () => orch.list().map(summarize),
    settings: { get: (project: string) => settings.get(project), set: (project: string, cfg: unknown) => settings.set(project, sanitizeConfig(cfg)) },
  }
}
export type TeamService = ReturnType<typeof createTeamService>
