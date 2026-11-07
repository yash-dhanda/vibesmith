import { keyCard } from './keyCard'
import { keyLines, splitKeyAnswer } from '../main/keyAnswer'
import type { Run, RunEvent, Task, TeamConfig } from '../main/team/types'
import type { RunSummary, TeamMemory } from '../main/team/service'
import { md, folderName, formatTokens, timeAgo } from './format'
import { fileIcon, icon, type IconName } from './icons'
import { $, cleanErr, h, onOff, toast, uuid, writeClipboard } from './ui'
import { REPLAY_GOAL, replayRun } from './teamReplay'
import { enabledSkillCount } from './skillsPanel'
import { historyButton } from './projectHistory'
import { AGENT_FULL, AGENT_NAME, N } from './names'
import { RUN_MARK, TASK_MARK, TOOL_ICON, mark } from './glyphs'
import { buildStage, pushCode, updateStage, type StageCode } from './teamStage'
import { renderCrewPreview, visualCheckButton } from './crewPreview'
import { renderGitPanel } from './gitPanel'
import { openDiffReview } from './diffReview'
import { renderLandPanel } from './landPanel'
import { openQueue } from './queuePanel'
import { attachVoice } from './voice'
import { renderCrewStats } from './crewStats'
import { openRules } from './rulesPanel'
import { openReferences } from './referencesPanel'
import { attachmentStrip, kindOf, sentChips, uploadCrewFile } from './attachments'
import type { TeamAttachment } from '../main/team/attach'
import { cacheGet, cacheSet, isRemote, onResync, phone, toggleDrawer } from './phone'
import { colorize, mountDiff } from './codeColor'
import { normaliseTeamEventsAsync, reduceTeamView, type LoggedTeamEvent } from './teamReducer'
import { forget, keep, morph, morphChildren } from './morph'

type Logged = LoggedTeamEvent
type Summary = RunSummary
const root = $('team-root')
const app = $('app')
let run: Run | null = null
let log: Logged[] = []
let summaries: Summary[] = []
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let currentProject = ''
// A goal handed over by another screen (ideas, improve, GitHub): the start card opens with it filled in.
let pendingGoal: { goal: string; reviewPlan?: boolean } | null = null
let replay = false
let replayScenario = 'entry'
// Islands: built once per run, then moved into every redraw untouched (morph.ts keep()).
let visual: HTMLElement | null = null, stats: HTMLDetailsElement | null = null, diffHost: HTMLElement | null = null, stageEl: HTMLElement | null = null, stageKey = ''
const resetIslands = () => { forget(); visual = stats = diffHost = stageEl = null; stageKey = '' }
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
// A status as its mark plus its word; `iconOnly` keeps the word for screen readers and the tooltip.
function statusTag(status: Run['status'], iconOnly = false) {
  const tag = h('span', `status-pill ${status}${iconOnly ? ' icon-only' : ''}`)
  tag.append(mark(RUN_MARK[status]))
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
  document.querySelector<HTMLElement>('.crew-pop:popover-open')?.hidePopover() // a chip's popover must not float over Solo
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
  const browse = h('button', 'link-btn team-skills-browse', 'Browse recommended') as HTMLButtonElement; browse.type = 'button'; browse.title = 'Recommended skill repos: open Settings → Skills'; browse.hidden = true
  browse.onclick = () => void import('./settings').then(async m => { await m.openSettings('skills'); for (let i = 0; i < 20 && !document.querySelector('.skill-recs .skill-pack'); i++) await new Promise(r => setTimeout(r, 100)); document.querySelector('.skill-recs')?.scrollIntoView({ block: 'start' }) })
  void enabledSkillCount().then(n => { if (n === null) return; skills.hidden = false; browse.hidden = typeof window.forge.skillsCatalog !== 'function'; skills.replaceChildren(icon('spark', 'sm'), document.createTextNode(`Skills · ${n} on`)) })
  row.append(hint, skills, browse, scan); box.append(row, chips)
  const panel = h('div', 'team-folder-panel'); panel.hidden = true
  const filter = input('search'); filter.placeholder = 'Filter folders'; filter.setAttribute('aria-label', 'Filter folders')
  const list = h('div', 'team-folder-list'); panel.append(filter, list); box.append(panel)
  const apiOk = typeof window.forge.suggestProjects === 'function' && !replay
  const home = (p: string) => p.replace(/^\/home\/[^/]+/, '~')
  const mark = () => { hint.replaceChildren(icon('folder', 'sm'), document.createTextNode(currentProject ? `Working in ${home(currentProject)}` : 'No folder chosen yet. Describe the job, or find a folder.')) }
  const choose = async (path: string) => {
    try { const root = await window.forge.setProject(path); currentProject = root; window.dispatchEvent(new CustomEvent('forge-project-picked', { detail: root })); pill.replaceChildren(icon('folder', 'sm'), document.createTextNode(folderName(root))); pill.title = root; mark(); chips.replaceChildren(); chips.dataset.sig = ''; panel.hidden = true; toast(`Using ${folderName(root)}`) }
    catch (e) { toast(cleanErr(e), 4000) }
  }
  const item = (hit: { path: string; name: string; markers: string[]; mtime: number }, cls = 'team-folder-chip') => {
    const b = h('button', cls) as HTMLButtonElement; b.type = 'button'; b.title = hit.path; b.append(icon('folder', 'sm'), h('strong', '', hit.name), h('span', '', home(hit.path.slice(0, hit.path.length - hit.name.length - 1)))); if (hit.path === currentProject) b.classList.add('on')
    b.onclick = () => void choose(hit.path); return b
  }
  let timer: ReturnType<typeof setTimeout> | null = null, token = 0
  const suggest = () => { if (!apiOk) return; const mine = ++token, q = goal.value.trim(); if (q.length < 4) { chips.replaceChildren(); chips.dataset.sig = ''; return }
    void window.forge.suggestProjects(q).then(hits => { // the chips are redrawn only when the folders change: each redraw replays their staggered rise
      if (mine !== token) return
      const next = hits[0]?.path === currentProject ? [] : hits.filter(x => x.path !== currentProject).slice(0, 4)
      const sig = next.map(x => x.path).join('\n'); if (chips.dataset.sig === sig) return
      chips.dataset.sig = sig; chips.replaceChildren(...next.map(x => item(x)))
    }).catch(() => {}) }
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
  setActiveRun('')
  run = null; log = []; liveFiles.clear(); sharedMemory = null; undoResult = ''; stopClock(); resetIslands()
  root.replaceChildren(h('div', 'team-entry-skeleton skel'))
  const cachedRuns = isRemote() && !localStorage.getItem('forge.teamReplay') ? cacheGet<Summary[]>('runs') : null // the phone shows the runs it saw last while it asks
  if (cachedRuns?.length) { summaries = cachedRuns; const wait = h('div', 'team-entry'); wait.append(h('div', 'team-entry-skeleton skel'), renderRunList()); root.replaceChildren(wait) }
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
  const replaySummary: Summary = { id: 'replay-team-run', goal: REPLAY_GOAL, project: '/tmp/forge-team-replay', status: 'interrupted', createdAt: Date.now() - 3_600_000, updatedAt: Date.now() - 62_000, tasks: { total: 3, done: 1, running: 0, failed: 0 }, pendingApprovals: 0 }
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
  if (isRemote() && !replay) cacheSet('runs', list.slice(0, 30))
  const page = h('div', 'team-entry crew-new')
  const intro = h('section', 'team-intro')
  intro.append(h('h1', '', 'What should the crew build?'))
  const form = h('form', 'team-start-card') as HTMLFormElement
  form.noValidate = true // readConfig checks the numbers itself: it opens More options and focuses the field, which the browser cannot do while it is hidden
  const handed = pendingGoal; pendingGoal = null
  const goal = document.createElement('textarea'); goal.rows = 5; goal.placeholder = 'Describe what the crew should build'; goal.setAttribute('aria-label', 'Crew goal'); if (handed?.goal) { goal.value = handed.goal; requestAnimationFrame(() => { goal.focus(); goal.setSelectionRange(goal.value.length, goal.value.length) }) }
  // Files go to Forge as soon as they are added, so the run only carries their stored locations.
  const att = attachmentStrip({
    host: form, textarea: goal, max: 12, maxBytes: 200 * 1024 * 1024, limits: 'Up to 12 files per run, 200 MB each.',
    note: 'Agents get the file locations and look at pictures and video frames themselves.',
    upload: async (file, progress) => {
      if (replay) return { id: String(file.size), name: file.name, size: file.size, path: `/tmp/forge-replay/${file.name}`, kind: kindOf(file), frames: kindOf(file) === 'video' ? ['/tmp/forge-replay/f1.jpg'] : undefined }
      return uploadCrewFile(file, progress)
    },
    onChange: () => { start.disabled = !ready.length || att.busy(); start.title = att.busy() ? 'Waiting for the files to finish uploading' : '' },
  })
  const project = h('button', 'pill team-project') as HTMLButtonElement; project.type = 'button'; project.append(icon('folder', 'sm'), document.createTextNode(currentProject ? folderName(currentProject) : 'Choose folder')); project.title = currentProject || 'Choose the project folder'
  project.onclick = () => $('project').click()
  project.hidden = isRemote() // the folder dialog opens on the computer; Find folder works everywhere
  // Everything past the agents and the two toggles waits behind "More options", which opens in the card.
  const advanced = h('div', 'team-advanced'); advanced.id = 'crew-more'; advanced.hidden = true
  const more = h('button', 'link-btn crew-more') as HTMLButtonElement; more.type = 'button'; more.append(icon('sliders', 'sm'), document.createTextNode(N.moreOptions), icon('down', 'sm'))
  more.setAttribute('aria-controls', advanced.id); more.setAttribute('aria-expanded', 'false')
  const showMore = (open: boolean) => { advanced.hidden = !open; more.setAttribute('aria-expanded', String(open)) }
  more.onclick = () => showMore(more.getAttribute('aria-expanded') !== 'true')
  const planner = select([['auto', 'Choose for me'], ['claude', 'Claude'], ['codex', 'Codex'], ['local', AGENT_NAME.local]], defaults.planner ?? 'auto')
  const parallel = input('number', String(defaults.maxParallelPerAgent ?? 2)); parallel.min = '1'; parallel.max = '4'
  const review = select([['cross', 'Cross-review every task'], ['off', 'No cross-review']], defaults.review ?? 'cross')
  const finalReview = select([['auto', 'Automatic (bigger runs only)'], ['true', 'Always check the combined result'], ['false', 'Skip the final review']], String(defaults.finalReview ?? 'auto'))
  const permissions = select([['bypass', 'Never ask me (bypass)'], ['ask', 'Ask before risky actions']], defaults.bypassPermissions === false ? 'ask' : 'bypass')
  const reviewPlan = select([['false', 'Start right away'], ['true', 'Let me review the plan first']], String(handed?.reviewPlan ?? defaults.reviewPlan ?? false))
  const fixRounds = input('number', String(defaults.maxFixRounds ?? 3)); fixRounds.min = '0'; fixRounds.max = '5'
  const codexMode = select([['app-server', 'Live Codex session'], ['exec', 'Simple Codex run']], defaults.codexMode ?? 'app-server')
  const verify = input('text', defaults.verify === null ? '' : defaults.verify ?? ''); verify.placeholder = 'Detect from project'
  const codexModel = select(health.codexModels.map(m => [m, m] as [string, string]), defaults.codexModel ?? health.codexModels[0] ?? ''); codexModel.setAttribute('aria-label', 'Codex model')
  const localModel = select(health.localModels.map(m => [m, m] as [string, string]), defaults.localModel ?? health.localModels[0] ?? ''); localModel.setAttribute('aria-label', `${AGENT_NAME.local} model`)
  const claudeModels: [string, string][] = [['', 'Default'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1']]
  if (defaults.claudeModel && !claudeModels.some(([v]) => v === defaults.claudeModel)) claudeModels.push([defaults.claudeModel, defaults.claudeModel])
  const claudeModel = select(claudeModels, defaults.claudeModel ?? ''); claudeModel.setAttribute('aria-label', 'Claude model')
  const codexEffort = select([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']], defaults.codexEffort ?? 'high'); codexEffort.setAttribute('aria-label', 'Codex reasoning effort')
  const effort = select([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Maximum']], defaults.claudeEffort ?? 'high'); effort.setAttribute('aria-label', 'Claude effort')
  const minutes = input('number', ''); minutes.min = '1'; minutes.placeholder = 'No limit'
  const tokens = input('number', ''); tokens.min = '1000'; tokens.step = '1000'; tokens.placeholder = 'No limit'
  const runs = input('number', ''); runs.min = '1'; runs.placeholder = 'No limit'
  const maxTasks = input('number', String(defaults.budget?.maxTasks ?? 12)); maxTasks.min = '1'; maxTasks.max = '30'
  const limit = input('number', String(defaults.maxLimitPercent ?? 0)); limit.min = '0'; limit.max = '100'
  // Questions and web research are two small Off | On toggles; what they mean is in the tooltip.
  const toggle = (label: string, on: boolean, hint: string) => {
    let value = on
    const pair = onOff(on, v => { value = v }); pair.setAttribute('aria-label', label)
    const row = h('div', 'crew-toggle'); row.title = hint; row.append(h('span', '', label), pair)
    return { row, on: () => value, set: (v: boolean) => (pair.children[v ? 1 : 0] as HTMLButtonElement).click() }
  }
  const ask = toggle('Ask me when unsure', defaults.askQuestions !== false, 'Questions: agents can stop and ask you when they are really unsure.')
  const web = toggle('Web research', defaults.webResearch !== false, 'Agents may search the web and read pages for docs, APIs and versions.')
  const grid = h('div', 'team-config-grid')
  grid.append(field('Planner', planner, 'Chooses who splits the goal into tasks.'), field('Parallel tasks per agent', parallel, 'More tasks can finish sooner, but use more allowance.'), field('Task review', review, `Work by ${AGENT_NAME.local} is always checked by another agent.`), field('Final review', finalReview, 'Automatic checks the whole result only for runs of 3 or more tasks, which saves plan usage.'), field('Permissions', permissions, 'Bypass lets the agents run commands and read files without asking. They still cannot push to git, use sudo, or write outside their own task folder.'), field('Plan approval', reviewPlan, 'Stops after planning so you can edit, reassign or skip tasks before any agent works.'), field('Fix attempts per task', fixRounds), field('Project check', verify, 'Leave blank to detect it from the project.'), field('Codex connection', codexMode, 'Live sessions support streaming and immediate steering.'), field('Time limit (minutes)', minutes, 'Empty means no limit.'), field('Token limit', tokens, 'Empty means no limit.'), field('Agent runs limit', runs, 'Empty means no limit.'), field('Maximum tasks', maxTasks), field('Pause at plan usage %', limit, '0 disables this limit.'))
  const validation = h('div', 'team-config-error'); validation.setAttribute('role', 'alert')
  const numeric = [parallel, fixRounds, minutes, tokens, runs, maxTasks, limit]
  const readConfig = (): Partial<TeamConfig> | null => {
    if (numeric.some(item => !item.checkValidity() || !Number.isFinite(Number(item.value)))) { showMore(true); validation.textContent = 'Check the highlighted crew settings.'; numeric.find(item => !item.checkValidity())?.focus(); return null }
    validation.textContent = ''
    return { askQuestions: ask.on(), webResearch: web.on(), planner: planner.value as TeamConfig['planner'], maxParallelPerAgent: Number(parallel.value), review: review.value as TeamConfig['review'], finalReview: finalReview.value === 'auto' ? 'auto' : finalReview.value === 'true', reviewPlan: reviewPlan.value === 'true', bypassPermissions: permissions.value === 'bypass', maxFixRounds: Number(fixRounds.value), codexMode: codexMode.value as TeamConfig['codexMode'], verify: verify.value.trim() || undefined, codexModel: codexModel.value, localModel: localModel.value || undefined, claudeModel: claudeModel.value.trim() || undefined, claudeEffort: effort.value as TeamConfig['claudeEffort'], codexEffort: codexEffort.value as TeamConfig['codexEffort'], maxLimitPercent: Number(limit.value), budget: { maxMinutes: Number(minutes.value) || undefined, maxTokens: Number(tokens.value) || undefined, maxAgentRuns: Number(runs.value) || undefined, maxTasks: Number(maxTasks.value) } }
  }
  const reset = h('button', 'btn', 'Reset defaults') as HTMLButtonElement; reset.type = 'button'; reset.onclick = () => { ask.set(true); web.set(true); planner.value = 'auto'; parallel.value = '2'; review.value = 'cross'; finalReview.value = 'auto'; reviewPlan.value = 'false'; permissions.value = 'bypass'; fixRounds.value = '3'; verify.value = ''; codexMode.value = 'app-server'; claudeModel.value = ''; effort.value = 'high'; codexEffort.value = 'high'; minutes.value = ''; tokens.value = ''; runs.value = ''; maxTasks.value = '12'; limit.value = '0'; paintChips(); validation.textContent = 'Defaults restored. They will save when you start a run.' }
  const saveDefaults = h('button', 'btn', 'Save defaults') as HTMLButtonElement; saveDefaults.type = 'button'; saveDefaults.onclick = () => void call(async () => { const config = readConfig(); if (!config || typeof window.forge.teamSettingsSet !== 'function') return; await window.forge.teamSettingsSet(config); validation.textContent = 'Crew defaults saved for this project.' })
  const settingActions = h('div', 'team-setting-actions'); settingActions.append(reset, saveDefaults)
  advanced.append(grid, validation, settingActions)
  // Readiness and the plan allowance: one muted line under the card. A missing agent shows its fix command.
  const healthBox = h('div', 'team-health')
  for (const agent of health.agents) {
    const row = h('span', `health-row ${agent.ok ? 'ready' : 'missing'}`)
    row.append(h('span', `agent-orb ${agent.agent}`), h('strong', '', AGENT_FULL[agent.agent]), h('span', '', agent.detail))
    if (!agent.ok && 'fix' in agent && agent.fix) row.append(h('code', '', agent.fix))
    healthBox.append(row)
  }
  const allowance = health.limits?.codex
  if (allowance) {
    const worst = Math.max(allowance.primaryPct, allowance.secondaryPct ?? 0), resets = allowance.primaryResetsAt ? new Date(allowance.primaryResetsAt * (allowance.primaryResetsAt < 1e12 ? 1000 : 1)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    const meter = h('span', `health-allowance ${worst >= 80 ? 'high' : ''}`, `ChatGPT plan ${Math.round(allowance.primaryPct)}% used${resets ? ` · resets ${resets}` : ''}${allowance.secondaryPct !== undefined ? ` · ${Math.round(allowance.secondaryPct)}% of the week` : ''}`)
    meter.title = `ChatGPT plan: ${Math.round(allowance.primaryPct)}% of this window used`
    if (worst >= 80) meter.append(h('small', '', 'Codex may be left out of new runs until the allowance resets.'))
    healthBox.append(meter)
  }
  const ready = health.agents.filter(a => a.ok)
  const startLabel = ready.length ? (ready.length > 1 ? N.sendCrew : `Send ${AGENT_NAME[ready[0].agent]}`) : 'No agent is ready'
  const start = h('button', 'btn primary team-start', startLabel) as HTMLButtonElement
  start.disabled = !ready.length
  const diagnostics = h('button', 'icon-btn') as HTMLButtonElement; diagnostics.type = 'button'; diagnostics.append(icon('info')); diagnostics.setAttribute('aria-label', 'Copy diagnostics'); diagnostics.title = 'Copy diagnostics: versions, agent status and recent runs for a bug report. No secrets or file contents.'
  diagnostics.onclick = () => void call(async () => { const text = replay ? 'Forge replay diagnostics' : await window.forge.teamDiagnostics(); await writeClipboard(text); toast('Diagnostics copied') })
  const actions = h('div', 'team-start-actions'); const queueBtn = h('button', 'pill') as HTMLButtonElement; queueBtn.type = 'button'; queueBtn.append(icon('list', 'sm'), document.createTextNode('Queue')); queueBtn.title = 'Line up several goals and run them one after another, for example overnight'; queueBtn.onclick = () => void openQueue(); queueBtn.hidden = isRemote() || replay
  const toolbarGrow = h('span', 'grow')
  const moreTools = h('div', 'crew-more-tools')
  moreTools.append(ask.row, web.row, diagnostics, historyButton(), queueBtn)
  advanced.prepend(moreTools)
  actions.append(att.button, att.input, attachVoice(goal, form), project, toolbarGrow, start)
  // The agents as one row of chips ("Claude · Default · High"); a chip opens its model and effort selects in a popover.
  // The popover closes on Escape (focus goes back to its chip) or a click outside.
  const agentsBox = h('div', 'crew-agents'); agentsBox.setAttribute('role', 'group'); agentsBox.setAttribute('aria-label', 'Models and effort')
  const paints: (() => void)[] = []
  const paintChips = () => paints.forEach(paint => paint())
  const readyAgents = new Set(health.agents.filter(a => a.ok).map(a => a.agent))
  const agentChip = (agent: 'claude' | 'codex' | 'local', model: HTMLSelectElement, effortSel?: HTMLSelectElement) => {
    const chip = h('button', `crew-chip ${agent}`) as HTMLButtonElement; chip.type = 'button'
    const words = h('span', 'crew-chip-words')
    const shown = (s: HTMLSelectElement) => s.selectedOptions[0]?.text ?? ''
    paints.push(() => { words.textContent = [AGENT_NAME[agent], shown(model), effortSel ? shown(effortSel) : ''].filter(Boolean).join(' · ') })
    chip.append(h('span', `agent-orb ${agent}`), words, icon('down', 'sm'))
    const pop = h('div', 'crew-pop'); pop.id = `crew-pop-${agent}`; pop.setAttribute('popover', 'auto'); pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', `${AGENT_FULL[agent]} ${effortSel ? 'model and effort' : 'model'}`)
    chip.setAttribute('popovertarget', pop.id); chip.style.setProperty('anchor-name', `--crew-${agent}`); pop.style.setProperty('position-anchor', `--crew-${agent}`)
    const status = health.agents.find(a => a.agent === agent)
    const head = h('div', 'crew-pop-head'); head.append(h('span', `agent-orb ${agent}`), h('strong', '', AGENT_FULL[agent]), h('span', '', status?.detail ?? ''))
    const row = (label: string, control: HTMLSelectElement) => { const l = h('label', 'crew-pop-field'); l.append(h('span', '', label), control); control.onchange = paintChips; return l }
    pop.append(head, row('Model', model)); if (effortSel) pop.append(row('Effort', effortSel))
    model.autofocus = true // opening the popover puts the keyboard on its first select
    pop.addEventListener('toggle', () => chip.classList.toggle('on', pop.matches(':popover-open')))
    chip.title = `${AGENT_FULL[agent]}${status ? `: ${status.detail.replace(/\.$/, '')}` : ''}. Choose the model${effortSel ? ' and effort' : ''}.`
    if (!readyAgents.has(agent) && !replay) chip.classList.add('off')
    agentsBox.append(chip, pop)
  }
  agentChip('claude', claudeModel, effort); agentChip('codex', codexModel, codexEffort)
  if (health.localModels.length) agentChip('local', localModel)
  paintChips()
  agentsBox.addEventListener('keydown', e => { // Escape here must not also reach the window (it stops a running Solo agent)
    const open = agentsBox.querySelector<HTMLElement>('.crew-pop:popover-open'); if (e.key !== 'Escape' || !open) return
    e.preventDefault(); e.stopPropagation(); open.hidePopover(); agentsBox.querySelector<HTMLElement>(`[popovertarget="${open.id}"]`)?.focus()
  })
  more.classList.add('crew-options-btn')
  actions.insertBefore(agentsBox, toolbarGrow); actions.insertBefore(more, toolbarGrow)
  form.classList.toggle('has-folder', !!currentProject)
  form.append(goal, att.strip, folderFinder(goal, project), actions, advanced)
  form.onsubmit = async e => {
    e.preventDefault(); const text = goal.value.trim(); if (!text || start.disabled || att.busy()) return
    const config = readConfig(); if (!config) return
    const files = att.ready() as TeamAttachment[]
    start.disabled = true; start.replaceChildren('Sending the crew…')
    if (replay) { const fixture = replayRun('planning'); await openRun(fixture.run.id, fixture); return }
    try { if (typeof window.forge.teamSettingsSet === 'function') await window.forge.teamSettingsSet(config); const started = await window.forge.teamStart(text, files.length ? { ...config, attachments: files } : config); await openRun(started.id) }
    catch (err) { start.disabled = false; start.replaceChildren(startLabel); toast(cleanErr(err), 6000) }
  }
  const allReady = health.agents.every(a => a.ok) && !(allowance && Math.max(allowance.primaryPct, allowance.secondaryPct ?? 0) >= 80)
  healthBox.hidden = allReady
  intro.append(form, healthBox); page.append(intro)
  // Earlier runs live in the sidebar; this page is for a new one. The full list is one click away, closed by default.
  if (isRemote() || !list.length) page.append(renderRunList())
  else {
    const all = h('button', 'link-btn crew-allruns', `All runs (${list.length})`) as HTMLButtonElement; all.type = 'button'
    const wrap = h('div', 'team-runs-wrap'); wrap.hidden = true
    all.onclick = () => { if (wrap.hidden) wrap.replaceChildren(renderRunList()); wrap.hidden = !wrap.hidden; all.setAttribute('aria-expanded', String(!wrap.hidden)) }
    page.append(all, wrap)
  }
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
  const section = h('section', `team-runs ${phone.matches ? 'grid' : runView}`) // a phone shows runs as cards
  // Patched in place, so the search keeps its focus and caret. Handlers reach their fields through the event: a redraw copies them onto the live ones.
  const redraw = () => { const live = document.querySelector<HTMLElement>('.team-runs'); if (live) morph(live, renderRunList()) }
  const head = h('div', 'page-head'); const title = h('h2', 'page-title', N.recentRuns); title.append(h('span', 'page-count', String(summaries.length))); head.append(title, h('span', 'grow'))
  const tools = h('div', 'head-tools')
  const view = h('div', 'view-toggle'); view.setAttribute('role', 'group'); view.setAttribute('aria-label', 'Layout')
  for (const [v, glyph, label] of [['grid', 'grid', 'Grid'], ['list', 'list', 'List']] as const) {
    const b = h('button', `icon-btn sm${runView === v ? ' on' : ''}`); b.append(icon(glyph, 'sm')); b.title = `${label} view`; b.setAttribute('aria-label', `${label} view`); b.setAttribute('aria-pressed', String(runView === v))
    b.onclick = () => { runView = v; try { localStorage.setItem('forge.teamRunView', v) } catch {} redraw() }; view.append(b)
  }
  const filter = select([['all', 'All runs'], ['active', 'In progress'], ['attention', 'Needs attention'], ['done', 'Finished']], runFilter); filter.onchange = e => { runFilter = (e.currentTarget as HTMLSelectElement).value; redraw() }
  const sort = select([['opened', 'Last opened'], ['created', 'Created'], ['goal', 'Goal A-Z']], runSort); sort.onchange = e => { runSort = (e.currentTarget as HTMLSelectElement).value; redraw() }
  const searchWrap = h('div', `head-search${runSearchOpen || runSearch ? ' open' : ''}`)
  const search = input('search', runSearch); search.placeholder = 'Search goals'; search.setAttribute('aria-label', 'Search crew runs')
  const searchBtn = h('button', 'icon-btn sm'); searchBtn.append(icon('search', 'sm')); searchBtn.title = 'Search runs'; searchBtn.setAttribute('aria-label', 'Search runs')
  searchBtn.onclick = e => { runSearchOpen = true; const w = (e.currentTarget as HTMLElement).parentElement!; w.classList.add('open'); w.querySelector('input')!.focus() }
  search.onblur = e => { const f = e.currentTarget as HTMLInputElement; if (!f.value) { runSearchOpen = false; f.parentElement!.classList.remove('open') } }
  search.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); (e.currentTarget as HTMLInputElement).value = ''; runSearch = ''; runSearchOpen = false; redraw() } }
  search.oninput = e => { runSearch = (e.currentTarget as HTMLInputElement).value; runSearchOpen = true; redraw() }
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
    const row = h('article', 'run-row'); row.setAttribute('role', 'row'); row.dataset.key = item.id; enter(row, `row:${item.id}`, index)
    const open = h('button', 'run-open run-cols'); open.setAttribute('aria-label', `Open ${item.goal}`); open.onclick = () => void (replay ? openRun(item.id, replayRun('interrupted')) : openRun(item.id))
    const count = h('span', 'c-tasks', `${item.tasks.done}/${item.tasks.total}`); count.title = `${item.tasks.done} of ${item.tasks.total} tasks done`
    const where = h('span', 'c-project', folderName(item.project)); where.title = item.project
    const when = h('span', 'c-when', timeAgo(item.updatedAt)); when.title = new Date(item.updatedAt).toLocaleString()
    const status = h('span', 'c-status'); status.append(statusTag(item.status))
    open.append(h('strong', 'c-goal', item.goal), status, where, count, when)
    const acts = h('span', 'run-acts')
    if (typeof window.forge.teamExportReport === 'function' && !isRemote() && ['awaiting_approval', 'done'].includes(item.status)) { const exportButton = h('button', 'icon-btn sm'); exportButton.append(icon('download', 'sm')); exportButton.title = 'Export report'; exportButton.setAttribute('aria-label', `Export report for ${item.goal}`); exportButton.onclick = () => void call(() => window.forge.teamExportReport(item.id)); acts.append(exportButton) }
    if (typeof window.forge.teamDelete === 'function' && !['planning', 'running', 'verifying', 'paused', 'interrupted'].includes(item.status)) {
      const del = h('button', 'icon-btn sm'); del.append(icon('trash', 'sm')); del.title = 'Delete run'; del.setAttribute('aria-label', `Delete ${item.goal}`)
      del.onclick = () => void call(async () => { if (!window.confirm(`Delete this run?\n\n${item.goal}\n\nIts saved report and unfinished crew work will be removed.`)) return; if (await window.forge.teamDelete(item.id)) { summaries = summaries.filter(x => x.id !== item.id); redraw() } })
      acts.append(del)
    }
    row.append(open, acts); table.append(row)
  }
  return section
}

// The sidebar marks the run that is open (and the chat list redraws) through this.
function setActiveRun(id: string) { if (id) app.dataset.crewRun = id; else delete app.dataset.crewRun; window.dispatchEvent(new Event('forge-crew-changed')) }
async function openRun(id: string, fixture?: { run: Run; events: Logged[]; memory?: TeamMemory }) {
  setActiveRun(fixture ? '' : id)
  root.replaceChildren(h('div', 'team-run-loading skel'))
  const loaded = fixture ?? await (async () => { const [saved, events] = await Promise.all([window.forge.teamGet(id), window.forge.teamEvents(id)]); if (!saved) throw new Error('This run no longer exists.'); return { run: saved, events } })()
  run = structuredClone(loaded.run); sharedMemory = fixture?.memory ?? null; undoResult = ''; crewOpen = false; resetIslands()
  const normal = await normaliseTeamEventsAsync(loaded.events); log = normal.log; liveFiles = normal.liveFiles
  if (!['planning', 'running', 'paused', 'interrupted'].includes(run.status)) liveFiles.clear()
  renderRun(); startClock()
  if (!fixture) void refreshMemory()
}

function startClock() { stopClock(); elapsedTimer = setInterval(() => { const el = document.getElementById('team-elapsed'); if (el && run) el.textContent = fmtTime(Math.floor((Date.now() - run.createdAt) / 1000)) }, 1000) }
function stopClock() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null }

// ---------------------------------------------------------------- the run page, built like a chat
// What you sent on the right, what the crew did on the left as a few plain lines, the model switches under the message box,
// and the crew's own tasks, live code and chatter behind one closed "Crew activity" fold in the side panel.
const AUTO_TASK = /^(Fix failing checks|Fix problems from|Write or extend tests)/
const promptsOf = () => (run!.prompts?.length ? run!.prompts : [{ id: 'p1', text: run!.goal, at: run!.createdAt }])
const isWorking = () => ['planning', 'running', 'verifying'].includes(run!.status)
let crewOpen = false
const openSteps = new Set<string>()
const taskState = (t: Task) => ({ done: 'Done', running: 'Working', queued: 'Waiting', failed: 'Failed', blocked: 'Blocked', paused: 'Paused' } as Record<string, string>)[t.status] ?? t.status

function renderRun() {
  if (!run) return
  const stick = root.scrollHeight - root.scrollTop - root.clientHeight < 24 // only a page already at its end follows new content (140 px exceeded the page's whole 37 px range)
  const tails = [...root.querySelectorAll<HTMLElement>('.lane-body')].filter(b => b.scrollHeight - b.scrollTop - b.clientHeight < 36) // Details lanes that follow their newest line
  const page = h('div', 'team-run crew-claude'); page.dataset.key = run.id // another run is another page and fades in (crew.css:11); the same run is patched in place
  page.append(renderRunHeader())
  const cols = h('div', 'crew-cols'); const main = h('div', 'crew-main')
  if ((run.pausedReason || run.status === 'interrupted') && !run.approvals.some(a => a.kind === 'plan' && a.status === 'pending')) main.append(renderPauseBanner())
  const pending = run.approvals.filter(a => a.status === 'pending')
  if (pending.length) main.append(renderApprovals(pending))
  const answered = renderAnswered(); if (answered) main.append(answered)
  main.append(renderThread())
  if (run.status === 'awaiting_approval' && run.final) main.append(renderFinal())
  if (run.status === 'done' && run.applied) main.append(renderApplied())
  main.append(keep('steer', renderSteer())) // the message box never leaves the page: focus, caret, draft, uploads and an open picker survive
  cols.append(main, renderSidePanel()); page.append(cols)
  const next = h('div'); next.append(page); morphChildren(root, next)
  if (stick) root.scrollTop = root.scrollHeight
  for (const b of tails) b.scrollTop = b.scrollHeight
}

function renderThread() {
  const thread = h('section', 'crew-thread'); thread.setAttribute('aria-label', 'Conversation'); thread.dataset.key = 'thread'
  const list = promptsOf()
  list.forEach((p, i) => {
    const me = h('article', 'crew-me'); me.dataset.key = `me:${p.id}`; me.append(h('p', '', p.text.length > 1800 ? `${p.text.slice(0, 1800)}…` : p.text))
    const sent = i === 0 ? run!.config?.attachments ?? [] : []
    if (sent.length) me.append(sentChips(sent))
    thread.append(me, renderReply(p, i === list.length - 1))
  })
  return thread
}

// One reply per request: a single line of what is going on, the plain results, and the work itself behind a closed fold.
function renderReply(p: { id: string }, last: boolean) {
  const first = promptsOf()[0].id
  const mine = run!.tasks.filter(t => (t.promptId ?? first) === p.id && t.status !== 'cancelled' && !AUTO_TASK.test(t.title))
  const done = mine.filter(t => t.status === 'done').length
  const busy = last && isWorking()
  const box = h('div', 'crew-reply'); box.dataset.key = `re:${p.id}`
  const head = h('div', `crew-reply-head${busy ? ' busy' : ''}`)
  if (busy) head.append(h('span', 'crew-dots'))
  const line = busy
    ? (run!.status === 'planning' && !mine.length ? 'Planning the work…' : latestActivity() ?? (mine.length ? `Working on ${mine.length - done} of ${mine.length} tasks` : 'Reading your message…'))
    : mine.length ? `${done} of ${mine.length} task${mine.length === 1 ? '' : 's'} done` : last && ['awaiting_approval', 'done'].includes(run!.status) ? 'Finished' : last && isActive(run!.status) ? 'Reading your message…' : ''
  if (line) head.append(h('span', 'crew-reply-line', line))
  const agents = [...new Set(mine.map(t => t.agent))]
  for (const a of agents) head.append(h('span', `agent-orb ${a}`))
  box.append(head)
  if (mine.length) {
    const steps = h('div', 'crew-steps')
    for (const t of mine) { const row = h('div', `crew-step ${t.status}`); row.append(h('span', `agent-orb ${t.agent}`), h('span', 'crew-step-title', oneLine(t.title, 110)), h('span', 'crew-step-state', taskState(t))); steps.append(row) }
    box.append(fold(`Show the work (${mine.length})`, openSteps.has(p.id), o => { if (o) openSteps.add(p.id); else openSteps.delete(p.id) }, () => [steps]))
  }
  const said = mine.filter(t => t.status === 'done' && t.summary?.trim()).slice(0, 5)
  if (said.length) { const ul = h('ul', 'crew-said'); for (const t of said) ul.append(h('li', '', oneLine(t.summary!, 280))); box.append(ul) }
  const keys = last ? liveKeys() : []
  if (keys.length) box.append(keyCard(keys))
  return box
}

function renderSidePanel() {
  const side = h('aside', 'crew-side'); side.setAttribute('aria-label', 'Run details')
  const sec = (title: string, ...kids: HTMLElement[]) => { const el = h('section', 'crew-side-sec'); el.append(h('h3', '', title), ...kids); return el }
  const row = (glyph: IconName, text: string, title = '') => { const r = h('div', 'crew-side-row'); r.append(icon(glyph, 'sm'), h('span', '', text)); if (title) r.title = title; return r }
  side.append(sec('Project', row('folder', folderName(run!.project), run!.project), row('code', run!.integrationBranch.replace(/^forge\//, 'forge/').slice(0, 42), run!.integrationBranch)))
  const agents = h('div', 'crew-side-agents')
  for (const agent of ['claude', 'codex', 'local'] as const) {
    const u = run!.usage[agent]; const model = agent === 'claude' ? run!.config.claudeModel || 'default' : agent === 'codex' ? run!.config.codexModel : run!.config.localModel
    if (!u?.runs && !(agent === 'local' && run!.config.localModel)) continue
    const r = h('div', 'crew-side-agent'); r.dataset.key = agent; r.append(h('span', `agent-orb ${agent}`), h('strong', '', AGENT_NAME[agent]), h('span', 'crew-side-model', model || ''), h('span', 'crew-side-tokens', u ? `${formatTokens(u.input + u.output)}${u.costUsd > 0 ? ` · ~$${u.costUsd.toFixed(2)}` : ''}` : ''))
    r.title = `${AGENT_NAME[agent]}${model ? ` (${model})` : ''}: ${((u?.input ?? 0) + (u?.output ?? 0)).toLocaleString()} tokens`
    agents.append(r)
  }
  side.append(sec('Models and usage', agents))
  const files = new Map<string, { a: number; r: number }>()
  for (const t of run!.tasks) for (const f of t.changed ?? []) { const c = files.get(f.path) ?? { a: 0, r: 0 }; c.a += (f as { added?: number }).added ?? 0; c.r += (f as { removed?: number }).removed ?? 0; files.set(f.path, c) }
  const added = [...files.values()].reduce((n, f) => n + f.a, 0), removed = [...files.values()].reduce((n, f) => n + f.r, 0)
  const changes = h('div', 'crew-side-changes'); changes.append(h('div', 'crew-side-count', `${files.size} file${files.size === 1 ? '' : 's'}`), h('span', 'crew-add', `+${added}`), h('span', 'crew-del', `−${removed}`))
  const list = h('div', 'crew-side-files'); for (const path of [...files.keys()].slice(0, 8)) { const f = h('div', 'crew-side-file', path.split('/').slice(-2).join('/')); f.title = path; f.dataset.key = path; list.append(f) }
  if (files.size > 8) list.append(h('div', 'crew-side-more', `and ${files.size - 8} more`))
  side.append(sec('Changes', files.size ? changes : h('p', 'crew-side-none', 'Nothing yet'), list))
  const activity = () => {
    const inner = h('div', 'crew-activity')
    // renderCrewPreview keeps one preview per run itself, and builds a new one after letting go of one that was off the page
    if (!isRemote() && run!.tasks.some(t => t.status === 'done')) { const tools = h('div', 'team-tools-row'); tools.append(keep('preview', renderCrewPreview(run!.id)), keep('visual', visual ??= visualCheckButton(run!.id))); inner.append(tools) }
    inner.append(renderBoard(), fold('Live work', liveOpen, o => { liveOpen = o }, () => [renderLanes()]), fold('Team activity and changes', activityOpen, o => { activityOpen = o }, () => { const aside = h('aside', 'team-side-story'); aside.append(renderLiveFiles(), renderFeed(), renderBackground(), renderDiffPanel()); return [aside] }), keep('stats', stats ??= renderCrewStats(run!.id)))
    return [inner]
  }
  side.append(fold('Crew activity', crewOpen, o => { crewOpen = o }, activity))
  return side
}

// The header is one line: back, what this run is, where, how it is going, and the run's own buttons.
function renderRunHeader() {
  const header = h('header', 'crew-head')
  const back = h('button', 'icon-btn back'); back.append(icon('arrowleft')); back.title = `All ${N.crewRuns.toLowerCase()}`; back.setAttribute('aria-label', back.title); back.onclick = () => void showEntry()
  const asking = run!.approvals.some(a => a.kind === 'question' && a.status === 'pending')
  const status = asking ? h('span', 'status-pill awaiting_approval asking') : statusTag(run!.status); if (asking) status.append(mark('ask'), N.waiting); status.setAttribute('role', 'status')
  const elapsed = h('span', 'team-elapsed', fmtTime(Math.floor((Date.now() - run!.createdAt) / 1000))); elapsed.id = 'team-elapsed'
  const title = h('h1', 'crew-title', oneLine(run!.goal, 100)); title.title = run!.goal
  const where = h('span', 'crew-where', folderName(run!.project)); where.prepend(icon('folder', 'sm')); where.title = run!.project
  const meta = h('div', 'crew-head-meta'); meta.append(where, status, elapsed)
  const main = h('div', 'crew-head-main'); main.append(title, meta)
  const controls = h('div', 'team-controls')
  controls.append(historyButton(run!.id))
  if (typeof window.forge.teamRunApp === 'function' && run!.tasks.some(t => t.status === 'done')) controls.append(actionButton('Run website', () => void call(async () => { toast('Starting the website…', 2500); const r = await window.forge.teamRunApp(run!.id); toast(r.message, 12000); await refreshRun() }), '', 'globe'))
  const planPending = run!.approvals.some(a => a.kind === 'plan' && a.status === 'pending')
  if (planPending) { /* the plan card starts the team */ }
  else if (['paused', 'interrupted'].includes(run!.status)) controls.append(actionButton('Resume', () => teamAction(() => window.forge.teamResume(run!.id))))
  else if (['planning', 'running', 'verifying'].includes(run!.status)) controls.append(pauseButton())
  if (isActive(run!.status) && run!.status !== 'awaiting_approval') controls.append(actionButton('Cancel run', () => teamAction(() => window.forge.teamCancel(run!.id)), 'danger', 'x'))
  if (run!.final && typeof window.forge.teamExportReport === 'function' && !isRemote()) controls.append(actionButton('Export report', () => call(() => window.forge.teamExportReport(run!.id)), '', 'download'))
  header.append(back, main, controls)
  return header
}

// ---- the switches under the message box: models, effort, permissions and speed, changeable while the crew works
const CLAUDE_MODEL_CHOICES: [string, string][] = [['', 'Default'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1']]
const EFFORT_CHOICES: [string, string][] = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Maximum']]
let healthCache: { codexModels: string[]; localModels: string[] } | null = null
let picker: HTMLElement | null = null
const closePicker = () => { picker?.remove(); picker = null }
async function crewHealth() {
  if (!healthCache) { try { const hl = await window.forge.teamHealth(); healthCache = { codexModels: hl.codexModels, localModels: hl.localModels } } catch { healthCache = { codexModels: [], localModels: [] } } }
  return healthCache
}
function openPicker(anchor: HTMLElement, groups: { title: string; options: [string, string][]; current: string; pick: (v: string) => void }[]) {
  const again = !!picker?.isConnected && picker.dataset.anchor === anchor.dataset.chip; closePicker(); if (again) return
  const pop = h('div', 'cw-pop'); pop.dataset.anchor = anchor.dataset.chip ?? ''; pop.setAttribute('data-transient', '')
  for (const g of groups) {
    pop.append(h('div', 'cw-pop-title', g.title))
    for (const [v, label] of g.options) { const b = h('button', `cw-pop-item${v === g.current ? ' on' : ''}`, label) as HTMLButtonElement; b.type = 'button'; b.onclick = () => { closePicker(); g.pick(v) }; pop.append(b) }
  }
  pop.style.left = `${anchor.offsetLeft}px`; anchor.parentElement!.append(pop); picker = pop
  const away = (e: MouseEvent) => { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) { closePicker(); document.removeEventListener('mousedown', away) } }
  setTimeout(() => document.addEventListener('mousedown', away), 0)
}
const setCfg = (patch: { claudeModel?: string; codexModel?: string; localModel?: string; claudeEffort?: string; codexEffort?: string; bypassPermissions?: boolean }) => { if (replay) return toast('Replay mode: action recorded'); void teamAction(() => window.forge.teamSetModels(run!.id, patch)) }
function composerChips(): HTMLElement[] {
  if (typeof window.forge.teamSetModels !== 'function') return []
  const c = run!.config
  const chip = (key: string, label: string, title: string, on: (b: HTMLButtonElement) => void, cls = '', glyph?: IconName) => {
    const b = h('button', `cw-chip ${cls}`) as HTMLButtonElement; b.type = 'button'; b.title = title; b.dataset.chip = key; b.dataset.key = key
    if (glyph) b.append(icon(glyph, 'sm'))
    b.append(document.createTextNode(label)); b.onclick = e => on(e.currentTarget as HTMLButtonElement); return b
  }
  const name = (m: string | undefined) => CLAUDE_MODEL_CHOICES.find(([v]) => v === (m ?? ''))?.[1] ?? m ?? 'Default'
  const effort = (e: string | undefined) => EFFORT_CHOICES.find(([v]) => v === (e ?? 'high'))?.[1] ?? 'High'
  const out: HTMLElement[] = []
  out.push(chip('claude', `Claude ${name(c.claudeModel)} · ${effort(c.claudeEffort)}`, 'Claude model and effort', b => openPicker(b, [
    { title: 'Claude model', options: CLAUDE_MODEL_CHOICES, current: c.claudeModel ?? '', pick: v => setCfg({ claudeModel: v }) },
    { title: 'Effort', options: EFFORT_CHOICES, current: c.claudeEffort ?? 'high', pick: v => setCfg({ claudeEffort: v }) },
  ])))
  out.push(chip('codex', `Codex ${c.codexModel || 'default'} · ${effort(c.codexEffort)}`, 'Codex model and effort', b => void crewHealth().then(hl => openPicker(b, [
    { title: 'Codex model', options: hl.codexModels.map(m => [m, m] as [string, string]), current: c.codexModel ?? '', pick: v => setCfg({ codexModel: v }) },
    { title: 'Effort', options: EFFORT_CHOICES.filter(([v]) => v !== 'max'), current: c.codexEffort ?? 'high', pick: v => setCfg({ codexEffort: v }) },
  ]))))
  if (c.localModel || run!.usage.local?.runs) out.push(chip('local', `${AGENT_NAME.local} ${c.localModel || 'auto'}`, `${AGENT_NAME.local} model`, b => void crewHealth().then(hl => openPicker(b, [{ title: `${AGENT_NAME.local} model`, options: hl.localModels.map(m => [m, m] as [string, string]), current: c.localModel ?? '', pick: v => setCfg({ localModel: v }) }]))))
  out.push(chip('perm', c.bypassPermissions === false ? 'Ask before risky actions' : 'Bypass permissions', 'Whether the agents may run commands and read files without asking', () => setCfg({ bypassPermissions: c.bypassPermissions === false }), c.bypassPermissions === false ? '' : 'warn'))
  out.push(chip('fast', 'Fast', 'Many Claude sessions at once, no cross-review, light effort. Saying "fast" in a message turns it on too.', () => { if (replay) return toast('Replay mode: action recorded'); void teamAction(() => window.forge.teamSetSpeed(run!.id, c.speed !== 'fast')) }, c.speed === 'fast' ? 'on' : '', 'bolt'))
  return out
}

// `compact` shows only that icon; the label moves to the tooltip and the accessible name.
function actionButton(label: string, runAction: (e: MouseEvent) => void, cls = '', compact?: IconName) { const button = h('button', `btn ${cls}${compact ? ' only' : ''}`); button.dataset.key = label; if (compact) { button.append(icon(compact, 'sm')); button.title = label; button.setAttribute('aria-label', label) } else button.append(document.createTextNode(label)); button.onclick = runAction; return button }
function pauseButton() {
  const button = actionButton('Pause', e => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.replaceChildren(icon('stop', 'sm')); void teamAction(() => window.forge.teamPause(run!.id, true)) }, '', 'pause') as HTMLButtonElement
  button.title = 'Stop the agents now. Resume continues where they left off. You can also type pause.'
  return button
}
async function teamAction(fn: () => Promise<unknown>) { if (replay) { toast('Replay mode: action recorded'); return } await call(fn); await refreshRun() }
async function refreshRun() { if (!run || replay) return; const fresh = await window.forge.teamGet(run.id); if (fresh) { run = fresh; renderRun() } }

function renderPauseBanner() {
  const banner = h('section', 'team-pause-banner'); banner.dataset.key = 'pause'
  banner.append(mark(RUN_MARK[run!.status]), h('div', '', run!.pausedReason || 'This run was interrupted when Forge closed. The agents will continue from their saved sessions.'))
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
  const tray = h('section', 'approval-tray'); tray.dataset.key = 'approvals'; tray.setAttribute('role', 'alert'); tray.setAttribute('aria-live', 'assertive'); tray.append(sectionHead(N.waiting, `${items.length} blocking`))
  for (const approval of [...items].sort((a, b) => Number(b.kind === 'question') - Number(a.kind === 'question'))) {
    if (approval.kind === 'plan') { tray.append(renderPlanReview(approval)); continue }
    if (approval.kind === 'question') { tray.append(renderQuestion(approval)); continue }
    const card = h('article', 'team-approval-card'); card.dataset.key = approval.id; card.dataset.sig = JSON.stringify([approval.status, approval.kind, approval.title, approval.detail]); const copy = h('div', 'approval-copy')
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
  const card = h('article', 'question-card'); card.setAttribute('aria-label', `${who} asks: ${approval.title}`); card.dataset.key = approval.id; card.dataset.sig = JSON.stringify([approval.status, approval.title, approval.detail, approval.options, approval.multi])
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
  const box = h('section', 'q-answered'); box.dataset.key = 'answered'; if (!done.length) return null
  for (const a of done) {
    const line = h('div', 'q-line'); line.dataset.key = a.id; line.append(h('span', `agent-orb ${a.agent ?? ''}`), h('span', 'q-asked', a.title))
    line.append(h('strong', '', a.status === 'allowed' && a.answer ? `You answered: ${a.answer}` : a.status === 'denied' ? 'You skipped this' : 'No longer needed'))
    box.append(line)
  }
  return box
}

function renderPlanReview(approval: Run['approvals'][number]) {
  const card = h('article', 'team-plan-review'); card.dataset.key = approval.id; card.dataset.sig = JSON.stringify([approval.status, run!.tasks.map(t => [t.id, t.title, t.agent, t.status, t.deps, t.acceptance])])
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
  if (!run!.tasks.length) { if (run!.status === 'planning') for (let i = 0; i < 3; i++) board.append(h('div', 'task-card task-skeleton skel')); else board.append(h('p', 'team-empty', 'No tasks yet.')) }
  // Tasks the crew added by itself (fixing failed checks or review problems, writing tests) stay in a closed fold, so the board shows the plan and the user's own messages.
  const AUTO = /^(Fix failing checks|Fix problems from|Write or extend tests)/
  const auto = h('div', 'team-board')
  for (const [index, task] of run!.tasks.entries()) (AUTO.test(task.title) ? auto : board).append(renderTask(task, index))
  section.append(board)
  if (auto.childElementCount) section.append(fold(`Added by the crew: checks, fixes and tests (${auto.childElementCount})`, autoOpen, o => { autoOpen = o }, () => [auto]))
  return section
}
function renderTask(task: Task, index: number) {
  const card = h('article', `task-card ${task.status}`); card.dataset.task = task.id; card.dataset.key = task.id; enter(card, `${run!.id}:${task.id}`, index)
  const state = h('span', `task-state ${task.status}`); state.append(mark(TASK_MARK[task.status] ?? 'pending')); if (task.status === 'running' && task.phase) state.append(PHASE_LABEL[task.phase] ?? task.phase); state.title = task.phase ? `${PHASE_LABEL[task.phase] ?? task.phase} · ${task.status}` : task.status; state.setAttribute('aria-label', state.title)
  const top = h('div', 'task-top'); top.append(h('span', 'task-number', String(index + 1).padStart(2, '0')), h('span', `agent-badge ${task.agent}`, AGENT_NAME[task.agent]), state)
  const title = h('h3', '', task.title); title.title = task.title
  card.append(top, title)
  const facts = h('div', 'task-facts'); const fact = (text: string, title: string, cls = '') => { const f = h('span', cls, text); f.title = title; facts.append(f) }
  if (task.changed.length) fact(`${task.changed.length} ${task.changed.length === 1 ? 'file' : 'files'}`, `${task.changed.length} ${task.changed.length === 1 ? 'file' : 'files'} changed`); if (task.fixRounds) fact(`${task.fixRounds} ${task.fixRounds === 1 ? 'fix' : 'fixes'}`, `${task.fixRounds} fix ${task.fixRounds === 1 ? 'round' : 'rounds'}`)
  const verdict = task.reviews.at(-1)
  if (task.agent === 'local') { if (verdict) fact(`Checked by ${AGENT_NAME[verdict.by]}: ${verdict.verdict}`, `${AGENT_NAME.local} work is always checked. ${AGENT_NAME[verdict.by]} reviewed it: ${verdict.verdict}`, `verdict ${verdict.verdict}`); else fact('Will be checked', `${AGENT_NAME.local} work is always checked by another agent`, 'verdict') }
  else if (verdict) fact(`Review ${verdict.verdict}`, `Review: ${verdict.verdict}`, `verdict ${verdict.verdict}`)
  // "After 01, 02": the dependency by task number; the titles are in the tooltip.
  if (task.deps.length) fact(`After ${task.deps.map(id => { const i = run!.tasks.findIndex(t => t.id === id); return i < 0 ? id : String(i + 1).padStart(2, '0') }).join(', ')}`, `After ${task.deps.map(id => run!.tasks.find(t => t.id === id)?.title ?? id).join(', ')}`, 'task-deps')
  card.append(facts)
  if (task.error) { const error = h('p', 'task-error', task.error); error.title = task.error; card.append(error) }
  if (task.status === 'failed' || task.status === 'blocked' || task.status === 'interrupted') {
    const actions = h('div', 'task-actions'); actions.append(actionButton('Retry', () => teamAction(() => window.forge.teamRetryTask(run!.id, task.id)), 'primary'), actionButton('Skip', () => teamAction(() => window.forge.teamSkipTask(run!.id, task.id))))
    card.append(actions)
  }
  if (task.changed.length || task.diff) card.onclick = e => { if (!(e.target as HTMLElement).closest('button')) void openDiff(task.id) }
  return card
}

// Crew notes and the checks run in the background; they stay out of sight until asked for. The open/closed choice survives redraws.
let backgroundOpen = false
function renderBackground() {
  const d = h('details', 'team-background') as HTMLDetailsElement; d.open = backgroundOpen
  const failed = run!.approvals.length === 0 && log.some(x => x.ev.type === 'verify' && !x.ev.ok) && run!.status !== 'done'
  const sum = h('summary', '', 'Background'); if (failed) sum.append(h('span', 'bg-dot')); d.append(sum, renderMemory(), renderVerify())
  d.ontoggle = e => { backgroundOpen = (e.currentTarget as HTMLDetailsElement).open }
  return d
}
// The run page shows what matters: the answer (logins, URLs, commands the user asked for) and what the user sent. Live coding and the team's own
// chatter, background checks and changes stay one click away, closed by default.
let liveOpen = false, activityOpen = false, autoOpen = false
const AGENT_BODY = (m: { body: string }) => m.body.replace(/\s*Attached files \(open and look at them\):[\s\S]*$/, '').replace(/\s+/g, ' ').trim()
function liveKeys(): string[] {
  return keyLines([...run!.tasks.flatMap(t => [t.summary ?? '', t.handoff ?? '']), ...run!.messages.filter(m => m.from !== 'user').map(m => m.body)].join('\n'))
}
// What the user sent, each with the first reply an agent gave after it.
function renderYours(): HTMLElement | null {
  const mine = run!.messages.filter(m => m.from === 'user').slice(-8)
  if (!mine.length) return null
  const section = h('section', 'team-yours'); section.append(h('div', 'key-title', 'What you sent'))
  for (const m of mine) {
    const item = h('article', 'yours-item'); item.append(h('p', 'yours-text', AGENT_BODY(m).slice(0, 400)))
    const reply = run!.messages.find(r => r.at > m.at && r.from !== 'user' && r.from !== 'orchestrator' && (r.kind === 'handoff' || r.kind === 'finding'))
    if (reply) { const note = h('p', 'yours-reply', `${AGENT_NAME[reply.from as 'claude']}: ${oneLine(reply.body, 220)}`); item.append(note) }
    section.append(item)
  }
  return section
}
// A fold builds its content only while open, so a closed one costs nothing on a live redraw; opening it redraws once.
function fold(title: string, open: boolean, set: (o: boolean) => void, build: () => HTMLElement[]) {
  const d = h('details', 'team-fold') as HTMLDetailsElement; d.open = open
  d.append(h('summary', '', title)); if (open) d.append(...build())
  d.ontoggle = e => { const now = (e.currentTarget as HTMLDetailsElement).open; if (now !== open) { set(now); renderRun() } }
  return d
}
const usedAgents = () => (['claude', 'codex', 'local'] as const).filter(a => run!.tasks.some(t => t.agent === a) || log.some(x => x.ev.type === 'agent' && x.ev.ev.agent === a))
function makeDetailsToggle() {
  const toggle = h('button', `lane-details ${laneDetails ? 'on' : ''}`, laneDetails ? 'Live' : 'Details'); toggle.prepend(icon(laneDetails ? 'code' : 'list', 'sm')); toggle.title = laneDetails ? 'Back to the live coding view' : 'Show commands, step results, prompts and reasoning'; toggle.setAttribute('aria-pressed', String(laneDetails))
  toggle.onclick = () => { laneDetails = !laneDetails; try { localStorage.setItem('forge.teamLaneDetails', laneDetails ? '1' : '0') } catch {} renderRun() }
  return toggle
}
// What the agents are doing while no code is being typed (a fix that edits files with tools, a long command, the project check): the latest
// command or message, so the empty live view never just says "Reading the project" for an hour.
const oneLine = (text: string, max = 90) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t }
function activityOf(agent: 'claude' | 'codex' | 'local', ev: { type: string; summary?: string; text?: string; kind?: string }): string | null {
  if (ev.type === 'tool' && ev.summary) return `${AGENT_NAME[agent]} · ${ev.kind === 'command' ? 'running ' : ''}${oneLine(ev.summary)}`
  if (ev.type === 'text' && ev.text?.trim()) return `${AGENT_NAME[agent]} · ${oneLine(ev.text)}`
  return null
}
function latestActivity(): string | null {
  for (let i = log.length - 1, seen = 0; i >= 0 && seen < 300; i--, seen++) { const x = log[i]; if (x.ev.type === 'agent' && x.ev.phase !== 'plan') { const line = activityOf(x.ev.ev.agent, x.ev.ev as never); if (line) return line } }
  return null
}
// The live view is one editor for the whole team; "Details" swaps it for a lane per agent with every command and message.
function renderLanes() {
  const lanes = h('div', `team-lanes${laneDetails ? '' : ' single'}`)
  if (laneDetails) { const used = usedAgents(); for (const a of used) lanes.append(renderLane(a)); if (!used.length) lanes.append(renderLane('claude')); return lanes }
  const files: StageCode[] = log.flatMap(x => x.ev.type === 'agent' && x.ev.ev.type === 'code' && x.ev.phase !== 'plan' ? [{ id: x.ev.ev.id, agent: x.ev.ev.agent, path: x.ev.ev.path, text: x.ev.ev.text, kind: x.ev.ev.kind, done: x.ev.ev.done }] : [])
  const working = run!.tasks.some(t => t.status === 'running')
  const status = run!.status === 'planning' ? 'Planning the work' : working ? latestActivity() ?? 'Reading the project' : run!.status === 'verifying' ? 'Running the project check' : ['done', 'awaiting_approval'].includes(run!.status) ? 'Finished' : run!.status === 'paused' ? 'Paused' : 'Waiting'
  const agents = (usedAgents().length ? usedAgents() : (['claude'] as const)).map(a => ({ agent: a, name: AGENT_NAME[a], running: run!.tasks.some(t => t.agent === a && t.status === 'running') || run!.status === 'planning' }))
  const opts = { agents, running: working || run!.status === 'planning', status, details: makeDetailsToggle(), live: ['planning', 'running', 'verifying'].includes(run!.status) ? 'Live' : 'History' }
  const key = `${run!.id}:${agents.map(a => a.agent).join()}`
  if (!stageEl || stageKey !== key) { stageEl = buildStage(files, opts); stageKey = key } else updateStage(stageEl, files, opts) // built once per run and agent set: no rebuilt editor, no re-coloured code, no text typed twice
  lanes.append(keep('stage', stageEl))
  return lanes
}
function renderLane(agent: 'claude' | 'codex' | 'local') {
  const lane = h('section', `agent-lane ${agent}`); lane.dataset.key = agent; const header = h('header'); header.append(h('span', `agent-orb ${agent}${run!.tasks.some(t => t.agent === agent && t.status === 'running') ? ' busy' : ''}`), h('div', '', AGENT_FULL[agent]), h('span', `lane-live${['planning', 'running', 'verifying'].includes(run!.status) ? ' on' : ''}`, ['planning', 'running', 'verifying'].includes(run!.status) ? 'Live' : 'History')); header.append(makeDetailsToggle()); lane.append(header)
  const events = log.filter(x => x.ev.type === 'agent' && x.ev.ev.agent === agent && laneVisible(x.ev))
  const body = h('div', 'lane-body')
  if (!events.length) { const working = run!.tasks.some(t => t.agent === agent && t.status === 'running'); body.append(h('p', `lane-status ${run!.status === 'planning' || working ? 'active' : ''}`, run!.status === 'planning' ? 'Planning the work' : working ? 'Reading the project' : run!.tasks.some(t => t.agent === agent && t.status === 'queued') ? 'Waiting for its turn' : run!.status === 'done' || run!.status === 'awaiting_approval' ? 'Finished' : 'Idle')) }
  let lastKey = ''
  const shown = events.slice(-40), lastCode = shown.map(x => x.ev.type === 'agent' && x.ev.ev.type === 'code').lastIndexOf(true)
  for (const [shownIndex, { t, ev }] of shown.entries()) if (ev.type === 'agent') {
    const row = h('article', `activity-row ${ev.ev.type}`); const task = run!.tasks.find(x => x.id === ev.taskId)
    const x = ev.ev; row.dataset.key = x.type === 'delta' ? `d:${ev.taskId}:${ev.phase}:${x.channel}:${x.id}` : x.type === 'code' ? `c:${x.id}` : x.type === 'prompt' ? `p:${ev.taskId}:${ev.phase}` : `${t}:${x.type}:${(x as { id?: string }).id ?? ''}`
    const key = `${ev.taskId}:${ev.phase}`
    if (key !== lastKey) { lastKey = key; const divider = h('div', 'lane-divider'); divider.dataset.key = `div:${key}:${t}`; divider.append(h('strong', '', task?.title ?? ev.taskId), h('span', '', `${PHASE_LABEL[ev.phase] ?? ev.phase} · ${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)); body.append(divider) }
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
    else if (event.type === 'tool') { const tool = h('div', `activity-tool ${event.kind}`); tool.append(icon(TOOL_ICON[event.kind] ?? 'dots', 'sm'), document.createTextNode(`${event.kind === 'command' ? 'Running' : event.kind === 'edit' ? 'Changing' : event.kind === 'read' ? 'Reading' : 'Working'} · ${event.summary}`)); row.append(tool) }
    else if (event.type === 'tool_result') { const details = h('details', `activity-result ${event.ok ? 'ok' : 'bad'}`); const sum = h('summary'); sum.append(mark(event.ok ? 'done' : 'failed'), event.ok ? ' Step finished' : ' Step failed'); details.append(sum, h('pre', '', event.text.slice(0, 5000))); row.append(details) }
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
  const pre = h('pre', `live-code-body ${event.kind}`); pre.dataset.sig = `${event.id}:${event.text.length}:${event.done}` // same data: the coloured pre stays; new data: it is swapped, so colorize and the scroll reach the live node
  if (event.kind === 'diff') {
    for (const line of event.text.slice(-30000).split('\n')) {
      const part = h('span', line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : '', line + '\n')
      pre.append(part)
    }
  } else {
    const code = h('code', '', event.text.slice(-30000)); pre.append(code)
    const marker = `${event.id}:${event.text.length}`; code.dataset.liveCode = marker
    void colorize(event.text.slice(-30000), event.path).then(html => { if (code.isConnected && code.dataset.liveCode === marker) code.innerHTML = html }).catch(() => {})
  }
  if (!event.done) { pre.append(h('span', 'code-cursor', '')); requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight }) }
  card.append(head, pre); return card
}

const openFeed = new Set<string>() // feed messages the person expanded
function renderFeed() {
  const section = h('section', 'team-feed'); section.append(sectionHead(N.feed, `${run!.messages.length}`))
  if (!run!.messages.length) section.append(h('p', 'team-empty', 'Handoffs, reviews and decisions appear here.'))
  for (const msg of run!.messages.slice(-12)) { const item = h('article', `feed-item ${msg.kind}`); item.dataset.key = msg.id; const top = h('div'); const kindTag = h('span', '', msg.kind.replace('_', ' ')); top.append(h('strong', '', msg.from === 'user' ? 'You' : msg.from === 'orchestrator' ? 'Forge' : AGENT_NAME[msg.from]), kindTag); const body = h('p', 'feed-body', msg.body); item.append(top, body); if (msg.body.length > 260) { item.classList.toggle('clamped', !openFeed.has(msg.id)); item.title = 'Click to read all'; item.onclick = () => { if (!openFeed.delete(msg.id)) openFeed.add(msg.id); renderRun() } } section.append(item) }
  return section
}

function renderLiveFiles() {
  const section = h('section', 'team-live-files')
  const count = [...liveFiles.values()].reduce((total, files) => total + files.length, 0)
  section.append(sectionHead(N.changing, count ? `${count} live` : 'Quiet'))
  if (!count) { section.append(h('p', 'team-empty', 'Files appear here while an agent is writing them.')); return section }
  for (const [taskId, files] of liveFiles) {
    const group = h('div', 'live-file-group'); group.dataset.key = taskId; const task = run!.tasks.find(item => item.id === taskId)
    group.append(h('div', 'live-file-task', task?.title ?? taskId))
    for (const file of files) {
      const button = h('button', 'live-file-row'); button.dataset.key = file.path
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
  finally { if (run?.id === id) { memoryLoading = false; scheduleRun() } }
}

function scheduleMemoryRefresh() {
  if (memoryTimer) clearTimeout(memoryTimer)
  memoryTimer = setTimeout(() => void refreshMemory(), 180)
}
function renderVerify() {
  const events = log.filter(x => x.ev.type === 'verify')
  const section = h('section', 'team-verify'); section.append(sectionHead(N.checks, events.length ? `${events.length}` : 'Waiting'))
  for (const item of events.slice(-3)) if (item.ev.type === 'verify') { const details = h('details', `verify-card ${item.ev.ok ? 'ok' : 'bad'}`) as HTMLDetailsElement; details.dataset.key = String(item.t); details.open = !item.ev.ok; const sum = h('summary'); sum.append(mark(item.ev.ok ? 'done' : 'failed'), ` ${item.ev.ok ? 'Passed' : 'Failed'} · ${item.ev.command}`); details.append(sum, h('pre', '', item.ev.output.slice(-8000))); section.append(details) }
  return section
}
// One chat box for the whole run, pinned at the bottom in every state. While the crew works the message steers it; after it finishes, the same
// message reopens the run and puts the crew back to work — the run never "ends", you keep talking to it.
// The message box is built once per run and moved into every redraw, so a draft, files that are uploading and the focus survive live updates.
// It takes pictures, videos and documents like the start card does: paperclip, paste, or drop them on the box.
type SteerUi = { runId: string; form: HTMLFormElement; bar: HTMLElement; text: HTMLTextAreaElement; att: ReturnType<typeof attachmentStrip>; sync: () => void }
let steerUi: SteerUi | null = null
function buildSteer(runId: string): SteerUi {
  const form = h('form', 'team-steer team-composer') as HTMLFormElement; const row = h('div', 'team-steer-row')
  const text = h('textarea') as HTMLTextAreaElement; text.rows = 1; text.value = steerDraft; text.setAttribute('aria-label', 'Message the crew')
  const send = h('button', 'team-send') as HTMLButtonElement; send.append(icon('arrowup')); send.setAttribute('aria-label', 'Send to the crew'); send.type = 'submit'
  const att = attachmentStrip({
    host: form, textarea: text, max: 12, maxBytes: 200 * 1024 * 1024, limits: 'Up to 12 files per message, 200 MB each.',
    note: 'Agents get the file locations and look at pictures and video frames themselves.',
    upload: async (file, progress) => {
      if (replay) return { id: String(file.size), name: file.name, size: file.size, path: `/tmp/forge-replay/${file.name}`, kind: kindOf(file) }
      return uploadCrewFile(file, progress)
    },
    onChange: () => sync(),
  })
  const sync = () => { send.disabled = (!text.value.trim() && !att.ready().length) || att.busy(); send.title = att.busy() ? 'Waiting for the files to finish uploading' : 'Send' }
  const grow = () => { text.style.height = 'auto'; text.style.height = text.value ? `${Math.min(text.scrollHeight, 160)}px` : ''; sync() } // empty, it keeps its CSS height: scrollHeight counts a placeholder that wraps
  text.oninput = () => { steerDraft = text.value; grow() }
  const to = select([['all', 'Everyone'], ['claude', 'Claude'], ['codex', 'Codex'], ['local', AGENT_NAME.local]], steerTarget); to.onchange = () => { steerTarget = to.value as typeof steerTarget }
  const bar = h('div', 'cw-bar'); row.append(att.button, att.input, attachVoice(text, form), text, selectButton('users', to, 'Send to'), send); form.append(att.strip, row, bar); queueMicrotask(grow)
  text.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit() } }
  const sent = () => { steerDraft = ''; text.value = ''; att.clear(); grow() }
  form.onsubmit = e => {
    e.preventDefault(); const value = text.value.trim(); const files = att.ready() as TeamAttachment[]
    if ((!value && !files.length) || att.busy()) return
    if (replay) { run!.messages.push({ id: uuid(), from: 'user', to: steerTarget, kind: 'steer', body: value || 'See the attached files.', at: Date.now(), readBy: [] }); sent(); renderRun() }
    else void call(async () => { await window.forge.teamFollow(runId, value, steerTarget, files.length ? files : undefined); sent(); await refreshRun() })
  }
  return { runId, form, bar, text, att, sync }
}
function renderSteer() {
  const over = ['done', 'failed', 'cancelled', 'awaiting_approval'].includes(run!.status)
  if (!steerUi || steerUi.runId !== run!.id) steerUi = buildSteer(run!.id)
  steerUi.text.placeholder = over ? 'Keep going: ask for more, add pictures or files, or something new…' : ['paused', 'interrupted'].includes(run!.status) ? 'Paused. Type resume to continue, or add a note first…' : 'Message the crew, add pictures or files, or type pause to stop it…'
  steerUi.sync()
  const chips = h('div'); chips.append(...composerChips()); morphChildren(steerUi.bar, chips) // unchanged chips keep focus and hover; an open picker (data-transient) stays
  return steerUi.form
}
function renderDiffPanel() {
  const section = h('section', 'team-diff-panel')
  const changed = run!.tasks.flatMap(task => task.changed.map(file => ({ task, file })))
  section.append(sectionHead('Changes', `${changed.length} ${changed.length === 1 ? 'file' : 'files'}`))
  if (changed.length) {
    const files = h('div', 'team-diff-files')
    for (const { task, file } of changed.slice(0, 12)) {
      const row = h('button', 'team-diff-file'); row.dataset.key = `${task.id}:${file.path}`
      row.append(fileStatus(file.status), h('span', 'tool-path', file.path), h('span', 'team-diff-count', `+${file.added} −${file.removed}`))
      row.onclick = () => void openDiff(task.id); files.append(row)
    }
    section.append(files)
  }
  const button = h('button', 'btn', 'Review all changes'); button.onclick = () => void openDiff()
  const comments = h('button', 'btn', 'Review with comments'); comments.title = 'Comment on lines; the comments go to the crew as one message'; comments.onclick = () => void openDiffReview({ runId: run!.id })
  section.append(button, ...(run!.applied ? [] : [comments]), keep('diffhost', diffHost ??= h('div', 'team-diff-host'))); return section // after landing the crew's copy is gone, so there is no diff to comment on
}
async function openDiff(taskId?: string, path?: string, live = false) {
  if (!document.querySelector('.team-diff-host') && run) { crewOpen = activityOpen = true; renderRun() } // the diff host lives in a fold that is built only when open
  const host = document.querySelector<HTMLElement>('.team-diff-host'); if (!host || !run) return
  for (let d = host.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true // the morph leaves a fold as the person left it, so the folds around the diff are opened here
  host.classList.add('open'); host.replaceChildren(h('div', 'team-diff-loading skel')); host.scrollIntoView({ behavior: 'smooth', block: 'center' })
  try { const diff = replay ? `diff --git a/${path ?? 'src/team.ts'} b/${path ?? 'src/team.ts'}\n--- a/${path ?? 'src/team.ts'}\n+++ b/${path ?? 'src/team.ts'}\n@@ -1,2 +1,3 @@\n export const team = true\n+export const calm = true` : live && taskId && typeof window.forge.teamLiveDiff === 'function' ? await window.forge.teamLiveDiff(run.id, taskId, path) : await window.forge.teamDiff(run.id, taskId); host.replaceChildren(); await mountDiff(host, diff || 'No changes are available yet.') }
  catch (e) { host.replaceChildren(h('div', 'errcard', cleanErr(e))) }
}

// Land part of the result: built once per state of the run (it asks for the file groups when drawn).
let landPanel: { key: string; el: HTMLElement } | null = null
function landPanelFor() { const key = `${run!.id}:${(run!.landedFiles ?? []).length}:${run!.final!.files.length}`; if (!landPanel || landPanel.key !== key) landPanel = { key, el: renderLandPanel(run!, () => void refreshRun()) }; return landPanel.el }
function renderFinal() {
  const section = h('section', 'team-final'); section.dataset.key = 'final'
  section.append(h('h2', '', N.reviewHead))
  const split = splitKeyAnswer(run!.final!.report); if (split.key.length) section.append(keyCard(split.key)); const report = h('div', 'team-final-report'); report.innerHTML = md(split.rest); section.append(report)
  const files = h('div', 'team-final-files'); for (const file of run!.final!.files) { const f = h('div', '', file.path); f.prepend(fileIcon(file.status)); f.title = `${file.status === 'added' ? 'New' : file.status === 'deleted' ? 'Removed' : 'Updated'}: ${file.path}`; files.append(f) } section.append(files)
  const localReviews = run!.tasks.filter(t => t.agent === 'local' && t.status !== 'cancelled').flatMap(t => t.reviews.slice(-1))
  if (run!.tasks.some(t => t.agent === 'local' && t.status !== 'cancelled')) {
    const by = [...new Set(localReviews.map(r => AGENT_NAME[r.by]))].join(' and ') || 'another agent', ok = localReviews.length > 0 && localReviews.every(r => r.verdict === 'pass')
    const line = h('div', `final-verify ${localReviews.length ? (ok ? 'ok' : 'bad') : ''}`); line.append(mark(localReviews.length ? (ok ? 'done' : 'failed') : 'pending'), h('span', '', localReviews.length ? `${AGENT_NAME.local} work was reviewed by ${by}: ${ok ? 'PASS' : 'FAIL'}` : `${AGENT_NAME.local} work has not been reviewed yet`)); section.append(line)
  }
  const verify = h('div', `final-verify ${run!.final!.verifyOk ? 'ok' : run!.final!.verifyOk === false ? 'bad' : ''}`); verify.append(mark(run!.final!.verifyOk ? 'done' : run!.final!.verifyOk === false ? 'failed' : 'pending'), h('span', '', run!.final!.verifyOk ? 'Project check passed' : run!.final!.verifyOk === false ? 'Project check failed' : 'No project check configured')); section.append(verify)
  if (run!.final!.reviewNotes.length) { const notes = h('details', 'final-review-notes'); notes.append(h('summary', '', `Final review notes · ${run!.final!.reviewNotes.length}`), ...run!.final!.reviewNotes.map(item => h('p', '', item))); section.append(notes) }
  if (undoResult) section.append(h('div', 'errcard final-action-result', undoResult))
  if (!replay && !isRemote() && typeof window.forge.teamLandings === 'function' && run!.final!.files.length > 1) section.append(keep('land', landPanelFor()))
  const note = h('p', 'team-final-note', 'Nothing has changed in your project yet. If you don’t land this result, Forge keeps a saved crew copy that you can reopen later.'); section.append(note)
  const actions = h('div', 'team-final-actions')
  const apply = actionButton(N.land, async () => { if (replay) { if (replayScenario === 'applyfail') { undoResult = 'Could not land: your project changed while the crew was working. Review the project and try again.'; renderRun(); return } run!.status = 'done'; run!.applied = true; run!.appliedCheckpoint = 'replay-checkpoint'; toast('Landed · Undo is ready'); renderRun(); return } await call(async () => { let result = await window.forge.teamApply(run!.id); if (!result.ok && /apply without Undo/.test(result.message) && window.confirm(`${result.message}\n\nApply anyway, without Undo?`)) result = await window.forge.teamApply(run!.id, true); if (!result.ok) { undoResult = result.message; renderRun(); return } toast(result.checkpoint ? `${result.message} · Undo is ready` : result.message, 5000); await refreshRun() }) }, 'primary')
  const reject = actionButton("Don't land", () => { if (replay) { run!.status = 'done'; run!.applied = false; toast('Not landed · Forge kept a saved crew copy'); renderRun(); return } void teamAction(() => window.forge.teamReject(run!.id)) })
  actions.append(apply, reject); section.append(actions); return section
}

// Built once per landing: it asks git for its state when drawn, and the run screen redraws on every live event.
let gitPanel: { key: string; el: HTMLElement } | null = null
function gitPanelFor() { const key = `${run!.id}:${run!.applied}:${run!.undone}`; if (!gitPanel || gitPanel.key !== key) gitPanel = { key, el: renderGitPanel(run!) }; return gitPanel.el }
function renderApplied() {
  const section = h('section', `team-applied ${run!.undone ? 'undone' : ''}`); section.dataset.key = 'applied'
  const tag = h('div', 'eyebrow', run!.undone ? 'Changes undone' : 'Landed in your project'); tag.prepend(run!.undone ? icon('undo', 'sm') : mark('done'))
  section.append(tag, h('h2', '', run!.undone ? 'Your project is back where it was.' : 'The crew’s work is now in your project.'))
  const copy = run!.undone ? 'The landed files were restored to how they were before the crew.' : 'You can keep working, or undo the whole landing. Undo also removes hand edits made after it.'
  section.append(h('p', '', copy))
  if (undoResult) section.append(h('div', 'team-undo-result', undoResult))
  if (!run!.undone && run!.appliedCheckpoint && typeof window.forge.teamUndo === 'function') section.append(actionButton('Undo the landing', () => void undoApplied()))
  if (!run!.undone && !isRemote() && typeof window.forge.teamGitState === 'function') section.append(keep('git', gitPanelFor()))
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
  if (event.type === 'agent') {
    const e = event.ev
    if (event.phase !== 'plan') { const line = activityOf(e.agent, e as never); const idle = line && document.querySelector('.stage-idle-text'); if (idle) idle.textContent = line } // keep the empty live view honest
    if (!document.querySelector('.team-lanes')) return // agent events only change Live work: while it is closed nothing is redrawn
    if (!laneDetails) {
      if (e.type === 'code' && event.phase !== 'plan') { if (pushCode({ id: e.id, agent: e.agent, path: e.path, text: e.text, kind: e.kind, done: e.done })) return }
      else if (e.type !== 'error' && !(e.type === 'done' && !e.ok)) return // talk, commands and planning stay out of the live view
    }
  }
  if (event.type === 'live' && !document.querySelector('.team-live-files')) return // changed files show only inside the open activity fold
  if (event.type === 'task' || event.type === 'message') scheduleMemoryRefresh()
  scheduleRun()
}
// One redraw per frame, whatever the event rate (a phone: at most one every 100 ms). Everything that changed in between is drawn once, and nothing is cancelled.
let drawPending = false, drawnAt = 0
function scheduleRun() {
  if (drawPending) return
  drawPending = true
  const draw = () => { drawPending = false; drawnAt = performance.now(); renderRun() }
  const wait = isRemote() ? 100 - (performance.now() - drawnAt) : 0
  if (wait > 0) setTimeout(() => requestAnimationFrame(draw), wait); else requestAnimationFrame(draw)
}

// After the phone was offline or asleep: the open run (or the run list) is read again, keeping the scroll position.
async function resyncTeam() {
  if ($('team-screen').hidden || replay) return
  if (!run) { summaries = await window.forge.teamList(); cacheSet('runs', summaries.slice(0, 30)); const live = document.querySelector<HTMLElement>('.team-runs'); if (live) morph(live, renderRunList()); return }
  const id = run.id
  const [saved, events] = await Promise.all([window.forge.teamGet(id), window.forge.teamEvents(id)])
  if (!saved || run?.id !== id) return
  run = saved
  const normal = await normaliseTeamEventsAsync(events); log = normal.log; liveFiles = normal.liveFiles
  if (!['planning', 'running', 'paused', 'interrupted'].includes(run.status)) liveFiles.clear()
  renderRun()
}

export function initTeam(options: { project: () => string | null }) {
  if (isRemote()) onResync(resyncTeam)
  currentProject = options.project() ?? ''
  const enabled = apiReady(); $('mode-team').hidden = !enabled; $('team-nav').hidden = !enabled
  $('mode-team').onclick = () => showTeam(); $('team-nav').onclick = () => showTeam(); $('team-back').onclick = showChat; $('mode-chat').onclick = showChat
  $('team-hist-toggle').onclick = () => { if (phone.matches) toggleDrawer(); else $('hist-toggle').click() } // one toggle: same rail, labels and saved state as Solo
  if (typeof window.forge.onTeamEvent === 'function') window.forge.onTeamEvent(reduceEvent)
  if (localStorage.getItem('forge.teamReplay')) (window as unknown as { __forgeTeamEmit?: typeof reduceEvent }).__forgeTeamEmit = reduceEvent // lets the replay harness stream fake agent events
  window.addEventListener('forge-open-chat', e => { setActiveRun(''); showChat(); window.dispatchEvent(new CustomEvent('forge-open-chat-now', { detail: (e as CustomEvent<string>).detail })) })
  // the dashboard's Start a Crew run: use that folder, then the start screen
  window.addEventListener('forge-start-crew', e => { const path = (e as CustomEvent<string>).detail; if (path) void window.forge.setProject(path).then(root => { currentProject = root; window.dispatchEvent(new CustomEvent('forge-project-picked', { detail: root })); showTeam() }).catch(err => toast(cleanErr(err), 5000)) })
  // Ideas, Improve this project and the GitHub browser send a goal to the Crew start card: { goal, path?, reviewPlan? }
  window.addEventListener('forge-start-crew-goal', e => {
    const d = (e as CustomEvent<{ goal?: string; path?: string; reviewPlan?: boolean }>).detail
    if (!d?.goal) return
    pendingGoal = { goal: d.goal, reviewPlan: d.reviewPlan }
    const go = () => { setActiveRun(''); showTeam() }
    if (d.path) void window.forge.setProject(d.path).then(root => { currentProject = root; window.dispatchEvent(new CustomEvent('forge-project-picked', { detail: root })); go() }).catch(err => toast(cleanErr(err), 5000))
    else go()
  })
  window.addEventListener('forge-open-run', e => { showTeam(false); void openRun((e as CustomEvent<string>).detail).catch(err => toast(cleanErr(err), 5000)) })
  // a chat or a new chat from the sidebar leaves the Crew screen (it used to stay on it)
  $('history').addEventListener('click', e => { if (app.classList.contains('team-mode') && (e.target as HTMLElement).closest('.chat-open:not(.run-open), #new-chat, #side-new')) { setActiveRun(''); showChat() } })
  if (typeof window.forge.onTeamFocus === 'function') window.forge.onTeamFocus(id => { showTeam(false); void openRun(id).catch(e => toast(cleanErr(e), 5000)) })
  window.addEventListener('forge-project', (e) => { currentProject = (e as CustomEvent<string | null>).detail ?? '' })
  if (localStorage.getItem('forge.teamReplay') === 'open') { localStorage.setItem('forge.teamReplay', '1'); showTeam() }
}

export function setTeamProject(project: string | null) { currentProject = project ?? ''; window.dispatchEvent(new CustomEvent('forge-project', { detail: project })) }
