import type { TeamConfig } from '../main/team/types'
import { getCustomIds, loadModels, setCustomIds } from './models'
import { $, MINUTE_CHOICES, STEP_CHOICES, agentLimits, cleanErr, cloudContextPref, copy, h, numCtxPref, onOff, setThemePref, themePref, toast, type ThemePref } from './ui'
import { renderSkillsPanel } from './skillsPanel'
import { openProjectHistory } from './projectHistory'
import { icon, type IconName } from './icons'
import { openLibrary } from './library'
import { renderUsage } from './usage'
import { timeAgo } from './format'
import { isRemote } from './phone'
import { AGENT_NAME, N } from './names'

// Settings is a full page: grouped pages in a nav column on the left, one column of sections on the right.
export type Page = 'general' | 'appearance' | 'shortcuts' | 'models' | 'agent' | 'team' | 'skills' | 'remote' | 'usage' | 'privacy' | 'about'
// Inside the phone's browser some pages make no sense (and the server refuses their calls): they are left out.
const NAV: [string, [Page, IconName, string][]][] = [
  ['Personal', [['general', 'sliders', 'General'], ['appearance', 'contrast', 'Appearance'], ['shortcuts', 'keyboard', 'Keyboard']]],
  ['Forge', [['models', 'cube', 'Models & engine'], ['agent', 'bot', 'Agent'], ['team', 'users', N.crew], ['skills', 'spark', 'Skills'], ...(isRemote() ? [] : [['remote', 'phone', 'Remote access'] as [Page, IconName, string]]), ['usage', 'chart', 'Usage & spend'], ['privacy', 'shield', 'Privacy'], ['about', 'help', 'Help & about']]],
]
const PAGES = NAV.flatMap(([, items]) => items)
const TITLE = Object.fromEntries(PAGES.map(([id, , label]) => [id, label])) as Record<Page, string>
const GLYPH = Object.fromEntries(PAGES.map(([id, glyph]) => [id, glyph])) as Record<Page, IconName>

// ---- building blocks: a section is a heading plus rows; a row is a label and description on the left, a control on the right ----
const group = (title?: string, desc?: string) => {
  const g = h('section', 'sgroup')
  if (title) g.append(h('h4', 'gt', title))
  if (desc) g.append(h('div', 'gd', desc))
  const box = h('div', 'sbox')
  g.append(box)
  return { g, box }
}

function row(title: string, desc: string, ...controls: HTMLElement[]) {
  const r = h('div', 'srow')
  const t = h('div', 'srl')
  t.append(h('div', 'st-t', title))
  if (desc) t.append(h('div', 'st-d', desc))
  const c = h('div', 'ctl')
  c.append(...controls)
  for (const control of c.querySelectorAll('input, select, .seg')) if (!control.getAttribute('aria-label')) control.setAttribute('aria-label', title)
  r.append(t, c)
  return r
}

// A native select inside a bordered box with up/down chevrons.
function choose(options: [string, string][], value: string, onPick: (v: string) => void) {
  const wrap = h('label', 'sselect')
  const el = document.createElement('select')
  for (const [v, label] of options) el.append(new Option(label, v))
  el.value = value
  el.onchange = () => onPick(el.value)
  wrap.append(el, icon('updown', 'sm'))
  return wrap
}

// An outlined button with a leading icon.
function action(label: string, glyph: IconName | null, run: () => void, cls = '') {
  const b = h('button', `btn sact ${cls}`.trim(), label) as HTMLButtonElement
  if (glyph) b.prepend(icon(glyph, 'sm'))
  b.type = 'button'
  b.onclick = run
  return b
}

function field(type: string, value: string, placeholder = '') {
  const i = document.createElement('input')
  i.type = type
  i.value = value
  i.placeholder = placeholder
  return i
}

const save = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v)
  } catch {}
}

// ---- pages ----
async function general(into: HTMLElement) {
  const info = await window.forge.appInfo()
  const card = h('div', 'set-card')
  const mark = h('span', 'brand-mark', 'f')
  mark.setAttribute('aria-hidden', 'true')
  const t = h('div', 'srl')
  t.append(h('div', 'st-t', `Forge ${info.version}`), h('div', 'st-d', 'Builds software on your computer with local or cloud AI. Chats, usage and settings stay on this machine.'))
  card.append(mark, t)
  if (!isRemote()) card.append(action('Open data folder', 'folder', () => window.forge.openDataDir()))
  into.append(card)

  const b = group('Behavior')
  let mode = 'ask-all'
  try {
    mode = localStorage.getItem('forge.mode') ?? 'ask-all'
  } catch {}
  b.box.append(
    row(
      'Default autonomy',
      'How much Forge may do before asking you. You can still change it for each message.',
      choose([['ask-all', 'Ask first'], ['auto-edit', 'Auto-edit'], ['full-auto', 'Full auto']], mode, (v) => {
        save('forge.mode', v)
        $<HTMLSelectElement>('mode').value = v
      }),
    ),
  )
  const prefs = await window.forge.prefsGet()
  b.box.append(row('Notifications', 'Tell me when work in the background finishes or needs my approval.', onOff(prefs.notify, (v) => window.forge.prefsSet('notify', v))))
  into.append(b.g)

  const m = group('What the autonomy levels mean')
  m.box.append(
    row('Ask first', 'Asks before every file change and before every command. Reading is always allowed.', h('span', 'badge', 'Safest')),
    row('Auto-edit', 'Creates and edits files freely. Asks before commands, except safe ones like npm test and git status.', h('span', 'badge', 'Balanced')),
    row('Full auto', 'Does everything without asking. Needs a project check so something verifies the work.', h('span', 'badge', 'Hands-off')),
  )
  into.append(m.g)
}

// Theme as preview cards: a tiny drawing of the window in each theme.
function appearance(into: HTMLElement) {
  const g = group('Theme')
  const cards = h('div', 'scards')
  cards.setAttribute('role', 'radiogroup')
  cards.setAttribute('aria-label', 'Theme')
  const pick = (v: ThemePref) => {
    setThemePref(v)
    cards.querySelectorAll<HTMLElement>('.scard').forEach((c) => { const on = c.dataset.v === v; c.classList.toggle('on', on); c.setAttribute('aria-checked', String(on)) })
  }
  for (const [v, label] of [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']] as [ThemePref, string][]) {
    const c = h('button', `scard${themePref() === v ? ' on' : ''}`) as HTMLButtonElement
    c.type = 'button'
    c.dataset.v = v
    c.setAttribute('role', 'radio')
    c.setAttribute('aria-checked', String(themePref() === v))
    const shot = h('span', `sprev ${v}`)
    shot.setAttribute('aria-hidden', 'true')
    for (const face of v === 'system' ? ['dark', 'light'] : [v]) { // System is both, split on a diagonal
      const f = h('span', `sprev-face ${face}`)
      f.append(h('i', 'side'), h('i', 'n1'), h('i', 'n2'), h('i', 'l1'), h('i', 'l2'), h('i', 'box'), h('i', 'send'))
      shot.append(f)
    }
    c.append(shot, h('span', 'cl', label))
    c.onclick = () => pick(v)
    cards.append(c)
  }
  const r = row('Window theme', 'Dark, light, or follow your system setting.', cards)
  r.classList.add('stack') // the previews get the column's width
  g.box.append(r)
  into.append(g.g)
}

async function models(into: HTMLElement) {
  const [ol, keys] = await Promise.all([window.forge.ollamaStatus(), window.forge.keysStatus()])

  if (typeof window.forge.engineHostGet === 'function') {
    const host = await window.forge.engineHostGet()
    const location = group('Where models run', 'Use this computer or an AI engine on another computer on your network.')
    const address = field('text', host.host, '192.168.1.20:11434')
    const memory = field('number', String(host.vramGB))
    memory.min = '1'
    memory.max = '1024'
    const result = h('div', 'hint')
    result.setAttribute('role', 'status')
    const test = action('Test', 'globe', async () => {
      test.disabled = true
      try { const checked = await window.forge.engineHostTest(address.value); result.textContent = checked.ok ? `Connected · ${checked.models} models available` : 'Engine didn’t respond. Check the address.' }
      catch (e) { result.textContent = cleanErr(e) }
      finally { test.disabled = false }
    })
    test.title = 'Test connection'
    const use = h('button', 'btn primary', 'Use this address') as HTMLButtonElement
    use.onclick = async () => {
      use.disabled = true
      try { await window.forge.engineHostSet(address.value, Number(memory.value)); await loadModels(); result.textContent = 'Saved. Models now run on that computer.' }
      catch (e) { result.textContent = cleanErr(e) }
      finally { use.disabled = false }
    }
    const here = action('Use this computer', 'cpu', async () => {
      try { await window.forge.engineHostSet(''); address.value = ''; await loadModels(); result.textContent = 'Models now use this computer.' }
      catch (e) { result.textContent = cleanErr(e) }
    })
    location.box.append(row('Engine address', host.host ? 'Currently using another computer.' : 'Currently using this computer.', address), row('Remote GPU memory (GB)', 'Used to estimate which models will fit.', memory), row('Connection', '', test, use, here), result)
    into.append(location.g)
  }

  const local = group('AI models', 'Ollama models run on the computer selected above. No per-token fees.')
  const lib = action('Open library', 'cube', () => {
    $<HTMLDialogElement>('settings').close()
    openLibrary()
  })
  local.box.append(row('Model library', 'Download, switch and delete models without leaving Forge.', lib))
  local.box.append(
    row(
      'Ollama',
      ol.up ? (ol.models.length ? `Running. These models are installed.${ol.loaded[0] ? ` ${ol.loaded[0].name} is loaded (${ol.loaded[0].gpuPercent}% on the GPU).` : ''}` : 'Running, but no models are installed yet.') : 'Not reachable at 127.0.0.1:11434.',
      h('span', 'badge ' + (ol.up ? 'ok' : 'bad'), ol.up ? `Running · ${ol.models.length}` : 'Not running'),
    ),
  )
  if (ol.models.length) {
    const list = h('div', 'mlist')
    for (const n of ol.models) list.append(h('span', '', n))
    const r = h('div', 'srow stack')
    r.append(list)
    local.box.append(r)
  }
  if (ol.loaded.length && ol.loaded.every((m) => m.gpuPercent === 0)) {
    const w = h('div', 'hint')
    w.style.color = 'var(--warn)'
    w.append(
      document.createTextNode('Ollama is running the model on the CPU, not the graphics card, so local models are several times slower. Install the GPU build of Ollama (on Arch: '),
      h('code', 'k', 'sudo pacman -S ollama-cuda'),
      document.createTextNode(') and restart it.'),
    )
    local.box.append(w)
  }
  if (!ol.up || !ol.models.length) {
    const hint = h('div', 'hint')
    hint.append(document.createTextNode('Install Ollama from ollama.com, run '), h('code', 'k', 'ollama serve'), document.createTextNode(', then for example '), h('code', 'k', 'ollama pull qwen3:8b'), document.createTextNode('.'))
    local.box.append(hint)
  }
  local.box.append(
    row(
      'Memory size',
      'How much a local model can remember at once. Bigger needs more video memory. If a chat starts forgetting things, raise it or start a new chat.',
      choose([['4096', '4k tokens'], ['8192', '8k tokens'], ['16384', '16k tokens'], ['32768', '32k tokens']], String(numCtxPref()), (v) => save('forge.numctx', v)),
    ),
  )
  into.append(local.g)

  const cloud = group('Cloud models', 'Use a provider with your own API key. Keys are stored encrypted by your OS keychain and only sent to that provider.')
  for (const [p, name, note] of [
    ['anthropic', 'Anthropic', 'Claude Sonnet, Opus and Haiku are built in.'],
    ['openai', 'OpenAI', 'Add the model names you want to use.'],
    ['openrouter', 'OpenRouter', 'One key for many models. Add the model names you want to use.'],
  ] as const) {
    const input = field('password', '', keys[p] ? '•••••••• saved. Paste to replace' : 'Paste API key')
    input.autocomplete = 'off'
    const msg = h('div', 'errtext')
    const saveBtn = h('button', 'btn primary', 'Save')
    saveBtn.onclick = async () => {
      try {
        await window.forge.keysSet(p, input.value)
        await loadModels()
        toast(`${name} key saved`)
        rerender()
      } catch (e) {
        msg.textContent = cleanErr(e)
      }
    }
    const ctl: HTMLElement[] = [input, saveBtn]
    if (keys[p]) {
      ctl.push(action('Remove', 'trash', async () => {
        await window.forge.keysClear(p)
        await loadModels()
        rerender()
      }, 'danger'))
    }
    const head = row(name, note, h('span', 'badge ' + (keys[p] ? 'ok' : ''), keys[p] ? 'Connected' : 'Not connected'))
    head.classList.add('sub')
    cloud.box.append(head, row('API key', `Your ${name} key.`, ...ctl))
    if (p !== 'anthropic') {
      const ids = field('text', getCustomIds(p).join(', '), 'model-one, model-two')
      ids.onchange = () => {
        setCustomIds(p, ids.value.split(',').map((s) => s.trim()).filter(Boolean))
        loadModels()
      }
      cloud.box.append(row('Models', 'Comma-separated model names, as the provider spells them.', ids))
    }
    const errRow = h('div', 'srow stack')
    errRow.hidden = true // only shown when saving a key fails
    errRow.append(msg)
    cloud.box.append(errRow)
    const showErr = new MutationObserver(() => (errRow.hidden = !msg.textContent))
    showErr.observe(msg, { childList: true })
  }
  into.append(cloud.g)
}

async function agent(into: HTMLElement) {
  const lim = agentLimits()
  const l = group('Limits', 'A run stops when it reaches either limit. Raise them for big builds.')
  l.box.append(
    row('Steps per run', 'One step is one model call. Reading a file, editing it and running tests are three or more.', choose(STEP_CHOICES.map((n) => [String(n), `${n} steps`] as [string, string]), String(lim.maxSteps), (v) => save('forge.maxsteps', v))),
    row('Time per run', 'The longest one run may keep working.', choose(MINUTE_CHOICES.map((n) => [String(n), n >= 60 ? `${n / 60} ${n === 60 ? 'hour' : 'hours'}` : `${n} minutes`] as [string, string]), String(lim.maxMinutes), (v) => save('forge.maxmin', v))),
  )
  const cloudCtx = field('number', String(cloudContextPref()))
  cloudCtx.min = '0'
  cloudCtx.step = '1000'
  cloudCtx.onchange = () => cloudCtx.checkValidity() && save('forge.cloudctx', String(Math.max(0, Math.round(Number(cloudCtx.value) || 0))))
  l.box.append(row('Cloud context window', 'Tokens of conversation sent to cloud models before old tool output is trimmed. 0 = automatic by model.', cloudCtx))
  into.append(l.g)

  const verify = await window.forge.verifyGet()
  const p = group('This project', verify ? 'Settings for the folder of the chat you are looking at.' : 'Open or start a chat in a folder to set this.')
  if (verify) {
    const vin = field('text', verify.configured ?? '', verify.detected ? `${verify.detected} (detected)` : 'e.g. npm test')
    vin.onchange = () => window.forge.verifySet(vin.value)
    p.box.append(row('Check command', 'Runs when the agent says it is done after editing. If it fails, the output goes back to the agent. Full auto requires one.', vin))
    into.append(p.g)
  }

  const s = group('Safety, always on')
  s.box.append(
    row('Folder jail', 'The agent can only read and change files inside the chat’s folder, including through links and new folders.', h('span', 'badge ok', 'On')),
    row('Undo', 'Every run is snapshotted with git first. Press Undo on the changes card to put everything back.', h('span', 'badge ok', 'On')),
    row('Blocked commands', 'sudo, recursive deletes of / or ~, disk formatting and “pipe a download into a shell” are refused in every mode.', h('span', 'badge ok', 'On')),
    row('Package check', 'Before an install, package names are looked up in the npm or PyPI registry. Made-up names are refused.', h('span', 'badge ok', 'On')),
  )
  into.append(s.g)
}

// Team defaults for the current project, through the same calls the Team start screen uses.
async function team(into: HTMLElement) {
  if (typeof window.forge.teamSettingsGet !== 'function' || typeof window.forge.teamSettingsSet !== 'function') { into.append(h('p', 'note', `This build does not include ${N.crew}.`)); return }
  const [stored, project, ol] = await Promise.all([window.forge.teamSettingsGet(), window.forge.verifyGet(), window.forge.ollamaStatus().catch(() => ({ up: false, models: [] as string[], loaded: [] }))])
  into.append(h('p', 'note', project ? `Defaults for ${N.crewRuns.toLowerCase()} in the folder of the chat you are looking at. The ${N.crew} start screen picks them up.` : `Open a chat in a project folder to set its ${N.crew} defaults.`))
  if (!project) return
  const cfg: Partial<TeamConfig> = { ...stored }
  const status = h('div', 'hint set-status')
  status.setAttribute('role', 'status')
  const put = <K extends keyof TeamConfig>(key: K, value: TeamConfig[K] | undefined) => {
    if (value === undefined) delete cfg[key]
    else cfg[key] = value
    window.forge.teamSettingsSet(cfg).then(() => (status.textContent = 'Saved for this project.'), (e) => (status.textContent = cleanErr(e)))
  }
  const budget = (key: 'maxMinutes' | 'maxTokens' | 'maxAgentRuns' | 'maxTasks', raw: string) => {
    const n = Number(raw)
    put('budget', { ...(cfg.budget ?? { maxTasks: 12 }), [key]: raw.trim() && Number.isFinite(n) && n > 0 ? n : undefined } as TeamConfig['budget'])
  }
  const num = (value: number | undefined, min: number, max: number, placeholder: string, apply: (raw: string) => void) => {
    const i = field('number', value === undefined ? '' : String(value), placeholder)
    i.min = String(min)
    i.max = String(max)
    i.onchange = () => { if (i.checkValidity()) apply(i.value) }
    return i
  }

  const p = group('Planning')
  p.box.append(
    row('Planner', 'Chooses who splits the goal into tasks.', choose([['auto', 'Choose for me'], ['claude', 'Claude'], ['codex', 'Codex'], ['local', AGENT_NAME.local]], cfg.planner ?? 'auto', (v) => put('planner', v as TeamConfig['planner']))),
    row('Plan approval', 'Stop after planning so you can edit, reassign or skip tasks before any agent works.', onOff(!!cfg.reviewPlan, (v) => put('reviewPlan', v))),
    row('Task review', 'Each agent checks the other’s work before it is merged.', onOff((cfg.review ?? 'cross') === 'cross', (v) => put('review', v ? 'cross' : 'off'))),
    row('Final review', 'Automatic checks the whole result only for runs of 3 or more tasks, which saves plan usage.', choose([['auto', 'Automatic'], ['true', 'Always'], ['false', 'Skip']], String(cfg.finalReview ?? 'auto'), (v) => put('finalReview', v === 'auto' ? 'auto' : v === 'true'))),
    row('Security review', 'A final read-only check for secrets, injection, missing authorisation and unsafe input before landing. Automatic runs it when auth, payment, admin, secret or dependency files change.', choose([['auto', 'Automatic'], ['always', 'Always'], ['off', 'Off']], cfg.securityReview ?? 'auto', (v) => put('securityReview', v as TeamConfig['securityReview']))),
    row('Write tests', 'After the build tasks, one agent writes or extends tests for the changed code when the project has a test command.', onOff(cfg.testTask !== false, (v) => put('testTask', v))),
    row('Switch agents at a limit', 'When Claude or Codex reaches its plan limit, another ready agent takes over its tasks and the run keeps going.', onOff(cfg.autoSwitch !== false, (v) => put('autoSwitch', v))),
    row('Effort', 'Automatic thinks less on reading and small reviews and keeps your chosen effort for building. Cheap uses the least and prefers Codex and the local model for building.', choose([['auto', 'Automatic'], ['fixed', 'As set below'], ['cheap', 'Cheap']], cfg.effortMode ?? 'auto', (v) => put('effortMode', v as TeamConfig['effortMode']))),
  )
  into.append(p.g)

  const efforts: [string, string][] = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']]
  const claudeModels: [string, string][] = [['', 'Account default'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1']]
  if (cfg.claudeModel && !claudeModels.some(([v]) => v === cfg.claudeModel)) claudeModels.push([cfg.claudeModel, cfg.claudeModel])
  const codexModel = field('text', cfg.codexModel ?? '', 'Codex default')
  codexModel.onchange = () => put('codexModel', codexModel.value.trim())
  const m = group('Models and effort')
  m.box.append(
    row('Claude model', 'The Claude Code model for tasks and reviews.', choose(claudeModels, cfg.claudeModel ?? '', (v) => put('claudeModel', v || undefined))),
    row('Claude effort', 'More effort thinks longer and uses more of your plan.', choose([...efforts, ['max', 'Maximum']], cfg.claudeEffort ?? 'high', (v) => put('claudeEffort', v as TeamConfig['claudeEffort']))),
    row('Codex model', 'The model name Codex should use. Leave empty for its default.', codexModel),
    row('Codex effort', 'How hard Codex reasons before it answers.', choose(efforts, cfg.codexEffort ?? 'high', (v) => put('codexEffort', v as TeamConfig['codexEffort']))),
    row('Codex connection', 'Live sessions support streaming and immediate steering.', choose([['app-server', 'Live session'], ['exec', 'Simple run']], cfg.codexMode ?? 'app-server', (v) => put('codexMode', v as TeamConfig['codexMode']))),
    row(`${AGENT_NAME.local} model`, ol.models.length ? `The Ollama model ${AGENT_NAME.local} uses.` : 'No Ollama models are installed.', choose([['', 'Best installed'], ...ol.models.map((n) => [n, n] as [string, string])], cfg.localModel ?? '', (v) => put('localModel', v || undefined))),
  )
  into.append(m.g)

  const l = group('Limits', 'Empty means no limit.')
  l.box.append(
    row('Parallel tasks per agent', 'More tasks can finish sooner, but use more allowance.', num(cfg.maxParallelPerAgent ?? 2, 1, 4, '2', (v) => put('maxParallelPerAgent', Number(v)))),
    row('Fix attempts per task', 'How often an agent may retry after a failed review or check.', num(cfg.maxFixRounds ?? 3, 0, 5, '3', (v) => put('maxFixRounds', Number(v)))),
    row('Maximum tasks', 'The most tasks one plan may have.', num(cfg.budget?.maxTasks ?? 12, 1, 30, '12', (v) => budget('maxTasks', v))),
    row('Time limit (minutes)', 'Pause the run after this long.', num(cfg.budget?.maxMinutes, 1, 100000, 'No limit', (v) => budget('maxMinutes', v))),
    row('Token limit', 'Pause the run after this many tokens.', num(cfg.budget?.maxTokens, 1000, 1e10, 'No limit', (v) => budget('maxTokens', v))),
    row('Agent runs limit', 'Pause after this many agent runs.', num(cfg.budget?.maxAgentRuns, 1, 100000, 'No limit', (v) => budget('maxAgentRuns', v))),
    row('Pause at plan usage %', '0 disables this limit.', num(cfg.maxLimitPercent ?? 0, 0, 100, '0', (v) => put('maxLimitPercent', Number(v)))),
  )
  into.append(l.g)

  const perm = group('Permissions')
  const verify = field('text', cfg.verify ?? '', 'Detect from project')
  verify.onchange = () => put('verify', verify.value.trim() || undefined)
  perm.box.append(
    row('Questions', 'Agents may stop and ask you when they are really unsure.', onOff(cfg.askQuestions !== false, (v) => put('askQuestions', v))),
    row('Web research', 'Agents may search the web and read pages for docs, APIs and versions.', onOff(cfg.webResearch !== false, (v) => put('webResearch', v))),
    row('Never ask me', 'Agents run commands and read files without asking. They still cannot push to git, use sudo, or write outside their own task folder.', onOff(cfg.bypassPermissions !== false, (v) => put('bypassPermissions', v))),
    row('Project check', 'The command that verifies the result. Leave blank to detect it from the project.', verify),
  )
  const hist = group('Project history')
  hist.box.append(row('What happened', 'Forge keeps a history of everything that happens in a project in .forge/what-happened.txt and shows it to every agent.', action('Show history', 'list', () => void openProjectHistory())))
  into.append(hist.g)
  into.append(perm.g)
  headNote?.replaceChildren(status) // "Saved for this project." shows in the sticky head, in sight wherever the page is scrolled
}

// Every key Forge listens for (chat.ts and palette.ts own the handlers), as key caps.
function shortcuts(into: HTMLElement) {
  const caps = (combo: string) => {
    const s = h('span', 'keys')
    for (const k of combo.split(' ')) s.append(h('kbd', '', k))
    return s
  }
  const crew = typeof window.forge.teamStart === 'function'
  const sections: [string, [string, string][]][] = [
    ['Anywhere', [
      ['Ctrl K', 'Find actions, chats and models'],
      ['Ctrl N', N.newChat],
      ['Ctrl 1', `Go to ${N.solo}`],
      ...(crew ? [['Ctrl 2', `Go to ${N.crew}`] as [string, string]] : []),
      ['Ctrl B', 'Collapse the sidebar to icons, or expand it'],
      ['Ctrl .', 'Show or hide the build brief'],
      ['Ctrl J', 'Show or hide the workspace (files, editor, terminal)'],
      ['Ctrl ,', 'Open settings'],
    ]],
    ['In a chat', [
      ['Ctrl L', 'Focus the message box'],
      ['Enter', 'Send the message'],
      ['Shift Enter', 'New line in the message'],
      ['Esc', 'Stop the agent while it works'],
    ]],
    ['In Settings', [
      ['Ctrl F', 'Search settings'],
      ['Esc', 'Clear the search, or leave Settings'],
    ]],
  ]
  for (const [title, keys] of sections) {
    const g = group(title)
    for (const [k, v] of keys) g.box.append(row(v, '', caps(k)))
    into.append(g.g)
  }
}

async function privacy(into: HTMLElement) {
  const info = await window.forge.appInfo()
  const g = group('Your data')
  g.box.append(
    row('Stored on this computer', `Chats, usage and settings are stored on this computer only: ${info.dataDir}`, ...(isRemote() ? [] : [action('Open folder', 'folder', () => window.forge.openDataDir())])),
    row('API keys', 'Stored encrypted by your OS keychain and only sent to the provider they belong to.', h('span', 'badge ok', 'Encrypted')),
    row('Local models', 'Ollama models run on this computer or on the engine you chose under Models & engine.', h('span', 'badge', 'Private')),
  )
  into.append(g.g)
}

async function about(into: HTMLElement) {
  const info = await window.forge.appInfo()
  const g = group('About')
  g.box.append(
    row('Forge', 'A chat app that builds software on your computer with local or cloud AI.', h('span', 'badge', `v${info.version}`)),
    row('Runtime', `Electron ${info.electron} on ${info.platform}`, h('span', 'badge', 'local')),
    row('Keyboard', 'Every key Forge listens for.', action('Show shortcuts', 'keyboard', () => void show('shortcuts'))),
  )
  into.append(g.g)
}

// Remote access: the same window, served to a paired phone over Tailscale.
async function remote(into: HTMLElement) {
  if (isRemote() || typeof window.forge.remoteStatus !== 'function') return
  const st = await window.forge.remoteStatus()
  const set = async (o: { enabled?: boolean; lan?: boolean; https?: boolean }) => { try { await window.forge.remoteSet(o) } catch (e) { toast(cleanErr(e), 4000) } void rerender() }
  const g = group('Phone')
  const state = h('div', `remote-state ${st.error ? 'bad' : st.listening ? 'ok' : ''}`)
  state.setAttribute('role', 'status')
  state.textContent = st.error ? st.error : st.listening ? `Listening on ${st.url}` : st.enabled ? 'Starting…' : 'Off. Nothing is reachable from other devices.'
  g.box.append(row('Use Forge from your phone', 'Open this Forge window in the phone’s browser. The agents keep running on this computer.', onOff(st.enabled, (v) => void set({ enabled: v }))))
  const info = h('div', 'srow stack')
  info.append(state)
  if (!st.tailscale) info.append(h('div', 'remote-hint', 'Tailscale isn’t running on this computer, so the phone link only works on this computer. Install Tailscale on both devices (free) and turn it on.'))
  g.box.append(info)
  const tls = row('Use HTTPS (recommended)', 'Serves the link with a certificate from Tailscale: no browser warning, and the phone can install Forge as an app. Needs “HTTPS Certificates” switched on in the Tailscale admin console, on the DNS page.', onOff(st.https, (v) => void set({ https: v })))
  if (st.enabled && st.https) {
    const live = h('div', `remote-state ${st.httpsError ? 'bad' : st.httpsActive ? 'ok' : ''}`, st.httpsError ? `HTTPS is not active: ${st.httpsError}` : st.httpsActive ? 'HTTPS is active.' : 'Starting…')
    live.setAttribute('role', 'status')
    tls.querySelector('.srl')?.append(live)
  }
  g.box.append(tls)
  const lan = row('Also allow this Wi-Fi', 'Over plain http, anyone who can see or intercept this Wi-Fi can take over a paired phone’s session. It then listens only on the Wi-Fi and Tailscale addresses, not on every network interface. Prefer Tailscale.', onOff(st.lan, (v) => void set({ lan: v })))
  g.box.append(lan)
  into.append(g.g)

  const p = group('Pair a phone', 'This code works once, for one phone, and does not expire.')
  const show = action('Show pairing code', 'phone', async () => {
    show.disabled = true
    try {
      const { url, qr } = await window.forge.remotePair()
      const card = h('div', 'pair-card')
      if (qr) { const img = document.createElement('img'); img.src = qr; img.alt = 'QR code for the pairing link'; img.width = 280; img.height = 280; card.append(img) }
      const link = h('div', 'pair-link')
      link.append(h('code', 'k', url), action('Copy', 'copy', () => void copy(url, 'Link copied')))
      card.append(link, h('div', 'pair-left', 'Works once, for one phone. Showing a new code makes a fresh one.'))
      slot.replaceChildren(card)
      show.replaceChildren(icon('phone', 'sm'), document.createTextNode('Show a new code'))
    } catch (e) { slot.replaceChildren(h('div', 'errtext', cleanErr(e))) }
    finally { show.disabled = !st.listening }
  })
  show.disabled = !st.listening
  show.title = st.listening ? 'Show a QR code and link for your phone' : 'Turn on “Use Forge from your phone” first'
  const slot = h('div', 'pair-slot')
  const steps = h('ol', 'pair-steps')
  for (const t of ['Install Tailscale on the phone and sign in to the same account as this computer (this is what lets it work from anywhere in the world).', 'Scan the code with the camera.', 'In Safari tap Share, then Add to Home Screen, and open Forge from the home screen (this keeps it paired).']) steps.append(h('li', '', t))
  const pr = h('div', 'srow stack')
  pr.append(show, slot, steps, h('div', 'pair-left', 'Forge must be open on this computer for the phone to reach it.'))
  p.box.append(pr)
  into.append(p.g)

  const d = group('Paired devices')
  if (!st.devices.length) { const e = h('div', 'srow stack'); e.append(h('div', 'st-d', 'No phones paired yet. Show a pairing code and scan it.')); d.box.append(e) }
  for (const dev of st.devices) {
    const revoke = action('Revoke', 'x', () => {
      const yes = action('Revoke access', null, async () => { try { await window.forge.remoteRevoke(dev.id); toast(`${dev.name} can no longer open Forge`) } catch (e) { toast(cleanErr(e), 4000) } void rerender() }, 'danger')
      const no = action('Keep', null, () => void rerender())
      revoke.replaceWith(yes, no); yes.focus()
    }, 'danger-quiet')
    revoke.setAttribute('aria-label', `Revoke ${dev.name}`)
    d.box.append(row(dev.name, `Paired ${new Date(dev.createdAt).toLocaleDateString()} · last seen ${timeAgo(dev.lastSeen)}`, revoke))
  }
  into.append(d.g)
  await notifications(into)
}

// Phone notifications through ntfy: short generic messages, nothing about the code.
async function notifications(into: HTMLElement) {
  if (typeof window.forge.pushGet !== 'function') return
  const s = await window.forge.pushGet()
  const set = async (o: { enabled?: boolean; server?: string; includeProject?: boolean }) => { try { await window.forge.pushSet(o) } catch (e) { toast(cleanErr(e), 4000) } void rerender() }
  const g = group('Notifications', 'Install the free ntfy app on your phone and subscribe to the topic below. Forge sends short generic messages only; nothing about your code leaves your computer.')
  const server = field('text', s.server, 'https://ntfy.sh')
  server.onchange = () => void set({ server: server.value })
  const topic = h('div', 'pair-link')
  topic.append(h('code', 'k', s.topic), action('Copy', 'copy', () => void copy(s.topic, 'Topic copied')))
  const test = action('Send a test', 'bell', async () => {
    test.disabled = true
    result.textContent = 'Sending…'
    result.className = 'remote-state'
    try {
      const r = await window.forge.pushTest()
      result.textContent = r.ok ? 'Sent. It should appear on your phone.' : r.error ?? 'It did not go out.'
      result.className = `remote-state ${r.ok ? 'ok' : 'bad'}`
    } catch (e) { result.textContent = cleanErr(e); result.className = 'remote-state bad' }
    finally { test.disabled = false }
  })
  const result = h('div', 'remote-state')
  result.setAttribute('role', 'status')
  const testRow = row('Send a test', 'Sends one message to the topic now, even while notifications are off.', test)
  testRow.querySelector('.srl')?.append(result)
  const fresh = action('New topic', null, async () => { try { await window.forge.pushNewTopic(); toast('New topic. Subscribe to it in the ntfy app.') } catch (e) { toast(cleanErr(e), 4000) } void rerender() })
  g.box.append(
    row('Notify my phone', 'When Crew needs an answer, a run is ready or failed, or a limit stopped it, and this window is not in front.', onOff(s.enabled, (v) => void set({ enabled: v }))),
    row('Server', 'The ntfy server that delivers the message. https only.', server),
    row('Topic', 'Anyone who knows it can read these messages, so keep it to yourself.', topic),
    testRow,
    row('Include the project folder name', 'Adds the folder’s name to the message. The path, goals, messages and file names are never sent.', onOff(s.includeProject, (v) => void set({ includeProject: v }))),
    row('Change the topic', 'Use this if the topic was shared. Subscribe to the new one in the ntfy app.', fresh),
  )
  into.append(g.g)
}

async function usage(into: HTMLElement) {
  await renderUsage(into)
}

// ---- the page ----
const skills = (into: HTMLElement) => { into.append(renderSkillsPanel()) }
const BUILD: Record<Page, (into: HTMLElement) => void | Promise<void>> = { general, appearance, shortcuts, models, agent, team, skills, remote, usage, privacy, about }
let current: Page = 'general'
let body: HTMLElement | null = null
let scroller: HTMLElement | null = null // .set-main scrolls, not the body
let headTitle: HTMLElement | null = null
let headNote: HTMLElement | null = null // a page's save status, right of the title
let searchEl: HTMLInputElement | null = null
let query = ''
let token = 0

function skeleton(): HTMLElement {
  const w = h('div')
  w.append(h('div', 'skel skel-title'))
  for (let i = 0; i < 3; i++) w.append(h('div', 'skel skel-row'))
  return w
}

// With a search, every page is built and only rows whose label or description match stay visible.
async function rerender() {
  if (!body) return
  const mine = ++token
  const scroll = scroller?.scrollTop ?? 0
  const fresh = h('div')
  const slow = setTimeout(() => { if (mine === token) body?.replaceChildren(skeleton()) }, 120) // only if the page takes a moment
  const q = query.trim().toLowerCase()
  if (!q) await BUILD[current](fresh)
  else for (const [id, , label] of PAGES) {
    if (id === 'usage' || id === 'skills') continue // these load their own content
    const part = h('div')
    await BUILD[id](part)
    part.querySelectorAll<HTMLElement>('.srow').forEach((r) => (r.hidden = !r.textContent!.toLowerCase().includes(q)))
    part.querySelectorAll<HTMLElement>('.sgroup').forEach((g) => (g.hidden = !g.querySelector('.srow:not([hidden])')))
    part.querySelectorAll(':scope > :not(.sgroup)').forEach((n) => n.remove())
    if (!part.querySelector('.sgroup:not([hidden])')) continue
    const t = h('button', 'set-hit-page', label)
    t.prepend(icon(GLYPH[id], 'sm'))
    t.append(icon('arrowright', 'sm'))
    t.title = `Open ${label}`
    t.onclick = () => { query = ''; if (searchEl) searchEl.value = ''; void show(id) }
    fresh.append(t, ...part.childNodes)
  }
  if (q && !fresh.childNodes.length) fresh.append(h('p', 'set-none', `No settings match “${query.trim()}”.`))
  clearTimeout(slow)
  if (mine !== token) return
  body.replaceChildren(...fresh.childNodes)
  if (scroller) scroller.scrollTop = q ? 0 : scroll // a redraw of the same page keeps its place
}

async function show(page: Page) {
  current = page
  document.querySelectorAll<HTMLElement>('.set-nav [data-page]').forEach((b) => {
    const on = b.dataset.page === page && !query
    b.classList.toggle('on', on)
    if (on) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  })
  if (headTitle) headTitle.replaceChildren(icon(query ? 'search' : GLYPH[page]), document.createTextNode(query ? 'Search results' : TITLE[page]))
  if (scroller) scroller.scrollTop = 0 // every page opens at its top
  headNote?.replaceChildren()
  if (body) { body.classList.remove('turn'); void body.offsetWidth; body.classList.add('turn') } // the page fades in
  await rerender()
}

// On a phone the page list is the first screen; a page opened from it (or asked for directly) gets a Back arrow.
export async function openSettings(asked?: Page) {
  const page = asked ?? 'general'
  const dlg = $<HTMLDialogElement>('settings')
  query = ''
  const nav = h('nav', 'set-nav')
  nav.setAttribute('aria-label', 'Settings pages')
  const back = h('button', 'set-back', 'Back to app')
  back.prepend(icon('arrowleft', 'sm'))
  back.title = 'Back to app (Esc)'
  back.onclick = () => dlg.close()
  const search = h('label', 'set-search')
  const input = field('search', '', 'Search settings')
  searchEl = input
  input.setAttribute('aria-label', 'Search settings')
  let timer: ReturnType<typeof setTimeout> | null = null
  input.oninput = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { query = input.value; wrap.classList.toggle('show-page', !!query || wrap.classList.contains('show-page')); void show(current) }, 140) }
  input.onkeydown = (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; query = ''; void show(current) } }
  search.append(icon('search', 'sm'), input, h('kbd', '', 'Ctrl F'))
  nav.append(back, search)
  for (const [label, items] of NAV) {
    nav.append(h('div', 'set-group-label', label))
    for (const [id, glyph, text] of items) {
      const b = h('button', 'set-item')
      b.dataset.page = id
      b.append(icon(glyph, 'sm'), h('span', 'lbl', text))
      b.title = text
      b.onclick = () => { if (query) { query = ''; input.value = '' } wrap.classList.add('show-page'); void show(id) }
      nav.append(b)
    }
  }
  const main = h('section', 'set-main')
  scroller = main
  const inner = h('div', 'set-inner')
  const head = h('div', 'set-head')
  main.addEventListener('scroll', () => head.classList.toggle('stuck', main.scrollTop > 2), { passive: true }) // the head's line shows once something is under it
  headTitle = h('h3')
  const up = h('button', 'icon-btn set-up phone-only') as HTMLButtonElement
  up.append(icon('arrowleft'))
  up.title = 'All settings'
  up.setAttribute('aria-label', 'All settings')
  up.onclick = () => { wrap.classList.remove('show-page'); nav.querySelector<HTMLElement>(`[data-page="${current}"]`)?.focus() }
  headNote = h('div', 'set-head-note')
  head.append(up, headTitle, headNote)
  body = h('div', 'set-body')
  inner.append(head, body)
  main.append(inner)
  const wrap = h('div', asked ? 'set show-page' : 'set')
  wrap.append(nav, main)
  wrap.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); input.focus() } }
  dlg.replaceChildren(wrap)
  if (!dlg.open) dlg.showModal()
  back.focus()
  await show(page)
}
