import type { Run, RunEvent, Task, TeamConfig } from '../main/team/types'
import type { RunSummary, TeamMemory } from '../main/team/service'
import { md, folderName, formatTokens, timeAgo } from './format'
import { fileIcon, icon, type IconName } from './icons'
import { $, cleanErr, emo, h, toast } from './ui'
import { replayRun } from './teamReplay'
import { enabledSkillCount } from './skillsPanel'
import { historyButton } from './projectHistory'
import { AGENT_FULL, AGENT_NAME, N } from './names'
import { RUN_GLYPH, STEP_GLYPH, TASK_GLYPH, TOOL_GLYPH } from './glyphs'
import { buildStage, pushCode, type StageCode } from './teamStage'
import { attachmentStrip, kindOf, readBase64, sentChips } from './attachments'
import type { TeamAttachment } from '../main/team/attach'
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
let runSearchOpen = false
let runSort = 'opened'
let runView: 'list' | 'grid' = (() => { try { return localStorage.getItem('forge.teamRunView') === 'grid' ? 'grid' : 'list' } catch { return 'list' } })()
let steerDraft = ''
const questionDrafts = new Map<string, { picked: number[]; other: string }>() // a live redraw must not lose a half-made answer
let steerTarget: 'all' | 'claude' | 'codex' | 'local' = 'all'
let laneDetails = (() => { try { return localStorage.getItem('forge.teamLaneDetails') === '1' } catch { return false } })()
// The lanes show the code each agent is writing, live. Planning output, talk, commands, step results, prompts and reasoning sit behind "Details".
const laneVisible = (ev: RunEvent & { type: 'agent' }) => { const e = ev.ev; return laneDetails || (ev.phase !== 'plan' && (e.type === 'code' || e.type === 'error' || (e.type === 'done' && !e.ok))) }
const PHASE_LABEL: Record<string, string> = { work: 'Working', review: 'Reviewing', fix: 'Fixing', merge: 'Merging', conflict: 'Resolving a conflict', plan: 'Planning', 'final-review': 'Final review' }

const apiReady = () => typeof window.forge.teamStart === 'function'
const fmtTime = (seconds: number) => seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
const statusLabel = (status: Run['status']) => ({ planning: 'Planning', running: 'Working', paused: 'Paused', verifying: 'Checking', awaiting_approval: 'Ready for you', done: 'Finished', failed: 'Needs attention', cancelled: 'Cancelled', interrupted: 'Interrupted' })[status]
// A status as an emoji plus its word; `iconOnly` keeps the word for screen readers and the tooltip.
function statusTag(status: Run['status'], iconOnly = false) {
  const tag = h('span', `status-pill ${status}${iconOnly ? ' icon-only' : ''}`)
  tag.append(emo(RUN_GLYPH[status]))
  if (iconOnly) { tag.title = statusLabel(status); tag.setAttribute('aria-label', statusLabel(status)); tag.setAttribute('role', 'img') } else tag.append(statusLabel(status))
  return tag
}
// Section heading: a short title on the left, a quiet count on the right.
function sectionHead(title: string, meta: string) { const head = h('div', 'team-section-head'); head.append(h('div', '', title), h('span', '', meta)); return head }
const fileStatus = (status: string) => { const s = h('span', `file-status ${status}`); s.append(fileIcon(status)); s.title = status; return s }
const seenCards = new Set<string>() // cards and run rows animate in once, not on every live redraw
const enter = (el: HTMLElement, key: string, index: number) => { if (seenCards.has(key)) return; seenCards.add(key); el.classList.add('enter'); el.style.setProperty('--i', String(Math.min(index, 12))) }
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

// Finds the project the request is about: matches what the user typed to the project folders on this computer, and lists them all on request.
function folderFinder(goal: HTMLTextAreaElement, pill: HTMLButtonElement) {
  const box = h('section', 'team-folder'); box.setAttribute('aria-label', 'Project folder')
  const row = h('div', 'team-folder-row'); const hint = h('div', 'team-folder-hint'); const chips = h('div', 'team-folder-chips')
  const scan = h('button', 'link-btn team-folder-scan') as HTMLButtonElement; scan.type = 'button'; scan.append(icon('search', 'sm'), document.createTextNode('Find folder')); scan.title = 'Scan this computer for project folders'
  const skills = h('button', 'skill-chip team-skills') as HTMLButtonElement; skills.type = 'button'; skills.title = 'Skills the crew can read: open Settings → Skills'; skills.hidden = true
  skills.onclick = () => void import('./settings').then(m => m.openSettings('skills'))
  void enabledSkillCount().then(n => { if (n === null) return; skills.hidden = false; skills.replaceChildren(icon('spark', 'sm'), document.createTextNode(`Skills · ${n} on`)) })
  row.append(hint, skills, scan); box.append(row, chips)
  const panel = h('div', 'team-folder-panel'); panel.hidden = true
  const filter = input('search'); filter.placeholder = 'Filter folders'; filter.setAttribute('aria-label', 'Filter folders')
  const list = h('div', 'team-folder-list'); panel.append(filter, list); box.append(panel)
  const apiOk = typeof window.forge.suggestProjects === 'function' && !replay
  const home = (p: string) => p.replace(/^\/home\/[^/]+/, '~')
  const mark = () => { hint.replaceChildren(icon('folder', 'sm'), document.createTextNode(currentProject ? `Working in ${home(currentProject)}` : 'No folder chosen yet. Describe the job, or find a folder.')) }
  const choose = async (path: string) => {
    try { const root = await window.forge.setProject(path); currentProject = root; window.dispatchEvent(new CustomEvent('forge-project-picked', { detail: root })); pill.replaceChildren(icon('folder', 'sm'), document.createTextNode(folderName(root))); pill.title = root; mark(); chips.replaceChildren(); panel.hidden = true; toast(`Using ${folderName(root)}`) }
    catch (e) { toast(cleanErr(e), 4000) }
  }
  const item = (hit: { path: string; name: string; markers: string[]; mtime: number }, cls = 'team-folder-chip') => {
    const b = h('button', cls) as HTMLButtonElement; b.type = 'button'; b.title = hit.path; b.append(icon('folder', 'sm'), h('strong', '', hit.name), h('span', '', home(hit.path.slice(0, hit.path.length - hit.name.length - 1)))); if (hit.path === currentProject) b.classList.add('on')
    b.onclick = () => void choose(hit.path); return b
  }
  let timer: ReturnType<typeof setTimeout> | null = null, token = 0
  const suggest = () => { if (!apiOk) return; const mine = ++token, q = goal.value.trim(); if (q.length < 4) { chips.replaceChildren(); return }
    void window.forge.suggestProjects(q).then(hits => { if (mine !== token) return; chips.replaceChildren(...(hits[0]?.path === currentProject ? [] : hits.filter(x => x.path !== currentProject).slice(0, 4).map(x => item(x)))) }).catch(() => {}) }
  goal.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(suggest, 350) })
  let all: { path: string; name: string; markers: string[]; mtime: number }[] = []
  const draw = () => { const q = filter.value.trim().toLowerCase(); const shown = all.filter(x => !q || x.path.toLowerCase().includes(q)).slice(0, 60); list.replaceChildren(...(shown.length ? shown.map(x => item(x, 'team-folder-row-item')) : [h('p', 'team-empty', all.length ? 'No folder matches.' : 'No project folders found.')])) }
  filter.oninput = draw
  scan.onclick = async () => {
    if (!apiOk) return
    panel.hidden = !panel.hidden; if (panel.hidden) return
    list.replaceChildren(h('p', 'team-empty', 'Scanning your computer…')); scan.disabled = true
    try { all = await window.forge.scanProjects(true); draw(); filter.focus() } catch (e) { list.replaceChildren(h('p', 'team-empty', cleanErr(e))) } finally { scan.disabled = false }
  }
  if (!apiOk) scan.hidden = true
  mark(); suggest()
  return box
}

async function showEntry() {
  run = null; log = []; liveFiles.clear(); sharedMemory = null; undoResult = ''; stopClock()
  root.replaceChildren(h('div', 'team-entry-skeleton skel'))
  if (!apiReady()) {
    const unavailable = h('section', 'team-entry')
    unavailable.append(emptyState('users', `${N.crew} is coming together`, 'This build does not include the crew service yet. Update Forge to use Claude Code and Codex together.'))
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
    failure.append(emptyState('info', `${N.crew} could not open.`, cleanErr(loadError), ['Try again', () => void showEntry()]))
    root.replaceChildren(failure); return
  }
  const [health, list, defaults] = loaded
  summaries = list
  const page = h('div', 'team-entry')
  const intro = h('section', 'team-intro')
  intro.append(h('h1', '', 'Build with a crew: a second set of eyes.'), h('p', 'team-lede', 'Claude Code, Codex and a local model split the work, review each other and bring back one checked result. Nothing touches your project until you land it.'))
  const form = h('form', 'team-start-card')
  const goal = document.createElement('textarea'); goal.rows = 4; goal.placeholder = 'Describe what the crew should build'; goal.setAttribute('aria-label', 'Crew goal')
  // Files go to Forge as soon as they are added, so the run only carries their stored locations.
  const att = attachmentStrip({
    host: form, textarea: goal, max: 12, maxBytes: 200 * 1024 * 1024, limits: 'Up to 12 files per run, 200 MB each.',
    note: 'Agents get the file locations and look at pictures and video frames themselves.',
    upload: async (file, progress) => {
      if (replay) return { id: String(file.size), name: file.name, size: file.size, path: `/tmp/forge-replay/${file.name}`, kind: kindOf(file), frames: kindOf(file) === 'video' ? ['/tmp/forge-replay/f1.jpg'] : undefined }
      const data = await readBase64(file, progress); progress(1)
      const [a] = await window.forge.teamAttach([{ name: file.name, data }])
      if (!a) throw new Error(`Forge did not keep ${file.name}.`)
      return a
    },
    onChange: () => { start.disabled = !ready.length || att.busy(); start.title = att.busy() ? 'Waiting for the files to finish uploading' : '' },
  })
  const project = h('button', 'pill team-project') as HTMLButtonElement; project.type = 'button'; project.append(icon('folder', 'sm'), document.createTextNode(currentProject ? folderName(currentProject) : 'Choose folder')); project.title = currentProject || 'Choose the project folder'
  project.onclick = () => $('project').click()
  const advanced = h('details', 'team-advanced') as HTMLDetailsElement
  const summary = h('summary'); summary.append(icon('sliders', 'sm'), document.createTextNode(N.moreOptions))
  const planner = select([['auto', 'Choose for me'], ['claude', 'Claude'], ['codex', 'Codex'], ['local', AGENT_NAME.local]], defaults.planner ?? 'auto')
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
  const claudeModels: [string, string][] = [['', 'Default'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1']]
  if (defaults.claudeModel && !claudeModels.some(([v]) => v === defaults.claudeModel)) claudeModels.push([defaults.claudeModel, defaults.claudeModel])
  const claudeModel = select(claudeModels, defaults.claudeModel ?? ''); claudeModel.setAttribute('aria-label', 'Claude model')
  const codexEffort = select([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']], defaults.codexEffort ?? 'high'); codexEffort.setAttribute('aria-label', 'Codex reasoning effort')
  const effort = select([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Maximum']], defaults.claudeEffort ?? 'high')
  const minutes = input('number', ''); minutes.min = '1'; minutes.placeholder = 'No limit'
  const tokens = input('number', ''); tokens.min = '1000'; tokens.step = '1000'; tokens.placeholder = 'No limit'
  const runs = input('number', ''); runs.min = '1'; runs.placeholder = 'No limit'
  const maxTasks = input('number', String(defaults.budget?.maxTasks ?? 12)); maxTasks.min = '1'; maxTasks.max = '30'
  const limit = input('number', String(defaults.maxLimitPercent ?? 0)); limit.min = '0'; limit.max = '100'
  const ask = select([['ask', 'Ask me when unsure'], ['never', 'Never ask me']], defaults.askQuestions === false ? 'never' : 'ask'); ask.setAttribute('aria-label', 'Questions')
  const web = select([['on', 'On'], ['off', 'Off']], defaults.webResearch === false ? 'off' : 'on'); web.setAttribute('aria-label', 'Web research')
  const webRow = h('label', 'team-ask'); webRow.append(h('span', '', 'Web research'), web, h('small', '', 'Agents may search the web and read pages for docs, APIs and versions.'))
  const askRow = h('label', 'team-ask'); askRow.append(h('span', '', 'Questions'), ask, h('small', '', 'Agents can stop and ask you when they are really unsure.'))
  const grid = h('div', 'team-config-grid')
  grid.append(field('Planner', planner, 'Chooses who splits the goal into tasks.'), field('Parallel tasks per agent', parallel, 'More tasks can finish sooner, but use more allowance.'), field('Task review', review, `Work by ${AGENT_NAME.local} is always checked by another agent.`), field('Final review', finalReview, 'Automatic checks the whole result only for runs of 3 or more tasks, which saves plan usage.'), field('Permissions', permissions, 'Bypass lets the agents run commands and read files without asking. They still cannot push to git, use sudo, or write outside their own task folder.'), field('Plan approval', reviewPlan, 'Stops after planning so you can edit, reassign or skip tasks before any agent works.'), field('Fix attempts per task', fixRounds), field('Project check', verify, 'Leave blank to detect it from the project.'), field('Codex connection', codexMode, 'Live sessions support streaming and immediate steering.'), field('Time limit (minutes)', minutes, 'Empty means no limit.'), field('Token limit', tokens, 'Empty means no limit.'), field('Agent runs limit', runs, 'Empty means no limit.'), field('Maximum tasks', maxTasks), field('Pause at plan usage %', limit, '0 disables this limit.'))
  const validation = h('div', 'team-config-error'); validation.setAttribute('role', 'alert')
  const numeric = [parallel, fixRounds, minutes, tokens, runs, maxTasks, limit]
  const readConfig = (): Partial<TeamConfig> | null => {
    if (numeric.some(item => !item.checkValidity() || !Number.isFinite(Number(item.value)))) { validation.textContent = 'Check the highlighted crew settings.'; numeric.find(item => !item.checkValidity())?.focus(); return null }
    validation.textContent = ''
    return { askQuestions: ask.value === 'ask', webResearch: web.value === 'on', planner: planner.value as TeamConfig['planner'], maxParallelPerAgent: Number(parallel.value), review: review.value as TeamConfig['review'], finalReview: finalReview.value === 'auto' ? 'auto' : finalReview.value === 'true', reviewPlan: reviewPlan.value === 'true', bypassPermissions: permissions.value === 'bypass', maxFixRounds: Number(fixRounds.value), codexMode: codexMode.value as TeamConfig['codexMode'], verify: verify.value.trim() || undefined, codexModel: codexModel.value, localModel: localModel.value || undefined, claudeModel: claudeModel.value.trim() || undefined, claudeEffort: effort.value as TeamConfig['claudeEffort'], codexEffort: codexEffort.value as TeamConfig['codexEffort'], maxLimitPercent: Number(limit.value), budget: { maxMinutes: Number(minutes.value) || undefined, maxTokens: Number(tokens.value) || undefined, maxAgentRuns: Number(runs.value) || undefined, maxTasks: Number(maxTasks.value) } }
  }
  const reset = h('button', 'btn', 'Reset defaults') as HTMLButtonElement; reset.type = 'button'; reset.onclick = () => { ask.value = 'ask'; web.value = 'on'; planner.value = 'auto'; parallel.value = '2'; review.value = 'cross'; finalReview.value = 'auto'; reviewPlan.value = 'false'; permissions.value = 'bypass'; fixRounds.value = '3'; verify.value = ''; codexMode.value = 'app-server'; claudeModel.value = ''; effort.value = 'high'; codexEffort.value = 'high'; minutes.value = ''; tokens.value = ''; runs.value = ''; maxTasks.value = '12'; limit.value = '0'; validation.textContent = 'Defaults restored. They will save when you start a run.' }
  const saveDefaults = h('button', 'btn', 'Save defaults') as HTMLButtonElement; saveDefaults.type = 'button'; saveDefaults.onclick = () => void call(async () => { const config = readConfig(); if (!config || typeof window.forge.teamSettingsSet !== 'function') return; await window.forge.teamSettingsSet(config); validation.textContent = 'Crew defaults saved for this project.' })
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
  const startLabel = ready.length ? (ready.length > 1 ? N.sendCrew : `Send ${AGENT_NAME[ready[0].agent]}`) : 'No agent is ready'
  const start = h('button', 'btn primary team-start', startLabel) as HTMLButtonElement
  start.disabled = !ready.length
  const diagnostics = h('button', 'icon-btn') as HTMLButtonElement; diagnostics.type = 'button'; diagnostics.append(icon('info')); diagnostics.setAttribute('aria-label', 'Copy diagnostics'); diagnostics.title = 'Copy diagnostics: versions, agent status and recent runs for a bug report. No secrets or file contents.'
  diagnostics.onclick = () => void call(async () => { const text = replay ? 'Forge replay diagnostics' : await window.forge.teamDiagnostics(); await navigator.clipboard.writeText(text); toast('Diagnostics copied') })
  const actions = h('div', 'team-start-actions'); actions.append(project, att.button, att.input, diagnostics, historyButton(), h('span', 'grow'), start)
  const agentsBox = h('section', 'team-agents'); agentsBox.setAttribute('aria-label', 'Models and effort')
  const agentCard = (agent: 'claude' | 'codex' | 'local', model: HTMLSelectElement, effortSel?: HTMLSelectElement) => {
    const card = h('div', `team-agent-card ${agent}`); const name = h('div', 'team-agent-name'); name.append(h('span', `agent-orb ${agent}`), h('strong', '', AGENT_FULL[agent]))
    const rows = h('div', 'team-agent-fields'); const label = (text: string, control: HTMLElement) => { const l = h('label', 'team-agent-field'); l.append(h('span', '', text), control); return l }
    rows.append(label('Model', model)); if (effortSel) rows.append(label('Effort', effortSel))
    card.append(name, rows); return card
  }
  const readyAgents = new Set(health.agents.filter(a => a.ok).map(a => a.agent))
  agentsBox.append(agentCard('claude', claudeModel, effort), agentCard('codex', codexModel, codexEffort))
  if (health.localModels.length) agentsBox.append(agentCard('local', localModel))
  agentsBox.querySelectorAll<HTMLElement>('.team-agent-card').forEach(card => { const a = (['claude', 'codex', 'local'] as const).find(x => card.classList.contains(x)); if (a && !readyAgents.has(a) && !replay) card.classList.add('off') })
  form.append(goal, att.strip, folderFinder(goal, project), agentsBox, askRow, webRow, healthBox, advanced, actions)
  form.onsubmit = async e => {
    e.preventDefault(); const text = goal.value.trim(); if (!text || start.disabled || att.busy()) return
    const config = readConfig(); if (!config) return
    const files = att.ready() as TeamAttachment[]
    start.disabled = true; start.replaceChildren('Sending the crew…')
    if (replay) { const fixture = replayRun('planning'); await openRun(fixture.run.id, fixture); return }
    try { if (typeof window.forge.teamSettingsSet === 'function') await window.forge.teamSettingsSet(config); const started = await window.forge.teamStart(text, files.length ? { ...config, attachments: files } : config); await openRun(started.id) }
    catch (err) { start.disabled = false; start.replaceChildren(startLabel); toast(cleanErr(err), 6000) }
  }
  intro.append(form); page.append(intro)
  page.append(renderRunList())
  root.replaceChildren(page); goal.focus()
  if (replay && !['entry', 'unavailable'].includes(replayState)) await openRun('replay-team-run', replayRun(replayState))
}

// A native select dressed as a compact header button: leading icon, the value, up/down chevrons.
function selectButton(glyph: IconName, el: HTMLSelectElement, label: string) { const wrap = h('label', 'select-btn'); el.setAttribute('aria-label', label); wrap.title = label; wrap.append(icon(glyph, 'sm'), el, icon('updown', 'sm chev')); return wrap }
const newRun = () => { root.scrollTo({ top: 0, behavior: 'smooth' }); document.querySelector<HTMLTextAreaElement>('.team-start-card textarea')?.focus() }
function emptyState(glyph: IconName, title: string, copy: string, action?: [string, () => void]) {
  const box = h('div', 'empty-state'); const mark = h('div', 'empty-glyph'); mark.append(icon(glyph)); box.append(mark, h('div', 'empty-title', title), h('p', 'empty-copy', copy))
  if (action) { const b = h('button', 'btn primary', action[0]); b.onclick = action[1]; box.append(b) }
  return box
}

// Previous runs as a sessions board: a header with view, filter, sort, search and New; then a table (or cards) of runs.
function renderRunList() {
  const section = h('section', `team-runs ${runView}`)
  const redraw = (focusSearch = false) => { const next = renderRunList(); section.replaceWith(next); if (focusSearch) queueMicrotask(() => { const field = next.querySelector<HTMLInputElement>('input[type="search"]'); field?.focus(); field?.setSelectionRange(field.value.length, field.value.length) }) }
  const head = h('div', 'page-head'); const title = h('h2', 'page-title', N.recentRuns); title.append(h('span', 'page-count', String(summaries.length))); head.append(title, h('span', 'grow'))
  const tools = h('div', 'head-tools')
  const view = h('div', 'view-toggle'); view.setAttribute('role', 'group'); view.setAttribute('aria-label', 'Layout')
  for (const [v, glyph, label] of [['grid', 'grid', 'Grid'], ['list', 'list', 'List']] as const) {
    const b = h('button', `icon-btn sm${runView === v ? ' on' : ''}`); b.append(icon(glyph, 'sm')); b.title = `${label} view`; b.setAttribute('aria-label', `${label} view`); b.setAttribute('aria-pressed', String(runView === v))
    b.onclick = () => { runView = v; try { localStorage.setItem('forge.teamRunView', v) } catch {} redraw() }; view.append(b)
  }
  const filter = select([['all', 'All runs'], ['active', 'In progress'], ['attention', 'Needs attention'], ['done', 'Finished']], runFilter); filter.onchange = () => { runFilter = filter.value; redraw() }
  const sort = select([['opened', 'Last opened'], ['created', 'Created'], ['goal', 'Goal A-Z']], runSort); sort.onchange = () => { runSort = sort.value; redraw() }
  const searchWrap = h('div', `head-search${runSearchOpen || runSearch ? ' open' : ''}`)
  const search = input('search', runSearch); search.placeholder = 'Search goals'; search.setAttribute('aria-label', 'Search crew runs')
  const searchBtn = h('button', 'icon-btn sm'); searchBtn.append(icon('search', 'sm')); searchBtn.title = 'Search runs'; searchBtn.setAttribute('aria-label', 'Search runs')
  searchBtn.onclick = () => { runSearchOpen = true; searchWrap.classList.add('open'); search.focus() }
  search.onblur = () => { if (!search.value) { runSearchOpen = false; searchWrap.classList.remove('open') } }
  search.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); search.value = ''; runSearch = ''; runSearchOpen = false; redraw() } }
  search.oninput = () => { runSearch = search.value; runSearchOpen = true; redraw(true) }
  searchWrap.append(searchBtn, search)
  const add = h('button', 'btn primary'); add.append(icon('plus', 'sm'), document.createTextNode('New')); add.title = 'Start a new crew run'; add.onclick = newRun
  tools.append(view, selectButton('filter', filter, 'Filter crew runs'), selectButton('sort', sort, 'Sort crew runs'), searchWrap, add); head.append(tools); section.append(head)
  const active = ['planning', 'running', 'verifying', 'paused', 'interrupted', 'awaiting_approval']
  const order = (a: Summary, b: Summary) => runSort === 'goal' ? a.goal.localeCompare(b.goal) : runSort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt
  const visible = [...summaries].sort(order).filter(item => item.goal.toLowerCase().includes(runSearch.trim().toLowerCase()) && (runFilter === 'all' || runFilter === 'active' && active.includes(item.status) || runFilter === 'attention' && ['failed', 'paused', 'interrupted'].includes(item.status) || runFilter === 'done' && ['done', 'cancelled'].includes(item.status)))
  const table = h('div', 'run-table'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', N.recentRuns)
  const cols = h('div', 'run-cols run-head'); cols.setAttribute('role', 'row')
  for (const [label, cls] of [['Run', 'c-goal'], ['Status', 'c-status'], ['Project', 'c-project'], ['Tasks', 'c-tasks'], ['Last opened', 'c-when']]) { const c = h('span', cls, label); c.setAttribute('role', 'columnheader'); cols.append(c) }
  table.append(cols); section.append(table)
  if (!summaries.length) { section.append(emptyState('users', 'No crew runs yet', 'Describe a goal above and the crew plans it, splits the work and brings back one checked result.', ['New run', newRun])); return section }
  if (!visible.length) { section.append(emptyState('search', 'No runs match', 'Try another search or filter.', ['Clear filters', () => { runSearch = ''; runFilter = 'all'; runSearchOpen = false; redraw() }])); return section }
  for (const [index, item] of visible.entries()) {
    const row = h('article', 'run-row'); row.setAttribute('role', 'row'); enter(row, `row:${item.id}`, index)
    const open = h('button', 'run-open run-cols'); open.setAttribute('aria-label', `Open ${item.goal}`); open.onclick = () => void (replay ? openRun(item.id, replayRun('interrupted')) : openRun(item.id))
    const count = h('span', 'c-tasks', `${item.tasks.done}/${item.tasks.total}`); count.title = `${item.tasks.done} of ${item.tasks.total} tasks done`
    const where = h('span', 'c-project', folderName(item.project)); where.title = item.project
    const when = h('span', 'c-when', timeAgo(item.updatedAt)); when.title = new Date(item.updatedAt).toLocaleString()
    const status = h('span', 'c-status'); status.append(statusTag(item.status))
    open.append(h('strong', 'c-goal', item.goal), status, where, count, when)
    const acts = h('span', 'run-acts')
    if (typeof window.forge.teamExportReport === 'function' && ['awaiting_approval', 'done'].includes(item.status)) { const exportButton = h('button', 'icon-btn sm'); exportButton.append(icon('download', 'sm')); exportButton.title = 'Export report'; exportButton.setAttribute('aria-label', `Export report for ${item.goal}`); exportButton.onclick = () => void call(() => window.forge.teamExportReport(item.id)); acts.append(exportButton) }
    if (typeof window.forge.teamDelete === 'function' && !['planning', 'running', 'verifying', 'paused', 'interrupted'].includes(item.status)) {
      const del = h('button', 'icon-btn sm'); del.append(icon('trash', 'sm')); del.title = 'Delete run'; del.setAttribute('aria-label', `Delete ${item.goal}`)
      del.onclick = () => void call(async () => { if (!window.confirm(`Delete this run?\n\n${item.goal}\n\nIts saved report and unfinished crew work will be removed.`)) return; if (await window.forge.teamDelete(item.id)) { summaries = summaries.filter(x => x.id !== item.id); redraw() } })
      acts.append(del)
    }
    row.append(open, acts); table.append(row)
  }
  return section
}

async function openRun(id: string, fixture?: { run: Run; events: Logged[]; memory?: TeamMemory }) {
  root.replaceChildren(h('div', 'team-run-loading skel'))
  const loaded = fixture ?? await (async () => { const [saved, events] = await Promise.all([window.forge.teamGet(id), window.forge.teamEvents(id)]); if (!saved) throw new Error('This run no longer exists.'); return { run: saved, events } })()
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
  const answered = renderAnswered(); if (answered) page.append(answered)
  if (run.status === 'awaiting_approval' && run.final) page.append(renderFinal())
  if (run.status === 'done' && run.applied) page.append(renderApplied())
  page.append(renderBoard(), renderStory())
  root.replaceChildren(page); root.scrollTop = scrollTop
}

function renderRunHeader() {
  const header = h('header', 'team-run-header')
  const back = h('button', 'icon-btn'); back.append(icon('arrowright')); back.classList.add('back'); back.title = `All ${N.crewRuns.toLowerCase()}`; back.onclick = () => void showEntry()
  const where = h('div', 'eyebrow', folderName(run!.project)); where.prepend(icon('folder', 'sm')); where.title = run!.project
  const identity = h('div', 'team-run-identity'); identity.append(where, h('h1', '', run!.goal))
  const sent = run!.config?.attachments ?? []
  if (sent.length) identity.append(sentChips(sent))
  const asking = run!.approvals.some(a => a.kind === 'question' && a.status === 'pending')
  const status = asking ? h('span', 'status-pill awaiting_approval asking') : statusTag(run!.status); if (asking) status.append(emo(RUN_GLYPH.awaiting_approval), N.waiting); status.setAttribute('role', 'status')
  const elapsed = h('span', 'team-elapsed', fmtTime(Math.floor((Date.now() - run!.createdAt) / 1000))); elapsed.id = 'team-elapsed'
  const controls = h('div', 'team-controls')
  controls.append(historyButton())
  const planPending = run!.approvals.some(a => a.kind === 'plan' && a.status === 'pending')
  if (planPending) { /* the plan card starts the team */ }
  else if (['paused', 'interrupted'].includes(run!.status)) controls.append(actionButton('Resume', () => teamAction(() => window.forge.teamResume(run!.id))))
  else if (['planning', 'running', 'verifying'].includes(run!.status)) controls.append(pauseButton())
  if (isActive(run!.status) && run!.status !== 'awaiting_approval') controls.append(actionButton('Cancel run', () => teamAction(() => window.forge.teamCancel(run!.id)), 'danger', 'x'))
  if (run!.final && typeof window.forge.teamExportReport === 'function') controls.append(actionButton('Export report', () => call(() => window.forge.teamExportReport(run!.id)), '', 'download'))
  header.append(back, identity, status, elapsed, controls)
  const usage = h('div', 'team-usage-strip')
  for (const agent of ['claude', 'codex', 'local'] as const) {
    if (agent === 'local' && !run!.usage.local?.runs) continue
    const u = run!.usage[agent] ?? { input: 0, output: 0, cached: 0, costUsd: 0, runs: 0 }, item = h('div', 'team-usage-item')
    item.append(h('span', `agent-orb ${agent}`), h('strong', '', AGENT_NAME[agent]), h('span', '', `${formatTokens(u.input + u.output)} tokens`)); item.title = `${AGENT_NAME[agent]}: ${(u.input + u.output).toLocaleString()} tokens`
    if (u.costUsd > 0) item.append(h('span', '', `~$${u.costUsd.toFixed(2)}`))
    const limits = run!.limits?.[agent]; if (limits) { const meter = h('span', 'limit-meter', `${Math.round(limits.primaryPct)}% plan`); meter.title = `ChatGPT plan: ${Math.round(limits.primaryPct)}% of this window used`; item.append(meter) }
    usage.append(item)
  }
  header.append(usage)
  const counted = run!.tasks.filter(t => t.status !== 'cancelled'), done = counted.filter(t => t.status === 'done').length
  if (counted.length) {
    const progress = h('div', 'team-progress'); progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', String(counted.length)); progress.setAttribute('aria-valuenow', String(done))
    const bar = h('span', 'team-progress-bar'); const fill = h('i'); fill.style.transform = `scaleX(${done / counted.length})`; bar.append(fill)
    progress.append(bar, h('span', '', `${done}/${counted.length} done`)); progress.setAttribute('aria-label', `${done} of ${counted.length} tasks done`); header.append(progress)
  }
  return header
}

// `compact` shows only that icon; the label moves to the tooltip and the accessible name.
function actionButton(label: string, runAction: () => void, cls = '', compact?: IconName) { const button = h('button', `btn ${cls}${compact ? ' only' : ''}`); if (compact) { button.append(icon(compact, 'sm')); button.title = label; button.setAttribute('aria-label', label) } else button.append(document.createTextNode(label)); button.onclick = runAction; return button }
function pauseButton() {
  const button = actionButton('Pause', () => {}, '', 'pause') as HTMLButtonElement; let timer: ReturnType<typeof setTimeout> | null = null, hard = false
  button.title = 'Pause after the current step. Hold for one second to stop agents now.'
  button.onpointerdown = () => { hard = false; timer = setTimeout(() => { hard = true; button.replaceChildren(icon('stop', 'sm'), 'Stopping agents…'); void teamAction(() => window.forge.teamPause(run!.id, true)) }, 900) }
  button.onpointerup = () => { if (timer) clearTimeout(timer); timer = null; if (!hard) void teamAction(() => window.forge.teamPause(run!.id, false)) }
  button.onpointerleave = () => { if (timer) clearTimeout(timer); timer = null }
  button.onclick = e => e.preventDefault(); return button
}
async function teamAction(fn: () => Promise<unknown>) { if (replay) { toast('Replay mode: action recorded'); return } await call(fn); await refreshRun() }
async function refreshRun() { if (!run || replay) return; const fresh = await window.forge.teamGet(run.id); if (fresh) { run = fresh; renderRun() } }

function renderPauseBanner() {
  const banner = h('section', 'team-pause-banner')
  banner.append(emo(RUN_GLYPH[run!.status === 'interrupted' ? 'interrupted' : 'paused']), h('div', '', run!.pausedReason || 'This run was interrupted when Forge closed. The agents will continue from their saved sessions.'))
  if (run!.status === 'done' || run!.status === 'cancelled') return banner
  if (run!.approvals.some(a => a.kind === 'plan' && a.status === 'pending')) return banner
  const failed = run!.tasks.find(task => task.status === 'failed' || task.status === 'blocked' || task.status === 'interrupted')
  if (run!.status === 'failed' && failed) banner.append(actionButton('Retry failed task', () => teamAction(() => window.forge.teamRetryTask(run!.id, failed.id)), 'primary'))
  else if (run!.status === 'failed') return banner
  else if (/limit|budget|allowance/i.test(run!.pausedReason ?? '')) banner.append(actionButton('Allow 50% more', () => teamAction(() => window.forge.teamExtendBudget(run!.id)), 'primary'))
  else banner.append(actionButton('Resume the crew', () => teamAction(() => window.forge.teamResume(run!.id)), 'primary'))
  return banner
}

function renderApprovals(items: Run['approvals']) {
  const tray = h('section', 'approval-tray'); tray.setAttribute('role', 'alert'); tray.setAttribute('aria-live', 'assertive'); tray.append(sectionHead(N.waiting, `${items.length} blocking`))
  for (const approval of [...items].sort((a, b) => Number(b.kind === 'question') - Number(a.kind === 'question'))) {
    if (approval.kind === 'plan') { tray.append(renderPlanReview(approval)); continue }
    if (approval.kind === 'question') { tray.append(renderQuestion(approval)); continue }
    const card = h('article', 'team-approval-card'); const copy = h('div', 'approval-copy')
    const kind = h('span', 'approval-kind', approval.kind.replace('_', ' '))
    copy.append(kind, h('h3', '', approval.title), h('p', '', approval.detail))
    const note = input('text'); note.placeholder = 'Optional note to the crew'; note.setAttribute('aria-label', `Note for ${approval.title}`)
    const actions = h('div', 'approval-actions')
    const answer = async (allow: boolean) => { if (replay) { approval.status = allow ? 'allowed' : 'denied'; renderRun(); return } const accepted = await window.forge.teamAnswer(run!.id, approval.id, allow, note.value.trim() || undefined); if (!accepted) toast('The crew is no longer waiting on this approval.'); await refreshRun() }
    if (approval.kind === 'budget') actions.append(actionButton('Allow 50% more', () => void teamAction(() => window.forge.teamExtendBudget(run!.id)), 'primary'))
    else actions.append(actionButton(approval.kind === 'review_override' ? 'Merge anyway' : 'Allow', () => void answer(true), 'primary'))
    actions.append(actionButton(approval.kind === 'review_override' ? 'Keep separate' : 'Deny', () => void answer(false)))
    card.append(copy, note, actions); tray.append(card)
  }
  return tray
}

// A question from an agent: options as rows (radio or checkbox), always an "Other…" row with its own text, then Skip and Send.
// Keys: up/down move between rows, 1-4 pick, Enter sends.
function renderQuestion(approval: Run['approvals'][number]) {
  const who = approval.agent ? AGENT_NAME[approval.agent] : 'The crew'
  const card = h('article', 'question-card'); card.setAttribute('aria-label', `${who} asks: ${approval.title}`)
  const top = h('div', 'q-who'); top.append(h('span', `agent-orb ${approval.agent ?? ''}`), h('strong', '', who), h('span', '', 'asks'))
  card.append(top, h('h3', 'q-title', approval.title))
  if (approval.detail && approval.detail !== approval.title) card.append(h('p', 'q-detail', approval.detail))
  const options = approval.options ?? [], multi = !!approval.multi, OTHER = options.length
  const draft = questionDrafts.get(approval.id)
  const picked = new Set<number>(draft?.picked)
  const other = input('text', draft?.other ?? ''); other.className = 'q-other'; other.placeholder = options.length ? 'Type your own answer' : 'Type your answer'; other.setAttribute('aria-label', 'Your answer')
  const list = h('div', 'q-options'); list.setAttribute('role', multi ? 'group' : 'radiogroup'); list.setAttribute('aria-label', 'Choices')
  const rows: HTMLButtonElement[] = []
  const choice = (index: number, label: string, desc = '') => {
    const b = h('button', 'q-opt') as HTMLButtonElement; b.type = 'button'; b.setAttribute('role', multi ? 'checkbox' : 'radio')
    const text = h('span', 'q-text'); text.append(h('strong', '', label)); if (desc) text.append(h('small', '', desc))
    b.append(h('span', `q-mark ${multi ? 'box' : 'radio'}`), text); if (index < 4 && index < OTHER) b.append(h('kbd', '', String(index + 1)))
    b.onclick = () => pick(index); rows.push(b); list.append(b)
  }
  const answerText = () => [...[...picked].filter(i => i !== OTHER).sort((a, b) => a - b).map(i => options[i].label), ...(picked.has(OTHER) || !options.length ? [other.value.trim()] : [])].filter(Boolean).join(', ')
  const send = h('button', 'btn primary', 'Send answer') as HTMLButtonElement; send.append(icon('arrowright', 'sm'))
  const sync = () => {
    rows.forEach((b, i) => { const on = picked.has(i); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)) })
    other.hidden = options.length > 0 && !picked.has(OTHER)
    send.disabled = !answerText()
    questionDrafts.set(approval.id, { picked: [...picked], other: other.value })
  }
  const pick = (index: number) => {
    if (multi) { if (picked.has(index)) picked.delete(index); else picked.add(index) } else { picked.clear(); picked.add(index) }
    sync(); if (index === OTHER && picked.has(OTHER)) other.focus()
  }
  options.forEach((o, i) => choice(i, o.label, o.description))
  if (options.length) { choice(OTHER, 'Other…', 'Write your own answer'); card.append(list) }
  card.append(other)
  const finish = async (allow: boolean) => {
    const text = answerText(); if (allow && !text) return
    send.disabled = true
    if (replay) { approval.status = allow ? 'allowed' : 'denied'; if (allow) approval.answer = text; approval.answeredAt = Date.now(); renderRun(); return }
    await call(async () => { const accepted = await window.forge.teamAnswer(run!.id, approval.id, allow, allow ? text : undefined); if (!accepted) toast('The crew is no longer waiting on this question.'); await refreshRun() })
    send.disabled = !answerText()
  }
  other.oninput = sync
  card.onkeydown = e => {
    const inField = e.target === other
    if (e.key === 'Enter' && !e.shiftKey) { if (!send.disabled) { e.preventDefault(); void finish(true) } else if (!inField && rows.includes(e.target as HTMLButtonElement)) { e.preventDefault(); (e.target as HTMLButtonElement).click() } return }
    if (inField) return
    const at = rows.indexOf(e.target as HTMLButtonElement)
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) { e.preventDefault(); rows[(Math.max(at, 0) + (e.key === 'ArrowDown' ? 1 : at < 0 ? 0 : -1) + rows.length) % rows.length].focus() }
    else if (/^[1-4]$/.test(e.key) && Number(e.key) <= options.length) { e.preventDefault(); pick(Number(e.key) - 1); rows[Number(e.key) - 1].focus() }
  }
  const foot = h('div', 'q-foot'); const hint = h('span', 'modal-hint', `Answering unblocks ${who}`)
  const skip = h('button', 'btn', 'Skip') as HTMLButtonElement; skip.title = 'Skip this question; the agent decides on its own'; skip.onclick = () => void finish(false)
  send.onclick = () => void finish(true)
  foot.append(hint, h('span', 'grow'), skip, send); card.append(foot)
  sync(); return card
}
// Questions already answered in this run, one line each.
function renderAnswered() {
  const done = run!.approvals.filter(a => a.kind === 'question' && a.status !== 'pending')
  const box = h('section', 'q-answered'); if (!done.length) return null
  for (const a of done) {
    const line = h('div', 'q-line'); line.append(h('span', `agent-orb ${a.agent ?? ''}`), h('span', 'q-asked', a.title))
    line.append(h('strong', '', a.status === 'allowed' && a.answer ? `You answered: ${a.answer}` : a.status === 'denied' ? 'You skipped this' : 'No longer needed'))
    box.append(line)
  }
  return box
}

function renderPlanReview(approval: Run['approvals'][number]) {
  const card = h('article', 'team-plan-review')
  const kind = h('span', 'approval-kind', 'plan')
  card.append(kind, h('h3', '', approval.title), h('p', '', approval.detail))
  const rows = run!.tasks.map((task, index) => {
    const row = h('div', 'plan-edit-row'), skipped = task.status === 'cancelled'
    const title = input('text', task.title); title.setAttribute('aria-label', `Task ${index + 1} title`)
    const agent = select([['claude', 'Claude'], ['codex', 'Codex'], ['local', AGENT_NAME.local]], task.agent); agent.setAttribute('aria-label', `Task ${index + 1} agent`)
    const skip = input('checkbox'); skip.checked = skipped; skip.setAttribute('aria-label', `Skip task ${index + 1}`)
    const skipLabel = h('label', 'plan-skip'); skipLabel.append(skip, document.createTextNode('Skip'))
    const goal = h('p', 'plan-goal', task.goal)
    row.append(h('span', 'task-number', String(index + 1).padStart(2, '0')), title, agent, skipLabel, goal)
    if (task.deps.length) row.append(h('p', 'task-deps', `After ${task.deps.map(id => run!.tasks.find(t => t.id === id)?.title ?? id).join(', ')}`))
    if (task.acceptance.length) { const checks = h('details', 'plan-checks'); checks.append(h('summary', '', `${task.acceptance.length} ${task.acceptance.length === 1 ? 'check' : 'checks'}`), ...task.acceptance.map(item => h('p', '', item))); row.append(checks) }
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
    if (!accepted) toast('The crew is no longer waiting on this plan.')
    await refreshRun()
  }
  actions.append(
    actionButton(N.sendCrew, () => void call(() => apply(true)), 'primary'),
    actionButton('Save edits', () => void call(() => apply(false))),
    actionButton('Cancel run', () => void (replay ? toast('Replay mode: action recorded') : call(async () => { await window.forge.teamAnswer(run!.id, approval.id, false); await refreshRun() }))),
  )
  card.append(list, result, actions); return card
}

function renderBoard() {
  const section = h('section', 'team-board-section'); section.append(sectionHead(N.plan, run!.plan.summary || `${run!.tasks.length} tasks`))
  const board = h('div', 'team-board')
  if (!run!.tasks.length) for (let i = 0; i < 3; i++) board.append(h('div', 'task-card task-skeleton skel'))
  for (const [index, task] of run!.tasks.entries()) board.append(renderTask(task, index))
  section.append(board); return section
}
function renderTask(task: Task, index: number) {
  const card = h('article', `task-card ${task.status}`); card.dataset.task = task.id; enter(card, `${run!.id}:${task.id}`, index)
  const state = h('span', `task-state ${task.status}`); state.append(emo(TASK_GLYPH[task.status] ?? TASK_GLYPH.queued)); if (task.status === 'running' && task.phase) state.append(PHASE_LABEL[task.phase] ?? task.phase); state.title = task.phase ? `${PHASE_LABEL[task.phase] ?? task.phase} · ${task.status}` : task.status; state.setAttribute('aria-label', state.title)
  const top = h('div', 'task-top'); top.append(h('span', 'task-number', String(index + 1).padStart(2, '0')), h('span', `agent-badge ${task.agent}`, AGENT_NAME[task.agent]), state)
  card.append(top, h('h3', '', task.title))
  if (task.deps.length) card.append(h('p', 'task-deps', `After ${task.deps.map(id => run!.tasks.find(t => t.id === id)?.title ?? id).join(', ')}`))
  const facts = h('div', 'task-facts'); const fact = (text: string, title: string, cls = '') => { const f = h('span', cls, text); f.title = title; facts.append(f) }
  if (task.changed.length) fact(`${task.changed.length} ${task.changed.length === 1 ? 'file' : 'files'}`, `${task.changed.length} ${task.changed.length === 1 ? 'file' : 'files'} changed`); if (task.fixRounds) fact(`${task.fixRounds} ${task.fixRounds === 1 ? 'fix' : 'fixes'}`, `${task.fixRounds} fix ${task.fixRounds === 1 ? 'round' : 'rounds'}`)
  const verdict = task.reviews.at(-1)
  if (task.agent === 'local') { if (verdict) fact(`Checked by ${AGENT_NAME[verdict.by]}: ${verdict.verdict}`, `${AGENT_NAME.local} work is always checked. ${AGENT_NAME[verdict.by]} reviewed it: ${verdict.verdict}`, `verdict ${verdict.verdict}`); else fact('Will be checked', `${AGENT_NAME.local} work is always checked by another agent`, 'verdict') }
  else if (verdict) fact(`Review ${verdict.verdict}`, `Review: ${verdict.verdict}`, `verdict ${verdict.verdict}`)
  card.append(facts)
  if (task.error) card.append(h('p', 'task-error', task.error))
  if (task.status === 'failed' || task.status === 'blocked' || task.status === 'interrupted') {
    const actions = h('div', 'task-actions'); actions.append(actionButton('Retry', () => teamAction(() => window.forge.teamRetryTask(run!.id, task.id)), 'primary'), actionButton('Skip', () => teamAction(() => window.forge.teamSkipTask(run!.id, task.id))))
    card.append(actions)
  }
  if (task.changed.length || task.diff) card.onclick = e => { if (!(e.target as HTMLElement).closest('button')) void openDiff(task.id) }
  return card
}

function renderStory() {
  const area = h('section', 'team-story')
  const side = h('aside', 'team-side-story'); side.append(renderLiveFiles(), renderFeed(), renderMemory(), renderVerify(), renderSteer(), renderDiffPanel())
  area.append(renderLanes(), side); return area
}
const usedAgents = () => (['claude', 'codex', 'local'] as const).filter(a => run!.tasks.some(t => t.agent === a) || log.some(x => x.ev.type === 'agent' && x.ev.ev.agent === a))
function makeDetailsToggle() {
  const toggle = h('button', `lane-details ${laneDetails ? 'on' : ''}`, laneDetails ? 'Live' : 'Details'); toggle.prepend(icon(laneDetails ? 'code' : 'list', 'sm')); toggle.title = laneDetails ? 'Back to the live coding view' : 'Show commands, step results, prompts and reasoning'; toggle.setAttribute('aria-pressed', String(laneDetails))
  toggle.onclick = () => { laneDetails = !laneDetails; try { localStorage.setItem('forge.teamLaneDetails', laneDetails ? '1' : '0') } catch {} document.querySelector('.team-lanes')?.replaceWith(renderLanes()) }
  return toggle
}
// The live view is one editor for the whole team; "Details" swaps it for a lane per agent with every command and message.
function renderLanes() {
  const lanes = h('div', `team-lanes${laneDetails ? '' : ' single'}`)
  if (laneDetails) { const used = usedAgents(); for (const a of used) lanes.append(renderLane(a)); if (!used.length) lanes.append(renderLane('claude')); return lanes }
  const files: StageCode[] = log.flatMap(x => x.ev.type === 'agent' && x.ev.ev.type === 'code' && x.ev.phase !== 'plan' ? [{ id: x.ev.ev.id, agent: x.ev.ev.agent, path: x.ev.ev.path, text: x.ev.ev.text, kind: x.ev.ev.kind, done: x.ev.ev.done }] : [])
  const working = run!.tasks.some(t => t.status === 'running')
  const status = run!.status === 'planning' ? 'Planning the work' : working ? 'Reading the project' : ['done', 'awaiting_approval'].includes(run!.status) ? 'Finished' : run!.status === 'paused' ? 'Paused' : 'Waiting'
  const agents = (usedAgents().length ? usedAgents() : (['claude'] as const)).map(a => ({ agent: a, name: AGENT_NAME[a], running: run!.tasks.some(t => t.agent === a && t.status === 'running') || run!.status === 'planning' }))
  lanes.append(buildStage(files, { agents, running: working || run!.status === 'planning', status, details: makeDetailsToggle(), live: ['planning', 'running', 'verifying'].includes(run!.status) ? 'Live' : 'History' }))
  return lanes
}
function renderLane(agent: 'claude' | 'codex' | 'local') {
  const lane = h('section', `agent-lane ${agent}`); const header = h('header'); header.append(h('span', `agent-orb ${agent}${run!.tasks.some(t => t.agent === agent && t.status === 'running') ? ' busy' : ''}`), h('div', '', AGENT_FULL[agent]), h('span', `lane-live${['planning', 'running', 'verifying'].includes(run!.status) ? ' on' : ''}`, ['planning', 'running', 'verifying'].includes(run!.status) ? 'Live' : 'History')); header.append(makeDetailsToggle()); lane.append(header)
  const events = log.filter(x => x.ev.type === 'agent' && x.ev.ev.agent === agent && laneVisible(x.ev))
  const body = h('div', 'lane-body')
  if (!events.length) { const working = run!.tasks.some(t => t.agent === agent && t.status === 'running'); body.append(h('p', `lane-status ${run!.status === 'planning' || working ? 'active' : ''}`, run!.status === 'planning' ? 'Planning the work' : working ? 'Reading the project' : run!.tasks.some(t => t.agent === agent && t.status === 'queued') ? 'Waiting for its turn' : run!.status === 'done' || run!.status === 'awaiting_approval' ? 'Finished' : 'Idle')) }
  let lastKey = ''
  const shown = events.slice(-40), lastCode = shown.map(x => x.ev.type === 'agent' && x.ev.ev.type === 'code').lastIndexOf(true)
  for (const [shownIndex, { t, ev }] of shown.entries()) if (ev.type === 'agent') {
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
    else if (event.type === 'code') row.append(renderLiveCode(event, shownIndex === lastCode || !event.done))
    else if (event.type === 'prompt') {
      const prompt = h('details', 'agent-prompt')
      prompt.append(h('summary', '', 'What this agent was told'), h('pre', '', event.text)); row.append(prompt)
    }
    else if (event.type === 'tool' && /^(web_?search|webfetch|web_fetch)$/i.test(event.name ?? '')) { const tool = h('div', 'activity-tool web'); tool.append(icon('globe', 'sm'), document.createTextNode(`${/fetch/i.test(event.name) ? 'Reading a page' : 'Searching the web'} · ${event.summary}`)); row.append(tool) }
    else if (event.type === 'tool') row.append(h('div', `activity-tool ${event.kind}`, `${TOOL_GLYPH[event.kind] ?? TOOL_GLYPH.other} ${event.kind === 'command' ? 'Running' : event.kind === 'edit' ? 'Changing' : event.kind === 'read' ? 'Reading' : 'Working'} · ${event.summary}`))
    else if (event.type === 'tool_result') { const details = h('details', `activity-result ${event.ok ? 'ok' : 'bad'}`); details.append(h('summary', '', event.ok ? `${STEP_GLYPH.ok} Step finished` : `${STEP_GLYPH.bad} Step failed`), h('pre', '', event.text.slice(0, 5000))); row.append(details) }
    else if (event.type === 'note') row.append(h('p', 'activity-note', event.text))
    else if (event.type === 'error') row.append(h('p', 'task-error', event.message))
    else if (event.type === 'done') row.append(h('p', event.ok ? 'activity-done' : 'task-error', event.text))
    else if (event.type === 'limits') row.append(h('p', 'activity-note', `Plan usage: ${Math.round(event.primaryPct)}%`))
    body.append(row)
  }
  lane.append(body); return lane
}

function renderLiveCode(event: Extract<RunEvent, { type: 'agent' }>['ev'] & { type: 'code' }, open: boolean) {
  const card = h('details', `live-code ${event.kind} ${event.done ? 'done' : 'writing'}`) as HTMLDetailsElement; card.open = open
  const head = h('summary', 'live-code-head')
  head.append(h('span', 'tool-path', event.path), h('span', 'live-code-state', event.done ? 'Saved' : 'Writing'))
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
  if (!event.done) { pre.append(h('span', 'code-cursor', '')); requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight }) }
  card.append(head, pre); return card
}

function renderFeed() {
  const section = h('section', 'team-feed'); section.append(sectionHead(N.feed, `${run!.messages.length}`))
  if (!run!.messages.length) section.append(h('p', 'team-empty', 'Handoffs, reviews and decisions appear here.'))
  for (const msg of run!.messages.slice(-12)) { const item = h('article', `feed-item ${msg.kind}`); const top = h('div'); const kindTag = h('span', '', msg.kind.replace('_', ' ')); top.append(h('strong', '', msg.from === 'user' ? 'You' : msg.from === 'orchestrator' ? 'Forge' : AGENT_NAME[msg.from]), kindTag); const body = h('p', 'feed-body', msg.body); item.append(top, body); if (msg.body.length > 260) { item.classList.add('clamped'); item.title = 'Click to read all'; item.onclick = () => item.classList.toggle('clamped') } section.append(item) }
  return section
}

function renderLiveFiles() {
  const section = h('section', 'team-live-files')
  const count = [...liveFiles.values()].reduce((total, files) => total + files.length, 0)
  section.append(sectionHead(N.changing, count ? `${count} live` : 'Quiet'))
  if (!count) { section.append(h('p', 'team-empty', 'Files appear here while an agent is writing them.')); return section }
  for (const [taskId, files] of liveFiles) {
    const group = h('div', 'live-file-group'); const task = run!.tasks.find(item => item.id === taskId)
    group.append(h('div', 'live-file-task', task?.title ?? taskId))
    for (const file of files) {
      const button = h('button', 'live-file-row')
      button.append(fileStatus(file.status), h('span', 'tool-path', file.path), h('span', 'team-diff-count', `+${file.added} −${file.removed}`))
      button.onclick = () => void openDiff(taskId, file.path, true); group.append(button)
    }
    section.append(group)
  }
  return section
}

function renderMemory() {
  const section = h('section', 'team-memory')
  section.append(sectionHead(N.notes, memoryLoading ? 'Refreshing…' : sharedMemory ? 'Current' : 'Waiting'))
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
  const section = h('section', 'team-verify'); section.append(sectionHead(N.checks, events.length ? `${events.length}` : 'Waiting'))
  for (const item of events.slice(-3)) if (item.ev.type === 'verify') { const details = h('details', `verify-card ${item.ev.ok ? 'ok' : 'bad'}`) as HTMLDetailsElement; details.open = !item.ev.ok; details.append(h('summary', '', `${item.ev.ok ? `${STEP_GLYPH.ok} Passed` : `${STEP_GLYPH.bad} Failed`} · ${item.ev.command}`), h('pre', '', item.ev.output.slice(-8000))); section.append(details) }
  return section
}
function renderSteer() {
  const form = h('form', 'team-steer'); const label = h('label', '', 'Tell the crew'); const row = h('div')
  const text = input('text', steerDraft); text.placeholder = 'Add context or change direction…'; text.setAttribute('aria-label', 'Tell the crew'); text.oninput = () => { steerDraft = text.value }
  const to = select([['all', 'Everyone'], ['claude', 'Claude'], ['codex', 'Codex'], ['local', AGENT_NAME.local]], steerTarget); to.setAttribute('aria-label', 'Send to'); to.onchange = () => { steerTarget = to.value as typeof steerTarget }
  const send = h('button', 'icon-btn'); send.append(icon('arrowup')); send.setAttribute('aria-label', 'Send to the crew'); send.title = 'Send'
  row.append(text, to, send); form.append(label, row)
  form.onsubmit = e => { e.preventDefault(); const value = text.value.trim(); if (!value) return; if (replay) { run!.messages.push({ id: crypto.randomUUID(), from: 'user', to: steerTarget, kind: 'steer', body: value, at: Date.now(), readBy: [] }); steerDraft = ''; renderRun() } else void call(async () => { await window.forge.teamSteer(run!.id, value, steerTarget); steerDraft = ''; await refreshRun() }) }
  return form
}
function renderDiffPanel() {
  const section = h('section', 'team-diff-panel')
  const changed = run!.tasks.flatMap(task => task.changed.map(file => ({ task, file })))
  section.append(sectionHead('Changes', `${changed.length} files`))
  if (changed.length) {
    const files = h('div', 'team-diff-files')
    for (const { task, file } of changed.slice(0, 12)) {
      const row = h('button', 'team-diff-file')
      row.append(fileStatus(file.status), h('span', 'tool-path', file.path), h('span', 'team-diff-count', `+${file.added} −${file.removed}`))
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
  const done = h('div', 'eyebrow', 'Crew finished'); done.prepend(emo(STEP_GLYPH.done))
  section.append(done, h('h2', '', N.reviewHead))
  const report = h('div', 'team-final-report'); report.innerHTML = md(run!.final!.report); section.append(report)
  const files = h('div', 'team-final-files'); for (const file of run!.final!.files) { const f = h('div', '', file.path); f.prepend(fileIcon(file.status)); f.title = `${file.status === 'added' ? 'New' : file.status === 'deleted' ? 'Removed' : 'Updated'}: ${file.path}`; files.append(f) } section.append(files)
  const localReviews = run!.tasks.filter(t => t.agent === 'local' && t.status !== 'cancelled').flatMap(t => t.reviews.slice(-1))
  if (run!.tasks.some(t => t.agent === 'local' && t.status !== 'cancelled')) {
    const by = [...new Set(localReviews.map(r => AGENT_NAME[r.by]))].join(' and ') || 'another agent', ok = localReviews.length > 0 && localReviews.every(r => r.verdict === 'pass')
    const line = h('div', `final-verify ${localReviews.length ? (ok ? 'ok' : 'bad') : ''}`); line.append(emo(localReviews.length ? (ok ? STEP_GLYPH.ok : STEP_GLYPH.bad) : STEP_GLYPH.none), h('span', '', localReviews.length ? `${AGENT_NAME.local} work was reviewed by ${by}: ${ok ? 'PASS' : 'FAIL'}` : `${AGENT_NAME.local} work has not been reviewed yet`)); section.append(line)
  }
  const verify = h('div', `final-verify ${run!.final!.verifyOk ? 'ok' : run!.final!.verifyOk === false ? 'bad' : ''}`); verify.append(emo(run!.final!.verifyOk ? STEP_GLYPH.ok : run!.final!.verifyOk === false ? STEP_GLYPH.bad : STEP_GLYPH.none), h('span', '', run!.final!.verifyOk ? 'Project check passed' : run!.final!.verifyOk === false ? 'Project check failed' : 'No project check configured')); section.append(verify)
  if (run!.final!.reviewNotes.length) { const notes = h('details', 'final-review-notes'); notes.append(h('summary', '', `Final review notes · ${run!.final!.reviewNotes.length}`), ...run!.final!.reviewNotes.map(item => h('p', '', item))); section.append(notes) }
  if (undoResult) section.append(h('div', 'errcard final-action-result', undoResult))
  const note = h('p', 'team-final-note', 'Nothing has changed in your project yet. If you don’t land this result, Forge keeps a saved crew copy that you can reopen later.'); section.append(note)
  const actions = h('div', 'team-final-actions')
  const apply = actionButton(N.land, async () => { if (replay) { if (replayScenario === 'applyfail') { undoResult = 'Could not land: your project changed while the crew was working. Review the project and try again.'; renderRun(); return } run!.status = 'done'; run!.applied = true; run!.appliedCheckpoint = 'replay-checkpoint'; toast('Landed · Undo is ready'); renderRun(); return } await call(async () => { const result = await window.forge.teamApply(run!.id); if (!result.ok) { undoResult = result.message; renderRun(); return } toast(result.checkpoint ? `${result.message} · Undo is ready` : result.message, 5000); await refreshRun() }) }, 'primary')
  const reject = actionButton("Don't land", () => { if (replay) { run!.status = 'done'; run!.applied = false; toast('Not landed · Forge kept a saved crew copy'); renderRun(); return } void teamAction(() => window.forge.teamReject(run!.id)) })
  actions.append(apply, reject); section.append(actions); return section
}

function renderApplied() {
  const section = h('section', `team-applied ${run!.undone ? 'undone' : ''}`)
  const tag = h('div', 'eyebrow', run!.undone ? 'Changes undone' : 'Landed in your project'); tag.prepend(emo(run!.undone ? STEP_GLYPH.undone : STEP_GLYPH.done))
  section.append(tag, h('h2', '', run!.undone ? 'Your project is back where it was.' : 'The crew’s work is now in your project.'))
  const copy = run!.undone ? 'The landed files were restored to how they were before the crew.' : 'You can keep working, or undo the whole landing. Undo also removes hand edits made after it.'
  section.append(h('p', '', copy))
  if (undoResult) section.append(h('div', 'team-undo-result', undoResult))
  if (!run!.undone && run!.appliedCheckpoint && typeof window.forge.teamUndo === 'function') section.append(actionButton('Undo the landing', () => void undoApplied()))
  return section
}

async function undoApplied() {
  if (!run) return
  const confirmed = window.confirm('Undo this landing? Every file it changed will go back to how it was before. Hand edits made to those files afterwards will also be undone.')
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
  if (event.type === 'agent' && !laneDetails) {
    const e = event.ev
    if (e.type === 'code' && event.phase !== 'plan') { if (pushCode({ id: e.id, agent: e.agent, path: e.path, text: e.text, kind: e.kind, done: e.done })) return }
    else if (e.type !== 'error' && !(e.type === 'done' && !e.ok)) return // talk, commands and planning stay out of the live view
  }
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
  if (localStorage.getItem('forge.teamReplay')) (window as unknown as { __forgeTeamEmit?: typeof reduceEvent }).__forgeTeamEmit = reduceEvent // lets the replay harness stream fake agent events
  if (typeof window.forge.onTeamFocus === 'function') window.forge.onTeamFocus(id => { showTeam(false); void openRun(id).catch(e => toast(cleanErr(e), 5000)) })
  window.addEventListener('forge-project', (e) => { currentProject = (e as CustomEvent<string | null>).detail ?? '' })
  if (localStorage.getItem('forge.teamReplay') === 'open') { localStorage.setItem('forge.teamReplay', '1'); showTeam() }
}

export function setTeamProject(project: string | null) { currentProject = project ?? ''; window.dispatchEvent(new CustomEvent('forge-project', { detail: project })) }
