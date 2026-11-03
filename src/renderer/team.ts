import type { Run, RunEvent, Task, TeamConfig } from '../main/team/types'
import type { RunSummary, TeamMemory } from '../main/team/service'
import { md, folderName, formatTokens } from './format'
import { icon } from './icons'
import { $, cleanErr, h, toast } from './ui'
import { replayRun } from './teamReplay'
import { normaliseTeamEventsAsync, reduceTeamView, type LoggedTeamEvent } from './teamReducer'

type Logged = LoggedTeamEvent
type Summary = RunSummary
const root = $('team-root')
const app = $('app')
let run: Run | null = null
let log: Logged[] = []
let summaries: Summary[] = []
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let currentProject = ''
let replay = false
let replayScenario = 'entry'
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let memoryTimer: ReturnType<typeof setTimeout> | null = null
let sharedMemory: TeamMemory | null = null
let memoryLoading = false
let liveFiles = new Map<string, Task['changed']>()
let undoResult = ''
let runFilter = 'all'
let runSearch = ''
let steerDraft = ''
let steerTarget: 'all' | 'claude' | 'codex' | 'local' = 'all'
const AGENT_NAME = { claude: 'Claude', codex: 'Codex', local: 'Local model' } as const
let laneDetails = (() => { try { return localStorage.getItem('forge.teamLaneDetails') === '1' } catch { return false } })()
// The lanes show what an agent says and the code it writes. Commands, step results, prompts and reasoning sit behind "Details".
const laneVisible = (ev: RunEvent & { type: 'agent' }) => { const e = ev.ev; return laneDetails || e.type === 'text' || e.type === 'code' || e.type === 'error' || (e.type === 'delta' && e.channel === 'text') || (e.type === 'done' && !e.ok) }
const PHASE_LABEL: Record<string, string> = { work: 'Working', review: 'Reviewing', fix: 'Fixing', merge: 'Merging', conflict: 'Resolving a conflict', plan: 'Planning', 'final-review': 'Final review' }
const AGENT_FULL = { claude: 'Claude Code', codex: 'OpenAI Codex', local: 'Local model' } as const

const apiReady = () => typeof window.forge.teamStart === 'function'
const fmtTime = (seconds: number) => seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
const statusLabel = (status: Run['status']) => ({ planning: 'Planning', running: 'Working', paused: 'Paused', verifying: 'Checking', awaiting_approval: 'Ready for you', done: 'Finished', failed: 'Needs attention', cancelled: 'Cancelled', interrupted: 'Interrupted' })[status]
const isActive = (status: Run['status']) => ['planning', 'running', 'paused', 'verifying', 'awaiting_approval', 'interrupted'].includes(status)
const call = async (fn: () => Promise<unknown>) => { try { await fn() } catch (e) { toast(cleanErr(e), 5000) } }

function showTeam(entry = true) {
  app.classList.add('team-mode')
  $('mode-team').classList.add('active')
  $('mode-chat').classList.remove('active')
  $('team-screen').hidden = false
  $('chat').hidden = true
  $('workspace').setAttribute('aria-hidden', 'true')
  if (entry) void showEntry()
}
function showChat() {
  app.classList.remove('team-mode')
  $('mode-team').classList.remove('active')
  $('mode-chat').classList.add('active')
  $('team-screen').hidden = true
  $('chat').hidden = false
  $('workspace').removeAttribute('aria-hidden')
}

function field(label: string, control: HTMLElement, hint = '') {
  const wrap = h('label', 'team-field')
  wrap.append(h('span', '', label), control)
  if (hint) wrap.append(h('small', '', hint))
  return wrap
}
const input = (type: string, value = '') => { const el = document.createElement('input'); el.type = type; el.value = value; return el }
const select = (values: [string, string][], value = '') => { const el = document.createElement('select'); for (const [v, label] of values) el.append(new Option(label, v)); el.value = value; return el }

async function showEntry() {
  run = null; log = []; liveFiles.clear(); sharedMemory = null; undoResult = ''; stopClock()
  root.replaceChildren(h('div', 'team-entry-skeleton skel'))
  if (!apiReady()) {
    const unavailable = h('section', 'team-entry')
    unavailable.append(h('div', 'team-entry-mark', '2'), h('h1', '', 'Team Mode is coming together'), h('p', 'team-lede', 'This build does not include the team service yet. Update Forge to use Claude Code and Codex together.'))
    root.replaceChildren(unavailable); return
  }
  replay = localStorage.getItem('forge.teamReplay') === '1' || new URLSearchParams(location.search).has('team-replay')
  const replayState = localStorage.getItem('forge.teamReplayState') ?? 'entry'; replayScenario = replayState
  const replayHealth = replayState === 'unavailable'
    ? { agents: [{ agent: 'claude' as const, ok: false, detail: 'Claude Code is not signed in.', fix: 'Run: claude auth login' }, { agent: 'codex' as const, ok: true, detail: 'Ready' }], codexModels: ['qwen3:0.6b'], localModels: ['qwen3:8b'], limits: {} }
    : { agents: [{ agent: 'claude' as const, ok: true, detail: 'Ready' }, { agent: 'codex' as const, ok: true, detail: 'Ready' }, { agent: 'local' as const, ok: true, detail: '3 models installed' }], codexModels: ['qwen3:0.6b'], localModels: ['qwen3:8b'], limits: { codex: { primaryPct: 27, primaryResetsAt: Date.now() / 1000 + 9000, secondaryPct: 12 } } }
  const replaySummary: Summary = { id: 'replay-team-run', goal: 'Build a shared planning space where two agents can work together', project: '/tmp/forge-team-replay', status: 'interrupted', createdAt: Date.now() - 3_600_000, updatedAt: Date.now() - 62_000, tasks: { total: 3, done: 1, running: 0, failed: 0 }, pendingApprovals: 0 }
  let loadError: unknown
  const loaded = await Promise.all([
    replay ? Promise.resolve(replayHealth) : window.forge.teamHealth(),
    replay ? Promise.resolve([replaySummary]) : window.forge.teamList(),
    !replay && typeof window.forge.teamSettingsGet === 'function' ? window.forge.teamSettingsGet() : Promise.resolve({} as Partial<TeamConfig>),
  ]).catch(error => { loadError = error; return null })
  if (!loaded) {
    const failure = h('section', 'team-entry team-load-error')
    failure.append(h('div', 'eyebrow', 'TEAM MODE'), h('h1', '', 'The team room could not open.'), h('p', 'team-lede', cleanErr(loadError)))
    const retry = h('button', 'btn primary', 'Try again'); retry.onclick = () => void showEntry(); failure.append(retry)
    root.replaceChildren(failure); return
  }
  const [health, list, defaults] = loaded
  summaries = list
  const page = h('div', 'team-entry')
  const intro = h('section', 'team-intro')
  intro.append(h('div', 'eyebrow', 'YOUR AI TEAM · ONE RESULT'), h('h1', '', 'Build with a second set of eyes.'), h('p', 'team-lede', 'Claude Code, Codex and a model on your own computer divide the work, review each other, and bring one checked result back for your approval. Use any one, or any mix. Your project stays untouched until you apply it.'))
  const form = h('form', 'team-start-card')
  const goal = document.createElement('textarea'); goal.rows = 4; goal.placeholder = 'Describe what the team should build'; goal.setAttribute('aria-label', 'Team goal')
  const project = h('button', 'pill team-project') as HTMLButtonElement; project.type = 'button'; project.append(icon('folder', 'sm'), document.createTextNode(currentProject ? folderName(currentProject) : 'Choose project folder'))
  project.onclick = () => $('project').click()
  const advanced = h('details', 'team-advanced') as HTMLDetailsElement
  const summary = h('summary'); summary.append(icon('sliders', 'sm'), document.createTextNode('Advanced setup'))
  const planner = select([['auto', 'Choose for me'], ['claude', 'Claude'], ['codex', 'Codex'], ['local', 'Local model']], defaults.planner ?? 'auto')
  const parallel = input('number', String(defaults.maxParallelPerAgent ?? 2)); parallel.min = '1'; parallel.max = '4'
  const review = select([['cross', 'Cross-review every task'], ['off', 'No cross-review']], defaults.review ?? 'cross')
  const finalReview = select([['auto', 'Automatic (bigger runs only)'], ['true', 'Always check the combined result'], ['false', 'Skip the final review']], String(defaults.finalReview ?? 'auto'))
  const permissions = select([['bypass', 'Never ask me (bypass)'], ['ask', 'Ask before risky actions']], defaults.bypassPermissions === false ? 'ask' : 'bypass')
  const reviewPlan = select([['false', 'Start right away'], ['true', 'Let me review the plan first']], String(defaults.reviewPlan ?? false))
  const fixRounds = input('number', String(defaults.maxFixRounds ?? 3)); fixRounds.min = '0'; fixRounds.max = '5'
  const codexMode = select([['app-server', 'Live Codex session'], ['exec', 'Simple Codex run']], defaults.codexMode ?? 'app-server')
  const verify = input('text', defaults.verify === null ? '' : defaults.verify ?? ''); verify.placeholder = 'Detect from project'
  const codexModel = select(health.codexModels.map(m => [m, m] as [string, string]), defaults.codexModel ?? health.codexModels[0] ?? '')
  const localModel = select(health.localModels.map(m => [m, m] as [string, string]), defaults.localModel ?? health.localModels[0] ?? '')
  const claudeModel = input('text', defaults.claudeModel ?? ''); claudeModel.placeholder = 'Default Claude model'
  const effort = select([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Maximum']], defaults.claudeEffort ?? 'high')
  const minutes = input('number', String(defaults.budget?.maxMinutes ?? 60)); minutes.min = '1'
  const tokens = input('number', String(defaults.budget?.maxTokens ?? 500000)); tokens.min = '1000'; tokens.step = '1000'
  const runs = input('number', String(defaults.budget?.maxAgentRuns ?? 20)); runs.min = '1'
  const maxTasks = input('number', String(defaults.budget?.maxTasks ?? 12)); maxTasks.min = '1'; maxTasks.max = '30'
  const limit = input('number', String(defaults.maxLimitPercent ?? 90)); limit.min = '0'; limit.max = '100'
  const grid = h('div', 'team-config-grid')
  grid.append(field('Planner', planner, 'Chooses who splits the goal into tasks.'), field('Parallel tasks per agent', parallel, 'More tasks can finish sooner, but use more allowance.'), field('Task review', review), field('Final review', finalReview, 'Automatic checks the whole result only for runs of 3 or more tasks, which saves plan usage.'), field('Permissions', permissions, 'Bypass lets the agents run commands and read files without asking. They still cannot push to git, use sudo, or write outside their own task folder.'), field('Plan approval', reviewPlan, 'Stops after planning so you can edit, reassign or skip tasks before any agent works.'), field('Fix attempts per task', fixRounds), field('Project check', verify, 'Leave blank to detect it from the project.'), field('Codex connection', codexMode, 'Live sessions support streaming and immediate steering.'), field('Codex model', codexModel), ...(health.localModels.length ? [field('Local model', localModel, 'Runs on this computer through Ollama. Free, but weaker: the team gives it simple tasks.')] : []), field('Claude model', claudeModel), field('Claude effort', effort), field('Time budget (minutes)', minutes), field('Token budget', tokens), field('Agent runs', runs), field('Maximum tasks', maxTasks), field('Pause at plan usage %', limit, '0 disables this limit.'))
  const validation = h('div', 'team-config-error'); validation.setAttribute('role', 'alert')
  const numeric = [parallel, fixRounds, minutes, tokens, runs, maxTasks, limit]
  const readConfig = (): Partial<TeamConfig> | null => {
    if (numeric.some(item => !item.checkValidity() || !Number.isFinite(Number(item.value)))) { validation.textContent = 'Check the highlighted team settings.'; numeric.find(item => !item.checkValidity())?.focus(); return null }
    validation.textContent = ''
    return { planner: planner.value as TeamConfig['planner'], maxParallelPerAgent: Number(parallel.value), review: review.value as TeamConfig['review'], finalReview: finalReview.value === 'auto' ? 'auto' : finalReview.value === 'true', reviewPlan: reviewPlan.value === 'true', bypassPermissions: permissions.value === 'bypass', maxFixRounds: Number(fixRounds.value), codexMode: codexMode.value as TeamConfig['codexMode'], verify: verify.value.trim() || undefined, codexModel: codexModel.value, localModel: localModel.value || undefined, claudeModel: claudeModel.value.trim() || undefined, claudeEffort: effort.value as TeamConfig['claudeEffort'], maxLimitPercent: Number(limit.value), budget: { maxMinutes: Number(minutes.value), maxTokens: Number(tokens.value), maxAgentRuns: Number(runs.value), maxTasks: Number(maxTasks.value) } }
  }
  const reset = h('button', 'btn', 'Reset team defaults') as HTMLButtonElement; reset.type = 'button'; reset.onclick = () => { planner.value = 'auto'; parallel.value = '2'; review.value = 'cross'; finalReview.value = 'auto'; reviewPlan.value = 'false'; permissions.value = 'bypass'; fixRounds.value = '3'; verify.value = ''; codexMode.value = 'app-server'; claudeModel.value = ''; effort.value = 'high'; minutes.value = '60'; tokens.value = '500000'; runs.value = '20'; maxTasks.value = '12'; limit.value = '90'; validation.textContent = 'Defaults restored. They will save when you start a run.' }
  const saveDefaults = h('button', 'btn', 'Save team defaults') as HTMLButtonElement; saveDefaults.type = 'button'; saveDefaults.onclick = () => void call(async () => { const config = readConfig(); if (!config || typeof window.forge.teamSettingsSet !== 'function') return; await window.forge.teamSettingsSet(config); validation.textContent = 'Team defaults saved for this project.' })
  const settingActions = h('div', 'team-setting-actions'); settingActions.append(reset, saveDefaults)
  advanced.append(summary, grid, validation, settingActions)
  const healthBox = h('div', 'team-health')
  for (const agent of health.agents) {
    const row = h('div', `health-row ${agent.ok ? 'ready' : 'missing'}`)
    row.append(h('span', `agent-orb ${agent.agent}`), h('strong', '', AGENT_FULL[agent.agent]), h('span', '', agent.detail))
    if (!agent.ok && 'fix' in agent && agent.fix) row.append(h('code', '', agent.fix))
    healthBox.append(row)
  }
  const allowance = health.limits?.codex
  if (allowance) {
    const worst = Math.max(allowance.primaryPct, allowance.secondaryPct ?? 0), resets = allowance.primaryResetsAt ? new Date(allowance.primaryResetsAt * (allowance.primaryResetsAt < 1e12 ? 1000 : 1)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    const meter = h('div', `health-allowance ${worst >= 80 ? 'high' : ''}`, `ChatGPT plan: ${Math.round(allowance.primaryPct)}% of this window used${resets ? ` · resets ${resets}` : ''}${allowance.secondaryPct !== undefined ? ` · ${Math.round(allowance.secondaryPct)}% of the week` : ''}`)
    if (worst >= 80) meter.append(h('small', '', 'Codex may be left out of new runs until the allowance resets.'))
    healthBox.append(meter)
  }
  const ready = health.agents.filter(a => a.ok)
  const start = h('button', 'btn primary team-start', ready.length ? `Start with ${ready.length > 1 ? 'the team' : AGENT_NAME[ready[0].agent]}` : 'No agent is ready') as HTMLButtonElement
  start.disabled = !ready.length
  const diagnostics = h('button', 'link-btn', 'Copy diagnostics') as HTMLButtonElement; diagnostics.type = 'button'; diagnostics.title = 'Copies versions, agent status and recent runs for a bug report. No secrets or file contents.'
  diagnostics.onclick = () => void call(async () => { const text = replay ? 'Forge replay diagnostics' : await window.forge.teamDiagnostics(); await navigator.clipboard.writeText(text); toast('Diagnostics copied') })
  const actions = h('div', 'team-start-actions'); actions.append(project, diagnostics, h('span', 'grow'), start)
  form.append(goal, healthBox, advanced, actions)
  form.onsubmit = async e => {
    e.preventDefault(); const text = goal.value.trim(); if (!text || start.disabled) return
    const config = readConfig(); if (!config) return
    start.disabled = true; start.textContent = 'Preparing the team…'
    if (replay) { const fixture = replayRun('planning'); await openRun(fixture.run.id, fixture); return }
    try { if (typeof window.forge.teamSettingsSet === 'function') await window.forge.teamSettingsSet(config); const started = await window.forge.teamStart(text, config); await openRun(started.id) }
    catch (err) { start.disabled = false; start.textContent = 'Start with the team'; toast(cleanErr(err), 6000) }
  }
  intro.append(form); page.append(intro)
  page.append(renderRunList())
  root.replaceChildren(page); goal.focus()
  if (replay && !['entry', 'unavailable'].includes(replayState)) await openRun('replay-team-run', replayRun(replayState))
}

function renderRunList() {
  const section = h('section', 'team-runs')
  const head = h('div', 'team-section-head'); head.append(h('div', '', 'Previous team runs'), h('span', '', `${summaries.length}`)); section.append(head)
  const tools = h('div', 'team-run-tools')
  const search = input('search', runSearch); search.placeholder = 'Search goals'; search.setAttribute('aria-label', 'Search team runs')
  const filter = select([['all', 'All runs'], ['active', 'In progress'], ['attention', 'Needs attention'], ['done', 'Finished']], runFilter); filter.setAttribute('aria-label', 'Filter team runs')
  search.oninput = () => { runSearch = search.value; const next = renderRunList(); section.replaceWith(next); queueMicrotask(() => { const field = next.querySelector<HTMLInputElement>('input[type="search"]'); field?.focus(); field?.setSelectionRange(field.value.length, field.value.length) }) }
  filter.onchange = () => { runFilter = filter.value; section.replaceWith(renderRunList()) }
  tools.append(search, filter); section.append(tools)
  const active = ['planning', 'running', 'verifying', 'paused', 'interrupted', 'awaiting_approval']
  const visible = [...summaries].sort((a, b) => b.updatedAt - a.updatedAt).filter(item => item.goal.toLowerCase().includes(runSearch.trim().toLowerCase()) && (runFilter === 'all' || runFilter === 'active' && active.includes(item.status) || runFilter === 'attention' && ['failed', 'paused', 'interrupted'].includes(item.status) || runFilter === 'done' && ['done', 'cancelled'].includes(item.status)))
  if (!summaries.length) { section.append(h('p', 'team-empty', 'No team runs yet. Describe a small goal above to start one.')); return section }
  if (!visible.length) { section.append(h('p', 'team-empty', 'No team runs match this search and filter.')); return section }
  for (const item of visible) {
    const row = h('article', 'team-run-row')
    const open = h('button', 'team-run-open'); open.onclick = () => void (replay ? openRun(item.id, replayRun('interrupted')) : openRun(item.id))
    const meta = h('span', 'team-run-meta'); meta.append(h('span', `status-pill ${item.status}`, statusLabel(item.status)), h('span', '', `${item.tasks.done}/${item.tasks.total} tasks`))
    open.append(h('strong', '', item.goal), meta)
    row.append(open)
    if (typeof window.forge.teamExportReport === 'function' && ['awaiting_approval', 'done'].includes(item.status)) { const exportButton = h('button', 'icon-btn sm'); exportButton.append(icon('download', 'sm')); exportButton.title = 'Export report'; exportButton.setAttribute('aria-label', `Export report for ${item.goal}`); exportButton.onclick = () => void call(() => window.forge.teamExportReport(item.id)); row.append(exportButton) }
    if (typeof window.forge.teamDelete === 'function' && !['planning', 'running', 'verifying', 'paused', 'interrupted'].includes(item.status)) {
      const del = h('button', 'icon-btn sm'); del.append(icon('trash', 'sm')); del.title = 'Delete run'; del.setAttribute('aria-label', `Delete ${item.goal}`)
      del.onclick = () => void call(async () => { if (!window.confirm(`Delete this team run?\n\n${item.goal}\n\nIts saved report and unfinished Team work will be removed.`)) return; if (await window.forge.teamDelete(item.id)) { summaries = summaries.filter(x => x.id !== item.id); section.replaceWith(renderRunList()) } })
      row.append(del)
    }
    section.append(row)
  }
  return section
}

async function openRun(id: string, fixture?: { run: Run; events: Logged[]; memory?: TeamMemory }) {
  root.replaceChildren(h('div', 'team-run-loading skel'))
  const loaded = fixture ?? await (async () => { const [saved, events] = await Promise.all([window.forge.teamGet(id), window.forge.teamEvents(id)]); if (!saved) throw new Error('This team run no longer exists.'); return { run: saved, events } })()
  run = structuredClone(loaded.run); sharedMemory = fixture?.memory ?? null; undoResult = ''
  const normal = await normaliseTeamEventsAsync(loaded.events); log = normal.log; liveFiles = normal.liveFiles
  if (!['planning', 'running', 'paused', 'interrupted'].includes(run.status)) liveFiles.clear()
  renderRun(); startClock()
  if (!fixture) void refreshMemory()
}

function startClock() { stopClock(); elapsedTimer = setInterval(() => { const el = document.getElementById('team-elapsed'); if (el && run) el.textContent = fmtTime(Math.floor((Date.now() - run.createdAt) / 1000)) }, 1000) }
function stopClock() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null }

function renderRun() {
  if (!run) return
  const scrollTop = root.scrollTop
  const page = h('div', 'team-run')
  page.append(renderRunHeader())
  if ((run.pausedReason || run.status === 'interrupted') && !run.approvals.some(a => a.kind === 'plan' && a.status === 'pending')) page.append(renderPauseBanner())
  const pending = run.approvals.filter(a => a.status === 'pending')
  if (pending.length) page.append(renderApprovals(pending))
  if (run.status === 'awaiting_approval' && run.final) page.append(renderFinal())
  if (run.status === 'done' && run.applied) page.append(renderApplied())
  page.append(renderBoard(), renderStory())
  root.replaceChildren(page); root.scrollTop = scrollTop
}

function renderRunHeader() {
  const header = h('header', 'team-run-header')
  const back = h('button', 'icon-btn'); back.append(icon('arrowright')); back.classList.add('back'); back.title = 'All team runs'; back.onclick = () => void showEntry()
  const identity = h('div', 'team-run-identity'); identity.append(h('div', 'eyebrow', `TEAM RUN · ${folderName(run!.project)}`), h('h1', '', run!.goal))
  const status = h('span', `status-pill ${run!.status}`, statusLabel(run!.status)); status.setAttribute('role', 'status')
  const elapsed = h('span', 'team-elapsed', fmtTime(Math.floor((Date.now() - run!.createdAt) / 1000))); elapsed.id = 'team-elapsed'
  const controls = h('div', 'team-controls')
  const planPending = run!.approvals.some(a => a.kind === 'plan' && a.status === 'pending')
  if (planPending) { /* the plan card starts the team */ }
  else if (['paused', 'interrupted'].includes(run!.status)) controls.append(actionButton('Resume', 'arrowright', () => teamAction(() => window.forge.teamResume(run!.id))))
  else if (['planning', 'running', 'verifying'].includes(run!.status)) controls.append(pauseButton())
  if (isActive(run!.status) && run!.status !== 'awaiting_approval') controls.append(actionButton('Cancel', 'x', () => teamAction(() => window.forge.teamCancel(run!.id)), 'danger'))
  if (run!.final && typeof window.forge.teamExportReport === 'function') controls.append(actionButton('Export report', 'download', () => call(() => window.forge.teamExportReport(run!.id))))
  header.append(back, identity, status, elapsed, controls)
  const usage = h('div', 'team-usage-strip')
  for (const agent of ['claude', 'codex', 'local'] as const) {
    if (agent === 'local' && !run!.usage.local?.runs) continue
    const u = run!.usage[agent] ?? { input: 0, output: 0, cached: 0, costUsd: 0, runs: 0 }, item = h('div', 'team-usage-item')
    item.append(h('span', `agent-orb ${agent}`), h('strong', '', AGENT_NAME[agent]), h('span', '', `${formatTokens(u.input + u.output)} tokens`))
    if (u.costUsd > 0) item.append(h('span', '', `~$${u.costUsd.toFixed(2)}`))
    const limits = run!.limits?.[agent]; if (limits) item.append(h('span', 'limit-meter', `ChatGPT plan: ${Math.round(limits.primaryPct)}% of this window used`))
    usage.append(item)
  }
  header.append(usage)
  const counted = run!.tasks.filter(t => t.status !== 'cancelled'), done = counted.filter(t => t.status === 'done').length
  if (counted.length) {
    const progress = h('div', 'team-progress'); progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', String(counted.length)); progress.setAttribute('aria-valuenow', String(done))
    const bar = h('span', 'team-progress-bar'); const fill = h('i'); fill.style.width = `${Math.round(done / counted.length * 100)}%`; bar.append(fill)
    progress.append(bar, h('span', '', `${done} of ${counted.length} ${counted.length === 1 ? 'task' : 'tasks'} done`)); header.append(progress)
  }
  return header
}

function actionButton(label: string, name: Parameters<typeof icon>[0], runAction: () => void, cls = '') { const button = h('button', `btn ${cls}`); button.append(icon(name, 'sm'), document.createTextNode(label)); button.onclick = runAction; return button }
function pauseButton() {
  const button = actionButton('Pause', 'stop', () => {}, '') as HTMLButtonElement; let timer: ReturnType<typeof setTimeout> | null = null, hard = false
  button.title = 'Click to pause after the current step. Hold for one second to stop agents now.'
  button.onpointerdown = () => { hard = false; timer = setTimeout(() => { hard = true; button.textContent = 'Stopping agents…'; void teamAction(() => window.forge.teamPause(run!.id, true)) }, 900) }
  button.onpointerup = () => { if (timer) clearTimeout(timer); timer = null; if (!hard) void teamAction(() => window.forge.teamPause(run!.id, false)) }
  button.onpointerleave = () => { if (timer) clearTimeout(timer); timer = null }
  button.onclick = e => e.preventDefault(); return button
}
async function teamAction(fn: () => Promise<unknown>) { if (replay) { toast('Replay mode: action recorded'); return } await call(fn); await refreshRun() }
async function refreshRun() { if (!run || replay) return; const fresh = await window.forge.teamGet(run.id); if (fresh) { run = fresh; renderRun() } }

function renderPauseBanner() {
  const banner = h('section', 'team-pause-banner')
  banner.append(icon('info'), h('div', '', run!.pausedReason || 'This run was interrupted when Forge closed. The agents will continue from their saved sessions.'))
  if (run!.status === 'done' || run!.status === 'cancelled') return banner
  if (run!.approvals.some(a => a.kind === 'plan' && a.status === 'pending')) return banner
  const failed = run!.tasks.find(task => task.status === 'failed' || task.status === 'blocked' || task.status === 'interrupted')
  if (run!.status === 'failed' && failed) banner.append(actionButton('Retry failed task', 'arrowright', () => teamAction(() => window.forge.teamRetryTask(run!.id, failed.id)), 'primary'))
  else if (run!.status === 'failed') return banner
  else if (/limit|budget|allowance/i.test(run!.pausedReason ?? '')) banner.append(actionButton('Allow 50% more', 'bolt', () => teamAction(() => window.forge.teamExtendBudget(run!.id)), 'primary'))
  else banner.append(actionButton('Resume team', 'arrowright', () => teamAction(() => window.forge.teamResume(run!.id)), 'primary'))
  return banner
}

function renderApprovals(items: Run['approvals']) {
  const tray = h('section', 'approval-tray'); tray.setAttribute('role', 'alert'); tray.setAttribute('aria-live', 'assertive'); const title = h('div', 'team-section-head'); title.append(h('div', '', 'Waiting for you'), h('span', '', `${items.length} blocking`)); tray.append(title)
  for (const approval of items) {
    if (approval.kind === 'plan') { tray.append(renderPlanReview(approval)); continue }
    const card = h('article', 'team-approval-card'); const copy = h('div', 'approval-copy')
    copy.append(h('span', 'approval-kind', approval.kind.replace('_', ' ')), h('h3', '', approval.title), h('p', '', approval.detail))
    const note = input('text'); note.placeholder = 'Optional note to the team'; note.setAttribute('aria-label', `Note for ${approval.title}`)
    const actions = h('div', 'approval-actions')
    const answer = async (allow: boolean) => { if (replay) { approval.status = allow ? 'allowed' : 'denied'; renderRun(); return } const accepted = await window.forge.teamAnswer(run!.id, approval.id, allow, note.value.trim() || undefined); if (!accepted) toast('The team is no longer waiting on this approval.'); await refreshRun() }
    if (approval.kind === 'budget') actions.append(actionButton('Allow 50% more', 'bolt', () => void teamAction(() => window.forge.teamExtendBudget(run!.id)), 'primary'))
    else actions.append(actionButton(approval.kind === 'review_override' ? 'Merge anyway' : 'Allow', 'check', () => void answer(true), 'primary'))
    actions.append(actionButton(approval.kind === 'review_override' ? 'Keep separate' : 'Deny', 'x', () => void answer(false)))
    card.append(copy, note, actions); tray.append(card)
  }
  return tray
}

function renderPlanReview(approval: Run['approvals'][number]) {
  const card = h('article', 'team-plan-review')
  card.append(h('span', 'approval-kind', 'plan'), h('h3', '', approval.title), h('p', '', approval.detail))
  const rows = run!.tasks.map((task, index) => {
    const row = h('div', 'plan-edit-row'), skipped = task.status === 'cancelled'
    const title = input('text', task.title); title.setAttribute('aria-label', `Task ${index + 1} title`)
    const agent = select([['claude', 'Claude'], ['codex', 'Codex'], ['local', 'Local model']], task.agent); agent.setAttribute('aria-label', `Task ${index + 1} agent`)
    const skip = input('checkbox'); skip.checked = skipped; skip.setAttribute('aria-label', `Skip task ${index + 1}`)
    const skipLabel = h('label', 'plan-skip'); skipLabel.append(skip, document.createTextNode('Skip'))
    const goal = h('p', 'plan-goal', task.goal)
    row.append(h('span', 'task-number', String(index + 1).padStart(2, '0')), title, agent, skipLabel, goal)
    if (task.deps.length) row.append(h('p', 'task-deps', `After ${task.deps.map(id => run!.tasks.find(t => t.id === id)?.title ?? id).join(', ')}`))
    if (task.acceptance.length) { const checks = h('details', 'plan-checks'); checks.append(h('summary', '', `Checks · ${task.acceptance.length}`), ...task.acceptance.map(item => h('p', '', item))); row.append(checks) }
    return { task, title, agent, skip, row }
  })
  const list = h('div', 'plan-edit-list'); for (const r of rows) list.append(r.row)
  const result = h('div', 'team-config-error'); result.setAttribute('role', 'alert')
  const actions = h('div', 'approval-actions')
  const apply = async (start: boolean) => {
    const edits = rows.flatMap(({ task, title, agent, skip }) => {
      const edit: { id: string; title?: string; agent?: 'claude' | 'codex' | 'local'; skip?: boolean } = { id: task.id }
      if (title.value.trim() && title.value.trim() !== task.title) edit.title = title.value.trim()
      if (agent.value !== task.agent) edit.agent = agent.value as 'claude' | 'codex' | 'local'
      if (skip.checked !== (task.status === 'cancelled')) edit.skip = skip.checked
      return Object.keys(edit).length > 1 ? [edit] : []
    })
    if (replay) { toast('Replay mode: plan edits recorded'); if (start) { approval.status = 'allowed'; renderRun() } return }
    if (edits.length) { const done = await window.forge.teamUpdatePlan(run!.id, edits); if (!done.ok) { result.textContent = done.message; return } }
    if (!start) { await refreshRun(); toast('Plan updated'); return }
    const accepted = await window.forge.teamAnswer(run!.id, approval.id, true)
    if (!accepted) toast('The team is no longer waiting on this plan.')
    await refreshRun()
  }
  actions.append(
    actionButton('Start the team', 'check', () => void call(() => apply(true)), 'primary'),
    actionButton('Save edits only', 'sliders', () => void call(() => apply(false))),
    actionButton('Cancel run', 'x', () => void (replay ? toast('Replay mode: action recorded') : call(async () => { await window.forge.teamAnswer(run!.id, approval.id, false); await refreshRun() }))),
  )
  card.append(list, result, actions); return card
}

function renderBoard() {
  const section = h('section', 'team-board-section'); const head = h('div', 'team-section-head'); head.append(h('div', '', 'The plan'), h('span', '', run!.plan.summary || `${run!.tasks.length} tasks`)); section.append(head)
  const board = h('div', 'team-board')
  if (!run!.tasks.length) for (let i = 0; i < 3; i++) board.append(h('div', 'task-card task-skeleton skel'))
  for (const [index, task] of run!.tasks.entries()) board.append(renderTask(task, index))
  section.append(board); return section
}
function renderTask(task: Task, index: number) {
  const card = h('article', `task-card ${task.status}`); card.dataset.task = task.id
  const top = h('div', 'task-top'); top.append(h('span', 'task-number', String(index + 1).padStart(2, '0')), h('span', `agent-badge ${task.agent}`, AGENT_NAME[task.agent]), h('span', `task-state ${task.status}`, task.phase ? `${task.phase} · ${task.status}` : task.status))
  card.append(top, h('h3', '', task.title))
  if (task.deps.length) card.append(h('p', 'task-deps', `After ${task.deps.map(id => run!.tasks.find(t => t.id === id)?.title ?? id).join(', ')}`))
  const facts = h('div', 'task-facts'); if (task.changed.length) facts.append(h('span', '', `${task.changed.length} ${task.changed.length === 1 ? 'file' : 'files'}`)); if (task.fixRounds) facts.append(h('span', '', `${task.fixRounds} fix ${task.fixRounds === 1 ? 'round' : 'rounds'}`))
  const verdict = task.reviews.at(-1); if (verdict) facts.append(h('span', `verdict ${verdict.verdict}`, `Review: ${verdict.verdict}`)); card.append(facts)
  if (task.error) card.append(h('p', 'task-error', task.error))
  if (task.status === 'failed' || task.status === 'blocked' || task.status === 'interrupted') {
    const actions = h('div', 'task-actions'); actions.append(actionButton('Retry', 'arrowright', () => teamAction(() => window.forge.teamRetryTask(run!.id, task.id)), 'primary'), actionButton('Skip', 'x', () => teamAction(() => window.forge.teamSkipTask(run!.id, task.id))))
    card.append(actions)
  }
  if (task.changed.length || task.diff) card.onclick = e => { if (!(e.target as HTMLElement).closest('button')) void openDiff(task.id) }
  return card
}

function renderStory() {
  const area = h('section', 'team-story')
  const lanes = h('div', 'team-lanes'); const used = (a: 'claude' | 'codex' | 'local') => run!.tasks.some(t => t.agent === a) || log.some(x => x.ev.type === 'agent' && x.ev.ev.agent === a); for (const a of ['claude', 'codex', 'local'] as const) if (used(a)) lanes.append(renderLane(a)); if (!lanes.children.length) lanes.append(renderLane('claude'))
  const side = h('aside', 'team-side-story'); side.append(renderLiveFiles(), renderFeed(), renderMemory(), renderVerify(), renderSteer(), renderDiffPanel())
  area.append(lanes, side); return area
}
function renderLane(agent: 'claude' | 'codex' | 'local') {
  const lane = h('section', `agent-lane ${agent}`); const header = h('header'); header.append(h('span', `agent-orb ${agent}`), h('div', '', AGENT_FULL[agent]), h('span', 'lane-live', ['planning', 'running', 'verifying'].includes(run!.status) ? 'LIVE' : 'HISTORY')); const detailsToggle = h('button', `lane-details ${laneDetails ? 'on' : ''}`, 'Details'); detailsToggle.title = 'Show commands, step results, prompts and reasoning'; detailsToggle.setAttribute('aria-pressed', String(laneDetails)); detailsToggle.onclick = () => { laneDetails = !laneDetails; try { localStorage.setItem('forge.teamLaneDetails', laneDetails ? '1' : '0') } catch {} document.querySelectorAll<HTMLElement>('.agent-lane').forEach(old => { const a = (['claude', 'codex', 'local'] as const).find(n => old.classList.contains(n)); if (a) old.replaceWith(renderLane(a)) }) }; header.append(detailsToggle); lane.append(header)
  const events = log.filter(x => x.ev.type === 'agent' && x.ev.ev.agent === agent && laneVisible(x.ev))
  const body = h('div', 'lane-body')
  if (!events.length) body.append(h('p', 'team-empty', run!.tasks.some(t => t.agent === agent) ? 'Waiting for the first message…' : 'Waiting for a task…'))
  let lastKey = ''
  for (const { t, ev } of events.slice(-40)) if (ev.type === 'agent') {
    const row = h('article', `activity-row ${ev.ev.type}`); const task = run!.tasks.find(x => x.id === ev.taskId)
    const key = `${ev.taskId}:${ev.phase}`
    if (key !== lastKey) { lastKey = key; const divider = h('div', 'lane-divider'); divider.append(h('strong', '', task?.title ?? ev.taskId), h('span', '', `${PHASE_LABEL[ev.phase] ?? ev.phase} · ${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)); body.append(divider) }
    row.title = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const event = ev.ev
    if (event.type === 'text') row.append(h('p', '', event.text))
    else if (event.type === 'delta') {
      if (event.channel === 'thinking') {
        const thought = h('details', 'agent-thinking')
        thought.append(h('summary', '', 'Thinking'), h('p', '', event.text)); row.append(thought)
      } else if (event.channel === 'output') {
        const output = h('details', 'agent-output') as HTMLDetailsElement; output.open = true
        output.append(h('summary', '', 'Live command output'), h('pre', '', event.text.slice(-12000))); row.append(output)
      } else {
        const typing = h('p', 'agent-typing', event.text); typing.append(h('span', 'typing-cursor', '')); row.append(typing)
      }
    }
    else if (event.type === 'code') row.append(renderLiveCode(event))
    else if (event.type === 'prompt') {
      const prompt = h('details', 'agent-prompt')
      prompt.append(h('summary', '', 'What this agent was told'), h('pre', '', event.text)); row.append(prompt)
    }
    else if (event.type === 'tool') row.append(h('div', `activity-tool ${event.kind}`, `${event.kind === 'command' ? 'Running' : event.kind === 'edit' ? 'Changing' : event.kind === 'read' ? 'Reading' : 'Working'} · ${event.summary}`))
    else if (event.type === 'tool_result') { const details = h('details', `activity-result ${event.ok ? 'ok' : 'bad'}`); details.append(h('summary', '', event.ok ? 'Step finished' : 'Step failed'), h('pre', '', event.text.slice(0, 5000))); row.append(details) }
    else if (event.type === 'note') row.append(h('p', 'activity-note', event.text))
    else if (event.type === 'error') row.append(h('p', 'task-error', event.message))
    else if (event.type === 'done') row.append(h('p', event.ok ? 'activity-done' : 'task-error', event.text))
    else if (event.type === 'limits') row.append(h('p', 'activity-note', `Plan usage: ${Math.round(event.primaryPct)}%`))
    body.append(row)
  }
  lane.append(body); return lane
}

function renderLiveCode(event: Extract<RunEvent, { type: 'agent' }>['ev'] & { type: 'code' }) {
  const card = h('section', `live-code ${event.kind} ${event.done ? 'done' : 'writing'}`)
  const head = h('div', 'live-code-head')
  head.append(h('span', 'tool-path', event.path), h('span', 'live-code-state', event.done ? 'Saved' : 'Writing…'))
  const pre = h('pre', `live-code-body ${event.kind}`)
  if (event.kind === 'diff') {
    for (const line of event.text.slice(-30000).split('\n')) {
      const part = h('span', line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : '', line + '\n')
      pre.append(part)
    }
  } else {
    const code = h('code', '', event.text.slice(-30000)); pre.append(code)
    const marker = `${event.id}:${event.text.length}`; code.dataset.liveCode = marker
    void import('./teamDiff').then(({ colorizeTeamCode }) => colorizeTeamCode(event.text.slice(-30000), event.path)).then(html => { if (code.isConnected && code.dataset.liveCode === marker) code.innerHTML = html }).catch(() => {})
  }
  card.append(head, pre); return card
}

function renderFeed() {
  const section = h('section', 'team-feed'); const head = h('div', 'team-section-head'); head.append(h('div', '', 'Team feed'), h('span', '', `${run!.messages.length}`)); section.append(head)
  if (!run!.messages.length) section.append(h('p', 'team-empty', 'Handoffs, reviews and decisions appear here.'))
  for (const msg of run!.messages.slice(-12)) { const item = h('article', `feed-item ${msg.kind}`); const top = h('div'); top.append(h('strong', '', msg.from === 'user' ? 'You' : msg.from === 'orchestrator' ? 'Forge' : AGENT_NAME[msg.from]), h('span', '', msg.kind.replace('_', ' '))); const body = h('p', 'feed-body', msg.body); item.append(top, body); if (msg.body.length > 260) { item.classList.add('clamped'); item.title = 'Click to read all'; item.onclick = () => item.classList.toggle('clamped') } section.append(item) }
  return section
}

function renderLiveFiles() {
  const section = h('section', 'team-live-files')
  const count = [...liveFiles.values()].reduce((total, files) => total + files.length, 0)
  const head = h('div', 'team-section-head'); head.append(h('div', '', 'Files changing now'), h('span', '', count ? `${count} live` : 'Quiet')); section.append(head)
  if (!count) { section.append(h('p', 'team-empty', 'Files appear here while an agent is writing them.')); return section }
  for (const [taskId, files] of liveFiles) {
    const group = h('div', 'live-file-group'); const task = run!.tasks.find(item => item.id === taskId)
    group.append(h('div', 'live-file-task', task?.title ?? taskId))
    for (const file of files) {
      const button = h('button', 'live-file-row')
      button.append(h('span', `file-status ${file.status}`, file.status), h('span', 'tool-path', file.path), h('span', 'team-diff-count', `+${file.added} −${file.removed}`))
      button.onclick = () => void openDiff(taskId, file.path, true); group.append(button)
    }
    section.append(group)
  }
  return section
}

function renderMemory() {
  const section = h('section', 'team-memory')
  const head = h('div', 'team-section-head'); head.append(h('div', '', 'Shared memory'), h('span', '', memoryLoading ? 'Refreshing…' : sharedMemory ? 'Current' : 'Waiting')); section.append(head)
  if (!sharedMemory) { section.append(h('p', 'team-empty', 'Decisions, handoffs, problems and useful project history appear here.')); return section }
  const addGroup = (title: string, items: HTMLElement[], open = false) => {
    if (!items.length) return
    const details = h('details', 'memory-group') as HTMLDetailsElement; details.open = open
    details.append(h('summary', '', `${title} · ${items.length}`), ...items); section.append(details)
  }
  addGroup('Decisions', sharedMemory.decisions.map(item => memoryItem(item.text, item.by)), true)
  addGroup('Handoffs', sharedMemory.handoffs.map(item => memoryItem(item.handoff, `${item.agent} · ${item.title}`)), true)
  addGroup('Messages', sharedMemory.messages.slice(-12).map(item => memoryItem(item.body, `${item.from} → ${item.to}`)))
  addGroup('Problems met', sharedMemory.errors.map(item => memoryItem(item.fix ? `${item.text} Fix: ${item.fix}` : item.text, item.signature)))
  const projectItems = [
    ...sharedMemory.project.decisions.map(item => memoryItem(item.text, `Earlier decision · ${item.by}`)),
    ...sharedMemory.project.errors.map(item => memoryItem(item.fix ? `${item.text} Fix: ${item.fix}` : item.text, 'Earlier problem')),
    ...Object.entries(sharedMemory.project.stats).map(([role, stat]) => memoryItem(`${stat.ok} successful · ${stat.fail} failed`, role.replace(':', ' · '))),
  ]
  addGroup('From earlier runs', projectItems)
  return section
}

function memoryItem(text: string, meta: string) { const item = h('div', 'memory-item'); item.append(h('span', '', meta), h('p', '', text)); return item }

async function refreshMemory() {
  if (!run || replay || typeof window.forge.teamMemory !== 'function') return
  const id = run.id; memoryLoading = true
  try { const next = await window.forge.teamMemory(id); if (run?.id === id) sharedMemory = next }
  catch { /* The run remains usable when memory refresh fails. */ }
  finally { if (run?.id === id) { memoryLoading = false; renderRun() } }
}

function scheduleMemoryRefresh() {
  if (memoryTimer) clearTimeout(memoryTimer)
  memoryTimer = setTimeout(() => void refreshMemory(), 180)
}
function renderVerify() {
  const events = log.filter(x => x.ev.type === 'verify')
  const section = h('section', 'team-verify'); const head = h('div', 'team-section-head'); head.append(h('div', '', 'Project checks'), h('span', '', events.length ? `${events.length}` : 'Waiting')); section.append(head)
  for (const item of events.slice(-3)) if (item.ev.type === 'verify') { const details = h('details', `verify-card ${item.ev.ok ? 'ok' : 'bad'}`) as HTMLDetailsElement; details.open = !item.ev.ok; details.append(h('summary', '', `${item.ev.ok ? 'Passed' : 'Failed'} · ${item.ev.command}`), h('pre', '', item.ev.output.slice(-8000))); section.append(details) }
  return section
}
function renderSteer() {
  const form = h('form', 'team-steer'); const label = h('label', '', 'Tell the team'); const row = h('div')
  const text = input('text', steerDraft); text.placeholder = 'Add context or change direction…'; text.setAttribute('aria-label', 'Tell the team'); text.oninput = () => { steerDraft = text.value }
  const to = select([['all', 'Everyone'], ['claude', 'Claude'], ['codex', 'Codex'], ['local', 'Local model']], steerTarget); to.setAttribute('aria-label', 'Send to'); to.onchange = () => { steerTarget = to.value as typeof steerTarget }
  const send = h('button', 'icon-btn'); send.append(icon('arrowup')); send.setAttribute('aria-label', 'Send to team')
  row.append(text, to, send); form.append(label, row)
  form.onsubmit = e => { e.preventDefault(); const value = text.value.trim(); if (!value) return; if (replay) { run!.messages.push({ id: crypto.randomUUID(), from: 'user', to: steerTarget, kind: 'steer', body: value, at: Date.now(), readBy: [] }); steerDraft = ''; renderRun() } else void call(async () => { await window.forge.teamSteer(run!.id, value, steerTarget); steerDraft = ''; await refreshRun() }) }
  return form
}
function renderDiffPanel() {
  const section = h('section', 'team-diff-panel')
  const changed = run!.tasks.flatMap(task => task.changed.map(file => ({ task, file })))
  const head = h('div', 'team-section-head'); head.append(h('div', '', 'Changes'), h('span', '', `${changed.length} files`)); section.append(head)
  if (changed.length) {
    const files = h('div', 'team-diff-files')
    for (const { task, file } of changed.slice(0, 12)) {
      const row = h('button', 'team-diff-file')
      row.append(h('span', `file-status ${file.status}`, file.status), h('span', 'tool-path', file.path), h('span', 'team-diff-count', `+${file.added} −${file.removed}`))
      row.onclick = () => void openDiff(task.id); files.append(row)
    }
    section.append(files)
  }
  const button = h('button', 'btn', 'Review all changes'); button.onclick = () => void openDiff()
  section.append(button, h('div', 'team-diff-host')); return section
}
async function openDiff(taskId?: string, path?: string, live = false) {
  const host = document.querySelector<HTMLElement>('.team-diff-host'); if (!host || !run) return
  host.classList.add('open'); host.replaceChildren(h('div', 'team-diff-loading skel')); host.scrollIntoView({ behavior: 'smooth', block: 'center' })
  try { const diff = replay ? `diff --git a/${path ?? 'src/team.ts'} b/${path ?? 'src/team.ts'}\n--- a/${path ?? 'src/team.ts'}\n+++ b/${path ?? 'src/team.ts'}\n@@ -1,2 +1,3 @@\n export const team = true\n+export const calm = true` : live && taskId && typeof window.forge.teamLiveDiff === 'function' ? await window.forge.teamLiveDiff(run.id, taskId, path) : await window.forge.teamDiff(run.id, taskId); const { mountTeamDiff } = await import('./teamDiff'); host.replaceChildren(); await mountTeamDiff(host, diff || 'No changes are available yet.') }
  catch (e) { host.replaceChildren(h('div', 'errcard', cleanErr(e))) }
}

function renderFinal() {
  const section = h('section', 'team-final')
  section.append(h('div', 'eyebrow', 'THE TEAM IS FINISHED'), h('h2', '', 'Review the result before it reaches your project.'))
  const report = h('div', 'team-final-report'); report.innerHTML = md(run!.final!.report); section.append(report)
  const files = h('div', 'team-final-files'); for (const file of run!.final!.files) files.append(h('div', '', `${file.status === 'added' ? 'New' : file.status === 'deleted' ? 'Removed' : 'Updated'} · ${file.path}`)); section.append(files)
  const verify = h('div', `final-verify ${run!.final!.verifyOk ? 'ok' : run!.final!.verifyOk === false ? 'bad' : ''}`); verify.append(icon(run!.final!.verifyOk ? 'check' : 'info'), h('span', '', run!.final!.verifyOk ? 'Project check passed' : run!.final!.verifyOk === false ? 'Project check failed' : 'No project check configured')); section.append(verify)
  if (run!.final!.reviewNotes.length) { const notes = h('details', 'final-review-notes'); notes.append(h('summary', '', `Final review notes · ${run!.final!.reviewNotes.length}`), ...run!.final!.reviewNotes.map(item => h('p', '', item))); section.append(notes) }
  if (undoResult) section.append(h('div', 'errcard final-action-result', undoResult))
  const note = h('p', 'team-final-note', 'Nothing has changed in your project yet. If you don’t apply this result, Forge keeps a saved Team copy that you can reopen later.'); section.append(note)
  const actions = h('div', 'team-final-actions')
  const apply = actionButton('Apply to my project', 'check', async () => { if (replay) { if (replayScenario === 'applyfail') { undoResult = 'Could not apply: your project changed while the team was working. Review the project and try again.'; renderRun(); return } run!.status = 'done'; run!.applied = true; run!.appliedCheckpoint = 'replay-checkpoint'; toast('Applied · Undo is ready'); renderRun(); return } await call(async () => { const result = await window.forge.teamApply(run!.id); if (!result.ok) { undoResult = result.message; renderRun(); return } toast(result.checkpoint ? `${result.message} · Undo is ready` : result.message, 5000); await refreshRun() }) }, 'primary')
  const reject = actionButton("Don't apply", 'x', () => { if (replay) { run!.status = 'done'; run!.applied = false; toast('Not applied · Forge kept a saved Team copy'); renderRun(); return } void teamAction(() => window.forge.teamReject(run!.id)) })
  actions.append(apply, reject); section.append(actions); return section
}

function renderApplied() {
  const section = h('section', `team-applied ${run!.undone ? 'undone' : ''}`)
  section.append(h('div', 'eyebrow', run!.undone ? 'CHANGES UNDONE' : 'APPLIED TO YOUR PROJECT'), h('h2', '', run!.undone ? 'Your project is back where it was.' : 'The team’s work is now in your project.'))
  const copy = run!.undone ? 'The applied files were restored to their pre-Team versions.' : 'You can keep working, or undo the entire apply. Undo also removes hand edits made after the apply.'
  section.append(h('p', '', copy))
  if (undoResult) section.append(h('div', 'team-undo-result', undoResult))
  if (!run!.undone && run!.appliedCheckpoint && typeof window.forge.teamUndo === 'function') section.append(actionButton('Undo applied changes', 'arrowright', () => void undoApplied()))
  return section
}

async function undoApplied() {
  if (!run) return
  const confirmed = window.confirm('Undo this Team apply? Every file the apply changed will go back to how it was before. Hand edits made to those files after the apply will also be undone.')
  if (!confirmed) return
  if (replay) { run.undone = true; undoResult = 'Restored 2 files. Later hand edits in those files were also removed.'; renderRun(); return }
  await call(async () => {
    const result = await window.forge.teamUndo(run!.id)
    undoResult = result.ok ? `${result.message}${result.paths.length ? ` · ${result.paths.length} files restored` : ''}` : result.message
    await refreshRun()
  })
}

function reduceEvent(event: RunEvent, t = Date.now()) {
  if (!run || event.runId !== run.id) return
  const state = reduceTeamView({ run, log, liveFiles }, event, t); run = state.run; log = state.log; liveFiles = state.liveFiles
  if (event.type === 'task' || event.type === 'message') scheduleMemoryRefresh()
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    if (event.type === 'agent') { const old = document.querySelector(`.agent-lane.${event.ev.agent}`); const body = old?.querySelector<HTMLElement>('.lane-body'); const top = body?.scrollTop ?? 0; const follow = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 36 : true; if (!old) { renderRun(); return } const next = renderLane(event.ev.agent); old.replaceWith(next); const nextBody = next.querySelector<HTMLElement>('.lane-body'); if (nextBody) nextBody.scrollTop = follow ? nextBody.scrollHeight : top }
    else if (event.type === 'live') { const old = document.querySelector('.team-live-files'); old?.replaceWith(renderLiveFiles()) }
    else renderRun()
  }, event.type === 'agent' || event.type === 'live' ? 80 : 0)
}

export function initTeam(options: { project: () => string | null }) {
  currentProject = options.project() ?? ''
  const enabled = apiReady(); $('mode-team').hidden = !enabled; $('team-nav').hidden = !enabled
  $('mode-team').onclick = () => showTeam(); $('team-nav').onclick = () => showTeam(); $('team-back').onclick = showChat; $('mode-chat').onclick = showChat
  $('team-hist-toggle').onclick = () => $('app').classList.toggle('no-hist')
  if (typeof window.forge.onTeamEvent === 'function') window.forge.onTeamEvent(reduceEvent)
  if (typeof window.forge.onTeamFocus === 'function') window.forge.onTeamFocus(id => { showTeam(false); void openRun(id).catch(e => toast(cleanErr(e), 5000)) })
  window.addEventListener('forge-project', (e) => { currentProject = (e as CustomEvent<string | null>).detail ?? '' })
  if (localStorage.getItem('forge.teamReplay') === 'open') { localStorage.setItem('forge.teamReplay', '1'); showTeam() }
}

export function setTeamProject(project: string | null) { currentProject = project ?? ''; window.dispatchEvent(new CustomEvent('forge-project', { detail: project })) }
