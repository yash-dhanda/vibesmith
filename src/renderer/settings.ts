import { getCustomIds, loadModels, setCustomIds } from './models'
import { $, MINUTE_CHOICES, STEP_CHOICES, agentLimits, cleanErr, h, numCtxPref, setThemePref, themePref, toast, type ThemePref } from './ui'
import { icon, type IconName } from './icons'
import { openLibrary } from './library'
import { renderUsage } from './usage'

export type Page = 'general' | 'models' | 'agent' | 'usage' | 'shortcuts' | 'about'
const PAGES: [Page, IconName, string][] = [
  ['general', 'sliders', 'General'],
  ['models', 'cube', 'Models'],
  ['agent', 'bolt', 'Agent'],
  ['usage', 'chart', 'Usage'],
  ['shortcuts', 'keyboard', 'Shortcuts'],
  ['about', 'info', 'About'],
]
const TITLES: Record<Page, string> = { general: 'General', models: 'Models', agent: 'Agent', usage: 'Usage', shortcuts: 'Keyboard shortcuts', about: 'About Forge' }

// ---- building blocks: a group is a title plus a box of rows, a row is a label on the left and a control on the right ----
const group = (title?: string, desc?: string) => {
  const g = h('div', 'sgroup')
  if (title) g.append(h('div', 'gt', title))
  if (desc) g.append(h('div', 'gd', desc))
  const box = h('div', 'sbox')
  g.append(box)
  return { g, box }
}

function row(title: string, desc: string, ...controls: HTMLElement[]) {
  const r = h('div', 'srow')
  const t = h('div')
  t.append(h('div', 'st-t', title))
  if (desc) t.append(h('div', 'st-d', desc))
  const c = h('div', 'ctl')
  c.append(...controls)
  for (const control of c.querySelectorAll('input, select')) control.setAttribute('aria-label', title)
  r.append(t, c)
  return r
}

function seg<T extends string>(options: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  const wrap = h('div', 'seg')
  for (const [v, label] of options) {
    const b = h('button', v === value ? 'on' : '', label) as HTMLButtonElement
    b.type = 'button'
    b.onclick = () => {
      wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'))
      b.classList.add('on')
      onPick(v)
    }
    wrap.append(b)
  }
  return wrap
}

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const w = h('label', 'switch')
  const i = document.createElement('input')
  i.type = 'checkbox'
  i.checked = on
  i.onchange = () => onChange(i.checked)
  w.append(i, h('i'))
  return w
}

const save = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v)
  } catch {}
}

// ---- pages ----
async function general(into: HTMLElement) {
  const a = group('Appearance')
  a.box.append(row('Theme', 'Dark, light, or follow your system.', seg<ThemePref>([['dark', 'Dark'], ['light', 'Light'], ['system', 'System']], themePref(), setThemePref)))
  into.append(a.g)

  const b = group('Behavior')
  let mode = 'ask-all'
  try {
    mode = localStorage.getItem('forge.mode') ?? 'ask-all'
  } catch {}
  b.box.append(
    row(
      'Default autonomy',
      'How much Forge may do before asking you. You can still change it for each message.',
      seg<string>([['ask-all', 'Ask first'], ['auto-edit', 'Auto-edit'], ['full-auto', 'Full auto']], mode, (v) => {
        save('forge.mode', v)
        $<HTMLSelectElement>('mode').value = v
      }),
    ),
  )
  const prefs = await window.forge.prefsGet()
  b.box.append(row('Notifications', 'Tell me when work in the background finishes or needs my approval.', toggle(prefs.notify, (v) => window.forge.prefsSet('notify', v))))
  into.append(b.g)

  const m = group('What the autonomy levels mean')
  m.box.append(
    row('Ask first', 'Asks before every file change and before every command. Reading is always allowed.', h('span', 'badge', 'safest')),
    row('Auto-edit', 'Creates and edits files freely. Asks before commands, except safe ones like npm test and git status.', h('span', 'badge', 'balanced')),
    row('Full auto', 'Does everything without asking. Needs a project check so something verifies the work.', h('span', 'badge', 'hands-off')),
  )
  into.append(m.g)
}

async function models(into: HTMLElement) {
  const [ol, keys] = await Promise.all([window.forge.ollamaStatus(), window.forge.keysStatus()])

  if (typeof window.forge.engineHostGet === 'function') {
    const host = await window.forge.engineHostGet()
    const location = group('Where models run', 'Use this computer or an AI engine on another computer on your network.')
    const address = document.createElement('input')
    address.type = 'text'
    address.value = host.host
    address.placeholder = '192.168.1.20:11434'
    const memory = document.createElement('input')
    memory.type = 'number'
    memory.min = '1'
    memory.max = '1024'
    memory.value = String(host.vramGB)
    const result = h('div', 'hint')
    result.setAttribute('role', 'status')
    const test = h('button', 'btn', 'Test connection') as HTMLButtonElement
    test.onclick = async () => {
      test.disabled = true
      try { const checked = await window.forge.engineHostTest(address.value); result.textContent = checked.ok ? `Connected · ${checked.models} models available` : 'Engine didn’t respond. Check the address.' }
      catch (e) { result.textContent = cleanErr(e) }
      finally { test.disabled = false }
    }
    const use = h('button', 'btn primary', 'Use this address') as HTMLButtonElement
    use.onclick = async () => {
      use.disabled = true
      try { await window.forge.engineHostSet(address.value, Number(memory.value)); await loadModels(); result.textContent = 'Saved. Models now run on that computer.' }
      catch (e) { result.textContent = cleanErr(e) }
      finally { use.disabled = false }
    }
    const here = h('button', 'btn', 'Use this computer')
    here.onclick = async () => {
      try { await window.forge.engineHostSet(''); address.value = ''; await loadModels(); result.textContent = 'Models now use this computer.' }
      catch (e) { result.textContent = cleanErr(e) }
    }
    location.box.append(row('Engine address', host.host ? 'Currently using another computer.' : 'Currently using this computer.', address), row('Remote GPU memory (GB)', 'Used to estimate which models will fit.', memory), row('Connection', '', test, use, here), result)
    into.append(location.g)
  }

  const local = group('AI models', 'Ollama models run on the computer selected above. No per-token fees.')
  const lib = h('button', 'btn primary', 'Open the model library')
  lib.onclick = () => {
    $<HTMLDialogElement>('settings').close()
    openLibrary()
  }
  local.box.append(row('Model library', 'Download, switch and delete models without leaving Forge.', lib))
  local.box.append(
    row(
      'Ollama',
      ol.up ? (ol.models.length ? `Running. These models are installed.${ol.loaded[0] ? ` ${ol.loaded[0].name} is loaded (${ol.loaded[0].gpuPercent}% on the GPU).` : ''}` : 'Running, but no models are installed yet.') : 'Not reachable at 127.0.0.1:11434.',
      h('span', 'badge ' + (ol.up ? 'ok' : 'bad'), ol.up ? `Running · ${ol.models.length} model${ol.models.length === 1 ? '' : 's'}` : 'Not running'),
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
      seg<string>([['4096', '4k'], ['8192', '8k'], ['16384', '16k'], ['32768', '32k']], String(numCtxPref()), (v) => save('forge.numctx', v)),
    ),
  )
  into.append(local.g)

  const cloud = group('Cloud models', 'Use a provider with your own API key. Keys are stored encrypted by your OS keychain and only sent to that provider.')
  for (const [p, name, note] of [
    ['anthropic', 'Anthropic', 'Claude Sonnet, Opus and Haiku are built in.'],
    ['openai', 'OpenAI', 'Add the model names you want to use.'],
    ['openrouter', 'OpenRouter', 'One key for many models. Add the model names you want to use.'],
  ] as const) {
    const input = document.createElement('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.placeholder = keys[p] ? '•••••••• saved. Paste to replace' : 'Paste API key'
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
      const rm = h('button', 'btn danger', 'Remove')
      rm.onclick = async () => {
        await window.forge.keysClear(p)
        await loadModels()
        rerender()
      }
      ctl.push(rm)
    }
    cloud.box.append(row(name, note, h('span', 'badge ' + (keys[p] ? 'ok' : ''), keys[p] ? 'Connected' : 'Not connected')), row('API key', '', ...ctl))
    if (p !== 'anthropic') {
      const ids = document.createElement('input')
      ids.placeholder = 'model-one, model-two'
      ids.value = getCustomIds(p).join(', ')
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
    row('Steps per run', 'One step is one model call. Reading a file, editing it and running tests are three or more.', seg<string>(STEP_CHOICES.map((n) => [String(n), String(n)] as [string, string]), String(lim.maxSteps), (v) => save('forge.maxsteps', v))),
    row('Time per run', 'The longest one run may keep working.', seg<string>(MINUTE_CHOICES.map((n) => [String(n), n >= 60 ? `${n / 60}h` : `${n}m`] as [string, string]), String(lim.maxMinutes), (v) => save('forge.maxmin', v))),
  )
  into.append(l.g)

  const verify = await window.forge.verifyGet()
  const p = group('This project', verify ? 'Settings for the folder of the chat you are looking at.' : 'Open or start a chat in a folder to set this.')
  if (verify) {
    const vin = document.createElement('input')
    vin.placeholder = verify.detected ? `${verify.detected} (detected)` : 'e.g. npm test'
    vin.value = verify.configured ?? ''
    vin.onchange = () => window.forge.verifySet(vin.value)
    p.box.append(row('Check command', 'Runs when the agent says it is done after editing. If it fails, the output goes back to the agent. Full auto requires one.', vin))
    into.append(p.g)
  }

  const s = group('Safety, always on')
  s.box.append(
    row('Folder jail', 'The agent can only read and change files inside the chat’s folder, including through links and new folders.', h('span', 'badge ok', 'on')),
    row('Undo', 'Every run is snapshotted with git first. Press Undo on the changes card to put everything back.', h('span', 'badge ok', 'on')),
    row('Blocked commands', 'sudo, recursive deletes of / or ~, disk formatting and “pipe a download into a shell” are refused in every mode.', h('span', 'badge ok', 'on')),
    row('Package check', 'Before an install, package names are looked up in the npm or PyPI registry. Made-up names are refused.', h('span', 'badge ok', 'on')),
  )
  into.append(s.g)
}

function shortcuts(into: HTMLElement) {
  const g = group()
  for (const [k, v] of [
    ['Ctrl N', 'New chat'],
    ['Ctrl K', 'Find actions, chats and models'],
    ['Ctrl L', 'Focus the message box'],
    ['Ctrl B', 'Show or hide chat history'],
    ['Ctrl J', 'Show or hide the workspace (files, editor, terminal)'],
    ['Ctrl ,', 'Open settings'],
    ['Esc', 'Stop the agent'],
    ['Enter', 'Send the message'],
    ['Shift Enter', 'New line in the message'],
  ]) {
    const kbd = h('kbd', '', k)
    g.box.append(row(v, '', kbd))
  }
  into.append(g.g)
}

async function about(into: HTMLElement) {
  const info = await window.forge.appInfo()
  const g = group()
  const open = h('button', 'btn', 'Open folder')
  open.onclick = () => window.forge.openDataDir()
  g.box.append(
    row('Forge', 'A chat app that builds software on your computer with local or cloud AI.', h('span', 'badge', `v${info.version}`)),
    row('Your data', `Chats, usage and settings are stored on this computer only: ${info.dataDir}`, open),
    row('Runtime', `Electron ${info.electron} on ${info.platform}`, h('span', 'badge', 'local')),
  )
  into.append(g.g)
}

async function usage(into: HTMLElement) {
  await renderUsage(into)
}

// ---- the dialog ----
const BUILD: Record<Page, (into: HTMLElement) => void | Promise<void>> = { general, models, agent, usage, shortcuts, about }
let current: Page = 'general'
let body: HTMLElement | null = null
let headTitle: HTMLElement | null = null

function skeleton(): HTMLElement {
  const w = h('div')
  w.append(h('div', 'skel skel-title'))
  const box = h('div', 'sbox')
  for (let i = 0; i < 3; i++) box.append(h('div', 'skel skel-row'))
  w.append(box)
  return w
}

async function rerender() {
  if (!body) return
  const scroll = body.scrollTop
  const fresh = h('div')
  const slow = setTimeout(() => body?.replaceChildren(skeleton()), 120) // only if the page takes a moment
  await BUILD[current](fresh)
  clearTimeout(slow)
  body.replaceChildren(...fresh.childNodes)
  body.scrollTop = scroll
}

async function show(page: Page) {
  current = page
  document.querySelectorAll('.set-nav button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.page === page))
  if (headTitle) headTitle.textContent = TITLES[page]
  if (body) body.scrollTop = 0
  await rerender()
}

export async function openSettings(page: Page = 'general') {
  const dlg = $<HTMLDialogElement>('settings')
  const nav = h('nav', 'set-nav')
  nav.append(h('h2', '', 'Settings'))
  for (const [id, iconName, label] of PAGES) {
    const b = h('button')
    b.dataset.page = id
    b.append(icon(iconName), document.createTextNode(label))
    b.onclick = () => show(id)
    nav.append(b)
  }
  const main = h('section', 'set-main')
  const head = h('div', 'set-head')
  headTitle = h('h3')
  const close = h('button', 'icon-btn')
  close.append(icon('x'))
  close.title = 'Close (Esc)'
  close.setAttribute('aria-label', 'Close settings')
  close.onclick = () => dlg.close()
  head.append(headTitle, close)
  body = h('div', 'set-body')
  main.append(head, body)
  const wrap = h('div', 'set')
  wrap.append(nav, main)
  dlg.replaceChildren(wrap)
  if (!dlg.open) dlg.showModal()
  close.focus()
  await show(page)
}

