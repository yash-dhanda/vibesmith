import { keyCard } from './keyCard'
import { keyLines, withoutKey } from '../main/keyAnswer'
import type { AgentEvent, ChatListItem, Mode, TranscriptItem } from '../preload'
import { exportMarkdown, folderName, formatRate, formatTokens, matchesQuery, md, toolTarget, toolVerb } from './format'
import { fileIcon, icon, type IconName } from './icons'
import { mark } from './glyphs'
import { renderHistory } from './history'
import { openDashboard } from './dashboard'
import { openRestorePoints } from './restorePanel'
import { attachVoice } from './voice'
import { openRules } from './rulesPanel'
import { openReferences } from './referencesPanel'
import { openGithubTop } from './githubTop'
import { openIdeas } from './ideas'
import { openImprove } from './improve'
import { initLibrary, openLibrary } from './library'
import { initModels, noModels, selectedModel } from './models'
import type { Page } from './settings'
import { $, agentLimits, cleanErr, copy, h, numCtxPref, showMenu, toast, uuid } from './ui'
import { initUsage, setUsage } from './usage'
import { initBrief, resetBrief, projectBrief, briefGoal, briefEvent, briefUndone, withPriorities } from './brief'
import { initPalette } from './palette'
import { attachmentStrip, sentChips, type Kind } from './attachments'
import { cacheGet, cacheSet, isRemote, onResync, phone, toggleDrawer } from './phone'
import { morphChildren } from './morph'

// Settings is its own chunk: nothing on the first screen needs it.
const openSettings = (page?: Page) => import('./settings').then((m) => m.openSettings(page)).catch((e) => toast(cleanErr(e), 4000))

const thread = $('thread')
const scroller = $('thread-scroll')
const prompt = $<HTMLTextAreaElement>('prompt')
const sendBtn = $<HTMLButtonElement>('send')
const modeSel = $<HTMLSelectElement>('mode')
const projectBtn = $<HTMLButtonElement>('project')
const titleEl = $('chat-title')
const rateChip = $('rate')
const ctxChip = $('ctx')
const toBottom = $('to-bottom')
const searchEl = $<HTMLInputElement>('chat-search')

// ---- attachments: pictures go to the model, text and code files are added to the message ----
// Which local models can see: the library's vision tag, or a name that says so. The main process asks Ollama for sure when sending.
// ponytail: name heuristic for models outside the catalog; an IPC for Ollama's capabilities would make it exact.
let visionIds = new Set<string>()
let catalogAsked = false
const VISION_NAME = /(^|[-_.:])vl\b|vision|llava|moondream|minicpm-v|qwen3\.5|gemma[34]|llama4/i
const canSee = (id: string) => !id.startsWith('ollama:') || visionIds.has(id.slice(7)) || VISION_NAME.test(id.slice(7))
const att = attachmentStrip({
  host: $('composer'), textarea: prompt, max: 8, maxBytes: 15 * 1024 * 1024,
  limits: 'Up to 8 files: pictures up to 15 MB, text files up to 1 MB.',
  note: 'Pictures go to the model; text and code files are added to your message.',
  upload: async (file) => {
    // The phone link sends calls as JSON, which cannot carry raw bytes yet: Crew takes files there.
    if (isRemote()) throw new Error('Attach files to Solo chats on the computer, or use Crew on this phone.')
    const [a] = await window.forge.attachmentsAdd(activeId, [{ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }])
    if (!a) throw new Error(`Forge did not keep ${file.name}.`)
    return { id: a.id, name: a.name, size: a.size, kind: a.kind }
  },
  explain: (e) => (/not a picture or a text file/i.test(cleanErr(e)) ? 'Solo chat reads pictures and text files; attach videos and other files in Crew.' : cleanErr(e)),
  warn: (item) => {
    if (item.kind !== 'image') return ''
    if (!catalogAsked && typeof window.forge.modelsCatalog === 'function') { catalogAsked = true; void window.forge.modelsCatalog().then((c) => { visionIds = new Set(c.filter((m) => m.tags.includes('vision')).map((m) => m.id)); att.redraw() }).catch(() => {}) }
    return canSee(selectedModel()) ? '' : "This model can't see pictures; pick a vision model or use Crew."
  },
  onChange: () => { if (!running) sendBtn.disabled = att.busy() },
})

// ---- what the screen is showing ----
let activeId: string = uuid() // a new chat gets its id up front, so live events can be matched to it
let chats: ChatListItem[] = []
let crewRuns: import('../main/team/service').RunSummary[] = []
let project: string | null = null
let query = ''
let hasMessages = false
let running = false
let sending = false // between pressing send and the main process starting the run
let log: TranscriptItem[] = [] // mirror of what is on screen, for export

// per-run display state
let emptyEl: HTMLElement | null = null
let emptySub: HTMLElement | null = null
let reply: { el: HTMLElement; text: string } | null = null
// Streaming text is drawn at most once a frame (every 100 ms on a phone), not once per token: each draw re-renders the whole reply.
let replyDirty = false, replyFrame = 0, replyTimer: ReturnType<typeof setTimeout> | null = null, replyDrawn = 0
function drawReply() {
  replyFrame = 0; replyTimer = null
  if (!reply || !replyDirty) return
  replyDirty = false; replyDrawn = performance.now()
  const stick = nearBottom()
  const key = keyLines(reply.text)
  const next = document.createElement('div')
  next.innerHTML = md(key.length ? withoutKey(reply.text) : reply.text)
  morphChildren(reply.el, next) // ponytail: diffs the whole reply each frame; go back to innerHTML past ~200 KB if it shows in a profile
  if (stick) toEnd()
}
function scheduleReply() {
  replyDirty = true
  if (replyFrame || replyTimer) return
  const wait = isRemote() ? 100 - (performance.now() - replyDrawn) : 0
  if (wait > 0) replyTimer = setTimeout(() => { replyTimer = null; replyFrame = requestAnimationFrame(drawReply) }, wait)
  else replyFrame = requestAnimationFrame(drawReply)
}
function flushReply() {
  if (replyFrame) cancelAnimationFrame(replyFrame)
  if (replyTimer) clearTimeout(replyTimer)
  drawReply()
}
let thinkingEl: HTMLElement | null = null
let runUsage = { input: 0, output: 0, genSec: 0, calls: 0 }
const live = { chars: 0, start: 0, timer: null as ReturnType<typeof setInterval> | null }

type Card = { dot: HTMLElement; body: HTMLElement; name: string; path: string; group: { failed: boolean }; actions?: HTMLElement }
const cards = new Map<string, Card>()

let onFileChanged: (path: string) => void = () => {}
let onFilesRestored: (paths: string[]) => void = () => {}
let onProject: (root: string | null) => Promise<void> | void = () => {}
let openWorkspace: () => void | Promise<void> = () => {}

const statusOf = (id: string) => chats.find((c) => c.id === id)?.status ?? 'idle'

// ---- scrolling ----
const nearBottom = (slack = 80) => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < slack
const toEnd = () => (scroller.scrollTop = scroller.scrollHeight)
// Rows drawn for the first time (content-visibility) take their real height a frame later: keep landing on the end until it holds.
function settleEnd(frames = 8) {
  const step = () => { if (!frames--) return; if (!nearBottom(2)) toEnd(); requestAnimationFrame(step) }
  requestAnimationFrame(step)
}
const add = (el: HTMLElement) => {
  const stick = nearBottom()
  thread.insertBefore(el, thinkingEl) // the "thinking" dots always stay last
  if (stick) toEnd()
  return el
}

// Writing a big file can be silent for minutes on a slow machine: show how long the wait has been, so it does not look hung.
let thinkingTimer: ReturnType<typeof setInterval> | null = null
function showThinking() {
  if (thinkingEl) return
  const el = (thinkingEl = h('div', 'thinking'))
  const clock = h('span', 'clock')
  el.append(h('i'), h('i'), h('i'), clock)
  const t0 = Date.now()
  thinkingTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000)
    clock.textContent = s >= 8 ? (s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`) : ''
  }, 1000)
  thread.append(el)
  if (nearBottom()) toEnd()
}
function hideThinking() {
  if (thinkingTimer) clearInterval(thinkingTimer)
  thinkingTimer = null
  thinkingEl?.remove()
  thinkingEl = null
}

// ---- header chips: speed and memory ----
function startLive() {
  live.chars = 0
  live.start = 0
  rateChip.classList.add('live')
  live.timer ??= setInterval(() => {
    const secs = (performance.now() - live.start) / 1000
    if (!live.start || secs < 0.8) return
    rateChip.hidden = false
    rateChip.textContent = `~${formatRate(live.chars / 4 / secs)} tok/s`
  }, 400)
}
function stopLive() {
  if (live.timer) clearInterval(live.timer)
  live.timer = null
  rateChip.classList.remove('live')
}
function setUsageChips(ev: Extract<AgentEvent, { type: 'usage' }>) {
  live.chars = 0
  live.start = 0
  if (ev.tps > 0) {
    rateChip.hidden = false
    rateChip.textContent = `${formatRate(ev.tps)} tok/s`
  }
  ctxChip.hidden = false
  const estimate = ev.estimated ? '~' : ''
  ctxChip.textContent = (estimate + (ev.ctxLimit ? `${formatTokens(ev.input)} / ${Math.round(ev.ctxLimit / 1024)}k` : `${formatTokens(ev.input)}`))
  const full = !!ev.ctxLimit && ev.input / ev.ctxLimit > 0.8
  ctxChip.classList.toggle('warn', full)
  ctxChip.title = full
    ? 'The model is close to its memory limit and will start forgetting the start of this chat. Start a new chat for new work, or raise the size in Settings.'
    : "How much of the model's memory this chat uses"
}

// ---- empty state ----
const STARTERS: { glyph: IconName; title: string; hint: string }[] = [
  { glyph: 'bot', title: 'Build a Telegram bot', hint: 'Creates the files, then asks for what it still needs' },
  { glyph: 'globe', title: 'Make a simple website', hint: 'HTML, CSS and a little JavaScript, ready to open' },
  { glyph: 'search', title: 'Explain this project', hint: 'Reads the folder and tells you how it works' },
  { glyph: 'bug', title: 'Find and fix bugs', hint: 'Runs your tests and repairs what fails' },
]

function showEmpty() {
  emptyEl = h('div', 'empty')
  emptySub = h('div', 'sub')
  emptyEl.append(h('h2', '', 'What are we building?'), emptySub)
  const list = h('div', 'suggest')
  for (const t of STARTERS) {
    const b = h('button')
    b.title = t.hint
    b.append(icon(t.glyph, 'sm'), t.title)
    b.onclick = () => {
      prompt.value = t.title
      prompt.focus()
      grow()
    }
    list.append(b)
  }
  emptyEl.append(list)
  if (noModels) {
    const b = h('div', 'banner')
    b.append(h('div', '', 'No AI model found. Download one from the model library, or add an API key.'))
    const open = h('button', 'btn primary', 'Open the model library')
    open.onclick = () => openLibrary()
    b.append(open)
    emptyEl.append(b)
  }
  thread.append(emptyEl)
  setProject(project)
}

function setProject(p: string | null) {
  project = p
  projectBrief(p)
  projectBtn.replaceChildren(icon('folder', 'sm'), document.createTextNode(p ? folderName(p) : 'Choose folder'))
  projectBtn.title = hasMessages ? `This chat works in ${p}` : (p ?? 'Choose the folder the agent works in')
  projectBtn.classList.toggle('need', !p)
  projectBtn.disabled = hasMessages || isRemote() // the phone cannot open the computer's folder dialog
  projectBtn.hidden = isRemote() && !p
  if (emptySub) emptySub.textContent = p ? `Working in ${folderName(p)}. Say what it should do.` : 'A website, a small tool, something just for you.'
}

function setRunning(on: boolean) {
  running = on
  sendBtn.classList.toggle('stop', on)
  sendBtn.replaceChildren(icon(on ? 'stop' : 'arrowup'))
  sendBtn.title = on ? 'Stop (Esc)' : 'Send'
  sendBtn.setAttribute('aria-label', on ? 'Stop building' : 'Send message')
  sendBtn.disabled = !on && att.busy()
  if (on) startLive()
  else {
    stopLive()
    hideThinking()
  }
}

// ---- agent steps, collapsed into one line like Claude and Codex ----
type Group = { el: HTMLElement; dot: HTMLElement; label: HTMLElement; body: HTMLElement; counts: Map<string, number>; failed: boolean }
let group: Group | null = null
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const PHRASE: Record<string, (n: number) => string> = {
  Read: (n) => `read ${plural(n, 'file', 'files')}`,
  Listed: (n) => `looked at ${plural(n, 'folder', 'folders')}`,
  Searched: (n) => `searched ${plural(n, 'time', 'times')}`,
  Edited: (n) => `edited ${plural(n, 'file', 'files')}`,
  Created: (n) => `created ${plural(n, 'file', 'files')}`,
  Ran: (n) => `ran ${plural(n, 'command', 'commands')}`,
}

function summarize(g: Group, working: boolean) {
  const text = [...g.counts].map(([v, n]) => (PHRASE[v] ?? ((k: number) => `${v.toLowerCase()} ×${k}`))(n)).join(', ')
  g.el.classList.toggle('working', working)
  const words = working ? `Building · ${text}…` : `${g.failed ? 'Needs attention' : 'Done'} · ${text}`
  if (g.label.textContent !== words) g.label.textContent = words // patched in place: no restarted animation
}

function ensureGroup(): Group {
  if (group) return group
  const el = h('div', 'steps working')
  const head = h('button', 'steps-head')
  const dot = mark('active')
  const label = h('span', 'steps-label')
  label.textContent = 'Getting to know your project…'
  const chev = h('span', 'chev')
  chev.append(icon('chevron', 'sm'))
  head.append(dot, label, chev)
  const body = h('div', 'steps-body')
  body.hidden = true
  head.setAttribute('aria-expanded', 'false')
  head.onclick = () => {
    body.hidden = !body.hidden
    head.setAttribute('aria-expanded', String(!body.hidden))
    el.classList.toggle('open', !body.hidden)
  }
  el.append(head, body)
  add(el)
  return (group = { el, dot, label, body, counts: new Map(), failed: false })
}

function finishGroup() {
  if (!group) return
  group.dot.dataset.state = group.failed ? 'failed' : 'done'
  summarize(group, false)
  group = null
}

function diff(oldText: string, newText: string): HTMLElement {
  const box = h('div')
  const lines = (txt: string, cls: string, sign: string) => {
    if (!txt) return
    const rows = txt.split('\n')
    for (const r of rows.slice(0, 60)) box.append(h('div', `ln ${cls}`, `${sign} ${r}`))
    if (rows.length > 60) box.append(h('div', 'ln more', `… ${rows.length - 60} more lines`))
  }
  lines(oldText, 'del', '−')
  lines(newText, 'add', '+')
  return box
}

function toolCard(ev: Extract<AgentEvent, { type: 'tool' }>) {
  const a = (ev.args ?? {}) as Record<string, string>
  const path = toolTarget(ev.args)
  const verb = toolVerb(ev.name, ev.args)
  const story = ({ read_file: 'Reading your project', list_dir: 'Exploring the folder', search: 'Finding the right place', edit_file: 'Updating your project', create_file: 'Creating something new', run_command: 'Running a project command' } as Record<string, string>)[ev.name] ?? 'Working on your project'
  const writes = ev.name === 'edit_file' || ev.name === 'create_file'

  const card = h('div', 'tool')
  const head = h('button', 'tool-head')
  const dot = mark('active')
  const toolLabel = h('span', 'tool-label')
  toolLabel.append(ev.label || story)
  head.append(dot, toolLabel, h('span', 'tool-path', path))
  const body = h('div', 'tool-body')
  body.hidden = true
  if (ev.name === 'edit_file') body.append(diff(String(a.old_text ?? ''), String(a.new_text ?? '')))
  if (ev.name === 'create_file') body.append(diff('', String(a.content ?? '')))
  if (ev.name === 'run_command') body.append(h('pre', '', `$ ${path}`))
  head.setAttribute('aria-expanded', String(!body.hidden))
  head.onclick = () => { body.hidden = !body.hidden; head.setAttribute('aria-expanded', String(!body.hidden)) }
  card.append(head, body)

  const g = ensureGroup()
  g.counts.set(verb, (g.counts.get(verb) ?? 0) + 1)
  summarize(g, true)
  const entry: Card = { dot, body, name: writes ? 'write' : ev.name, path, group: g }
  if (ev.needsApproval) {
    dot.dataset.state = 'ask'
    card.classList.add('needs-approval')
    const explanation = h('div', 'approval-summary')
    const ask = h('strong', '', 'A quick check before I continue')
    ask.prepend(mark('ask'))
    explanation.append(ask, h('p', '', writes ? `${ev.name === 'create_file' ? 'Create' : 'Change'} ${path}. This updates files in your project folder.` : `Run this command in your project folder: ${path}`), h('span', '', 'Open the step above to inspect the exact details.'))
    card.append(explanation)
    g.body.hidden = false // an action that needs a yes must be visible
    g.el.classList.add('open')
    g.el.querySelector('button')?.setAttribute('aria-expanded', 'true')
    const actions = h('div', 'approve')
    const yes = h('button', 'yes', 'Allow')
    yes.title = writes ? 'Allow this change' : 'Allow this command'
    yes.setAttribute('aria-label', yes.title)
    const no = h('button', '', 'Skip')
    no.title = 'Skip this step'
    no.setAttribute('aria-label', no.title)
    const answer = (ok: boolean) => {
      actions.remove()
      entry.actions = undefined
      dot.dataset.state = 'active'
      explanation.replaceChildren(mark(ok ? 'done' : 'skipped'), ok ? ' Approved · continuing' : ' Skipped · files left unchanged by this step')
      window.forge.agentApprove(activeId, ev.id, ok)
    }
    yes.onclick = () => answer(true)
    no.onclick = () => answer(false)
    actions.append(yes, no)
    card.append(actions)
    entry.actions = actions
  }
  cards.set(ev.id, entry)
  const stick = nearBottom()
  g.body.append(card)
  if (stick) toEnd()
}

function changesCard(ev: Extract<AgentEvent, { type: 'changes' }>, replace?: HTMLElement) {
  const chatId = activeId
  const card = h('div', 'changes')
  const lock = (disabled: boolean) => card.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = disabled)
  const sum = (k: 'added' | 'removed') => ev.files.reduce((n, f) => n + f[k], 0)
  const head = h('div', 'changes-head')
  const title = h('span', '', `${ev.files.length} file${ev.files.length === 1 ? '' : 's'} changed`)
  const stat = h('span', 'stat')
  stat.append(h('span', 'plus', `+${sum('added')}`), document.createTextNode(' '), h('span', 'minus', `−${sum('removed')}`))
  const undo = h('button', 'undo', 'Undo run') as HTMLButtonElement
  undo.prepend(icon('undo', 'sm'))
  undo.title = 'Undo this run: restore every file in this checkpoint'
  const page = ev.files.find((f) => f.status !== 'deleted' && /\.html?$/i.test(f.path))
  if (page && !isRemote()) {
    const open = h('button', 'undo')
    open.append(icon('globe', 'sm'), document.createTextNode('Open page'))
    open.title = `Open ${page.path} in your browser`
    open.onclick = () => window.forge.openPath(chatId, page.path).catch((e) => toast(cleanErr(e), 4000))
    head.append(title, stat, open, undo)
  } else head.append(title, stat, undo)
  card.append(head)
  for (const f of ev.files) {
    const row = h('button', 'file-row')
    const statusEl = h('span', 'file-status ' + f.status)
    statusEl.append(fileIcon(f.status))
    statusEl.title = f.status === 'added' ? 'New' : f.status === 'deleted' ? 'Removed' : 'Updated'
    row.append(statusEl, h('span', 'tool-path', f.path))
    if (f.status !== 'deleted' && !isRemote()) row.onclick = async () => { await openWorkspace(); onFileChanged(f.path) }
    const kind = /\.css$/i.test(f.path) ? 'Styles and appearance' : /\.html?$/i.test(f.path) ? 'Page content and structure' : /\.(js|ts|tsx|jsx|py)$/i.test(f.path) ? 'App behavior' : 'Project file'
    const before = f.status === 'added' ? 'Not in project' : 'Existing file'
    const after = f.status === 'deleted' ? 'Removed from project' : `${f.added} lines added · ${f.removed} removed`
    const impact = h('span', 'file-impact')
    impact.append(h('strong', '', kind), h('span', '', `${before} → ${after}`))
    row.append(impact)
    row.setAttribute('aria-label', `${f.status}: ${f.path}. ${f.added} lines added, ${f.removed} removed. ${f.status === 'deleted' ? 'This file was removed.' : 'Open in workspace.'}`)
    const line = h('div', 'change-line')
    line.append(row)
    const bridge = window.forge
    if (typeof bridge.agentUndoFile === 'function') {
      const one = h('button', 'undo only') as HTMLButtonElement
      one.append(icon('undo', 'sm'))
      one.title = 'Undo this file'
      one.setAttribute('aria-label', `Undo ${f.path}`)
      one.onclick = async () => {
        lock(true)
        try {
          const remaining = await bridge.agentUndoFile(chatId, ev.checkpoint, f.path)
          if (activeId !== chatId) return
          onFilesRestored([f.path]); briefUndone([f.path])
          if (remaining.length) changesCard({ ...ev, files: remaining }, card)
          else card.replaceChildren(h('div', 'changes-done', 'All files in this run have been restored.'))
          toast(`Restored ${f.path}`)
        }
        catch (e) { lock(false); toast(cleanErr(e), 4000) }
      }
      line.append(one)
    }
    card.append(line)
  }
  undo.onclick = async () => {
    lock(true)
    try {
      const restored = await window.forge.agentUndo(chatId, ev.checkpoint)
      if (activeId !== chatId) return
      onFilesRestored(restored)
      briefUndone(restored)
      card.replaceChildren(h('div', 'note changes-done', `Undone: ${ev.files.length} file${ev.files.length === 1 ? '' : 's'} restored.`))
    } catch (e) {
      lock(false)
      card.append(h('div', 'errtext', cleanErr(e)))
    }
  }
  if (replace) replace.replaceWith(card)
  else add(card)
}

function addUser(text: string, files: { id: string; name: string; kind: Kind }[] = []) {
  emptyEl?.remove()
  emptyEl = null
  hasMessages = true
  runUsage = { input: 0, output: 0, genSec: 0, calls: 0 }
  log.push({ type: 'user', text })
  briefGoal(text.split('\n\nMy build priorities, in order:')[0])
  const bubble = h('div', 'user')
  if (files.length) {
    const chatId = activeId
    bubble.append(sentChips(files.map((f) => ({ name: f.name, kind: f.kind === 'image' ? 'image' : 'file', preview: f.kind === 'image' ? () => window.forge.attachmentsPreview(chatId, f.id) : undefined }))))
  }
  if (text) bubble.append(document.createTextNode(text))
  add(bubble)
  setProject(project)
  return bubble
}
// On the phone a sent message is shown at once, marked "Sending" until the computer has it.
let pendingBubble: HTMLElement | null = null
function markSent(failed = false) {
  if (!pendingBubble) return
  pendingBubble.classList.remove('sending')
  if (failed) pendingBubble.classList.add('failed')
  pendingBubble = null
}

// ---- events from the agent ----
function handle(ev: AgentEvent) {
  if (ev.type !== 'delta') flushReply() // anything after the text is drawn after it
  markSent()
  log.push(ev)
  if (ev.type !== 'delta' && ev.type !== 'usage' && ev.type !== 'turn_end') briefEvent(ev)
  switch (ev.type) {
    case 'delta': {
      hideThinking()
      if (!reply) {
        finishGroup()
        reply = { el: add(h('div', 'assistant')), text: '' }
      }
      if (!live.start) live.start = performance.now()
      live.chars += ev.text.length
      reply.text += ev.text
      scheduleReply()
      break
    }
    case 'turn_end':
      if (reply) {
        const text = reply.text
        const key = keyLines(text); if (key.length) reply.el.append(keyCard(key)) // once, when the reply is complete (it was rebuilt every frame)
        const actions = h('div', 'msg-actions')
        const c = h('button')
        c.append(icon('copy', 'sm'))
        c.title = 'Copy reply'
        c.setAttribute('aria-label', 'Copy reply')
        c.onclick = () => copy(text, 'Reply copied')
        actions.append(c)
        reply.el.append(actions)
      }
      reply = null
      if (running) showThinking() // the model is about to run tools or be asked again
      break
    case 'usage':
      runUsage.input += ev.input
      runUsage.output += ev.output
      runUsage.calls += 1
      if (ev.tps > 0) runUsage.genSec += ev.output / ev.tps
      setUsageChips(ev)
      break
    case 'tool':
      hideThinking()
      toolCard(ev)
      break
    case 'tool_result': {
      const c = cards.get(ev.id)
      if (running) showThinking()
      if (!c) break
      c.actions?.remove()
      const denied = ev.text.startsWith('DENIED:')
      c.dot.dataset.state = ev.ok ? 'done' : denied ? 'skipped' : 'failed'
      if (!ev.ok && !denied) c.group.failed = true
      if (ev.ok && c.name === 'write') onFileChanged(c.path)
      if (c.name !== 'write' || !ev.ok) {
        c.body.append(h('pre', ev.ok ? '' : 'err', ev.text.length > 3000 ? ev.text.slice(0, 3000) + '\n…' : ev.text))
        if (!ev.ok && !denied) c.body.hidden = false
      }
      break
    }
    case 'verify': {
      finishGroup()
      const card = h('div', 'tool')
      const head = h('button', 'tool-head')
      const checkLabel = h('span', 'tool-label', ev.ok ? 'Check passed' : 'Check failed')
      head.append(mark(ev.ok ? 'done' : 'failed'), checkLabel, h('span', 'tool-path', ev.command))
      const body = h('div', 'tool-body')
      body.hidden = ev.ok
      body.append(h('pre', ev.ok ? '' : 'err', ev.output.length > 3000 ? '…' + ev.output.slice(-3000) : ev.output))
      head.setAttribute('aria-expanded', String(!body.hidden))
      head.onclick = () => { body.hidden = !body.hidden; head.setAttribute('aria-expanded', String(!body.hidden)) }
      card.append(head, body)
      add(card)
      if (running) showThinking()
      break
    }
    case 'plan':
      break // rendered in the persistent build brief
    case 'note':
      finishGroup()
      add(h('div', 'note', ev.text))
      break
    case 'changes':
      finishGroup()
      changesCard(ev)
      break
    case 'done': {
      finishGroup()
      hideThinking()
      const msg = {
        stopped: 'Stopped.',
        stuck: 'Stopped: the agent kept repeating a failing step.',
        max_steps: 'Stopped: step limit reached.',
        max_time: 'Stopped: time limit reached.',
        finished: '',
        unverified: 'Finished, but the project check still fails. Review the changes before keeping them.',
      }[ev.reason]
      if (msg) add(h('div', 'note', msg))
      if (runUsage.calls) {
        const rate = runUsage.genSec > 0 ? ` · ${formatRate(runUsage.output / runUsage.genSec)} tok/s` : ''
        const stats = add(h('div', 'runstats', `${formatTokens(runUsage.input)} in · ${formatTokens(runUsage.output)} out${rate} · ${plural(runUsage.calls, 'call', 'calls')}`))
        stats.title = `${runUsage.input.toLocaleString()} tokens read, ${runUsage.output.toLocaleString()} written, ${plural(runUsage.calls, 'model call', 'model calls')}`
      }
      setRunning(false)
      break
    }
    case 'error':
      finishGroup()
      hideThinking()
      add(h('div', 'errcard', ev.message))
      setRunning(false)
      break
  }
}

// ---- composer ----
function grow() {
  prompt.style.height = 'auto'
  prompt.style.height = Math.min(prompt.scrollHeight, linesTall(phone.matches ? 6 : 10)) + 'px'
}
// The composer grows to ten lines (six on a phone), then scrolls.
const linesTall = (n: number) => { const cs = getComputedStyle(prompt); return Math.round((parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6) * n + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) }

async function chooseFolder() {
  if (isRemote()) { toast('Pick the folder in Crew with Find folder, or choose it on the computer.', 5000); return }
  try {
    const p = await window.forge.pickProject(activeId)
    if (p && p !== project) {
      setProject(p)
      await onProject(p)
    }
  } catch (e) {
    toast(cleanErr(e), 3500)
  }
}

// "Many agents": send to the Crew instead of one agent. Remembered between sessions.
const multiOn = () => { try { return localStorage.getItem('forge.soloMulti') === '1' } catch { return false } }
function initMulti() {
  const b = $('multi')
  b.hidden = typeof window.forge.teamStart !== 'function'
  const paint = () => { b.classList.toggle('on', multiOn()); b.setAttribute('aria-pressed', String(multiOn())) }
  b.onclick = () => { try { localStorage.setItem('forge.soloMulti', multiOn() ? '0' : '1') } catch {} paint(); prompt.focus() }
  paint()
}

async function send() {
  const draft = prompt.value.trim()
  const text = withPriorities(draft)
  if (running && /^(pause|stop|wait)[\s.!]*$/i.test(draft)) { window.forge.agentStop(activeId); prompt.value = ''; return } // typing pause stops the agent, like Esc
  if (!draft || running || sending) { if (!draft && att.items().length) { toast('Say what to do with the files.'); prompt.focus() } return }
  if (att.busy()) { toast('Wait for the files to finish uploading.'); return }
  if (!project) await chooseFolder() // like Codex: no folder, no run
  if (!project) return
  // "Many agents" is on: the same message becomes a Crew run (several Claude and local agents side by side) and its page opens.
  if (multiOn() && typeof window.forge.teamStart === 'function') {
    if (att.items().length) { toast('Files go with one agent. Turn off Many agents to send them.'); return }
    sending = true
    try {
      const r = await window.forge.teamStart(text, {})
      prompt.value = ''
      grow()
      window.dispatchEvent(new CustomEvent('forge-open-run', { detail: r.id }))
    } catch (e) { toast(cleanErr(e), 5000) } finally { sending = false }
    return
  }
  sending = true
  const files = att.items().flatMap((x) => (x.state === 'ready' && x.result ? [{ id: x.result.id, name: x.file.name, kind: x.result.kind ?? x.kind }] : []))
  const bubble = addUser(text, files)
  if (isRemote()) { bubble.classList.add('sending'); pendingBubble = bubble }
  att.clear()
  prompt.value = ''
  grow()
  setRunning(true)
  showThinking()
  try {
    localStorage.setItem('forge.mode', modeSel.value)
  } catch {}
  try {
    await window.forge.agentSend({ chatId: activeId, text, attachments: files.map((f) => f.id), mode: modeSel.value as Mode, model: selectedModel(), numCtx: numCtxPref(), ...agentLimits() })
  } catch (e) {
    markSent(true)
    hideThinking()
    add(h('div', 'errcard', cleanErr(e)))
    setRunning(false)
  } finally {
    markSent()
    sending = false
  }
}

// ---- switching between chats ----
function resetView() {
  hideThinking()
  resetBrief(activeId, project)
  thread.replaceChildren()
  att.clear()
  cards.clear()
  reply = null
  group = null
  thinkingEl = null
  hasMessages = false
  emptyEl = null
  log = []
  runUsage = { input: 0, output: 0, genSec: 0, calls: 0 }
  rateChip.hidden = true
  ctxChip.hidden = true
}

// A phone draws the last 300 steps of a long chat (from a message boundary) and offers the rest behind a button.
const PHONE_STEPS = 300
function replay(items: TranscriptItem[], liveRun: boolean, all = !isRemote()) {
  setRunning(false)
  let from = 0
  if (!all && items.length > PHONE_STEPS) {
    from = items.findIndex((it, i) => i >= items.length - PHONE_STEPS && it.type === 'user')
    if (from < 0) from = items.length - PHONE_STEPS
    const more = h('button', 'btn load-earlier', 'Show earlier messages') as HTMLButtonElement
    more.onclick = () => {
      const fromEnd = scroller.scrollHeight - scroller.scrollTop
      resetView()
      replay(items, statusOf(activeId) !== 'idle', true)
      scroller.scrollTop = scroller.scrollHeight - fromEnd
    }
    thread.append(more)
  }
  for (const it of items.slice(from)) {
    if (it.type === 'user') addUser(it.text, it.attachments ?? [])
    else handle(it)
  }
  if (from) log = [...items.slice(0, from), ...log]
  flushReply()
  finishGroup()
  if (!liveRun) {
    // A chat saved mid-run (app closed) can end on a step that never got an answer: no dead buttons.
    for (const c of cards.values()) {
      c.actions?.remove()
      if (c.dot.dataset.state === 'ask' || c.dot.dataset.state === 'active') c.dot.dataset.state = 'pending'
    }
  } else {
    setRunning(true) // still working in the background: keep following it live
    showThinking()
  }
  toEnd()
}

// Crew runs are listed with the chats. They change often (every status) so the list is re-read at most every 1.5 s after a team event.
async function loadRuns() {
  try { crewRuns = typeof window.forge.teamList === 'function' && !localStorage.getItem('forge.teamReplay') ? await window.forge.teamList() : [] } catch { crewRuns = [] }
}
let runsTimer: ReturnType<typeof setTimeout> | null = null
const refreshRunsSoon = () => { if (!runsTimer) runsTimer = setTimeout(() => { runsTimer = null; void refreshHistory() }, 1500) }
async function refreshHistory() {
  const [list] = await Promise.all([window.forge.chatsList(), loadRuns()])
  chats = list
  if (isRemote()) cacheSet('boot', { chats: chats.slice(0, 60), project })
  const shown = chats.filter((c) => matchesQuery(c, query))
  const needle = query.trim().toLowerCase()
  const runsShown = crewRuns.filter((r) => !needle || r.goal.toLowerCase().includes(needle) || folderName(r.project).toLowerCase().includes(needle)).slice(0, 80)
  const activeRun = $('app').classList.contains('team-mode') ? ($('app').dataset.crewRun ?? '') : ''
  renderHistory(shown, activeId, query, { open: openChat, remove: removeChat, rename: renameChat, openRun: (id) => window.dispatchEvent(new CustomEvent('forge-open-run', { detail: id })) }, runsShown, activeRun)
  const me = chats.find((c) => c.id === activeId)
  titleEl.textContent = me?.title ?? 'New chat'
  document.title = me ? `${me.title} · Forge` : 'Forge'
  if (!sending) {
    const busy = statusOf(activeId) !== 'idle'
    if (busy !== running) {
      setRunning(busy)
      if (busy) showThinking()
    }
  }
  setProject(project)
  projectBrief(project, me?.title)
}

async function openChat(id: string) {
  if (id === activeId) return
  try {
    const c = await window.forge.chatsOpen(id)
    activeId = c.id
    window.forge.chatsViewing(id)
    project = c.missing ? null : c.project
    resetView()
    if (c.transcript.length) { replay(c.transcript, c.status !== 'idle'); settleEnd() }
    else showEmpty()
    if (c.missing) add(h('div', 'note', `The folder for this chat (${c.project}) no longer exists.`))
    await onProject(project)
    await refreshHistory()
    prompt.focus()
  } catch (e) {
    toast(cleanErr(e), 3500)
  }
}

// After the phone was offline or asleep: draw the open chat again from what the computer has now.
async function reloadActive() {
  if (sending || !chats.some((c) => c.id === activeId)) return
  const id = activeId
  const c = await window.forge.chatsOpen(id)
  if (activeId !== id || sending) return
  const stay = !nearBottom(), top = scroller.scrollTop
  resetView()
  if (c.transcript.length) replay(c.transcript, c.status !== 'idle')
  else showEmpty()
  if (stay) scroller.scrollTop = top
}

async function newChat() {
  activeId = uuid()
  window.forge.chatsViewing(activeId)
  setRunning(false)
  resetView()
  showEmpty()
  await refreshHistory()
  prompt.focus()
}

async function removeChat(id: string) {
  try {
    await window.forge.chatsDelete(id)
    if (id === activeId) await newChat()
    else await refreshHistory()
  } catch (e) {
    toast(cleanErr(e), 3500)
  }
}

async function renameChat(id: string, title: string) {
  try {
    await window.forge.chatsRename(id, title)
  } catch (e) {
    toast(cleanErr(e), 3500)
  }
  await refreshHistory()
}

function startTitleEdit() {
  const me = chats.find((c) => c.id === activeId)
  if (!me) return // a chat that has not been saved yet has nothing to rename
  const input = document.createElement('input')
  input.className = 'title-edit'
  input.value = me.title
  titleEl.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = async (save: boolean) => {
    if (done) return
    done = true
    input.replaceWith(titleEl)
    if (save && input.value.trim() && input.value.trim() !== me.title) await renameChat(me.id, input.value)
  }
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true)
    if (e.key === 'Escape') finish(false)
  }
  input.onblur = () => finish(true)
}

function moreMenu() {
  const me = chats.find((c) => c.id === activeId)
  const title = me?.title ?? 'Chat'
  const asMarkdown = () => exportMarkdown(title, project, log)
  showMenu($('more'), [
    { label: 'Copy chat as Markdown', run: () => copy(asMarkdown(), 'Chat copied') },
    ...(isRemote() ? [] : [{
      label: 'Export as Markdown…',
      run: async () => {
        if (await window.forge.saveText(`${title.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'chat'}.md`, asMarkdown())) toast('Exported')
      },
    }]),
    ...(project && !isRemote() ? [{ label: 'Open project folder', run: () => window.forge.openFolder(activeId).catch((e) => toast(cleanErr(e), 4000)) }] : []),
    ...(me ? [{ label: 'Rename', run: startTitleEdit }, { label: 'Delete chat', danger: true, run: () => toast(`Delete “${me.title}”? This cannot be undone.`, 6000, { label: 'Delete', run: () => removeChat(me.id) }) }] : []),
  ])
}

// ---- boot ----
export async function initChat(opts: {
  onFileChanged: (path: string) => void
  onFilesRestored: (paths: string[]) => void
  onProject: (root: string | null) => Promise<void> | void
  openWorkspace: () => void | Promise<void>
}) {
  onFileChanged = opts.onFileChanged
  initMulti()
  onFilesRestored = opts.onFilesRestored
  onProject = opts.onProject
  window.addEventListener('forge-project-picked', (e) => { const p = (e as CustomEvent<string>).detail; if (p && p !== project && !hasMessages) { setProject(p); void onProject(p) } })
  openWorkspace = opts.openWorkspace
  try {
    modeSel.value = localStorage.getItem('forge.mode') ?? 'ask-all'
    if (localStorage.getItem('forge.hist') === '0' || (!localStorage.getItem('forge.hist') && matchMedia('(max-width: 1000px)').matches)) $('app').classList.add('no-hist')
  } catch {}

  initBrief(async path => { await openWorkspace(); onFileChanged(path) })
  resetBrief(activeId, project)
  initPalette(() => [
    { label: 'Start a new build', icon: 'edit', detail: 'Ctrl N', run: newChat },
    { label: 'Model library', icon: 'cube', detail: 'Download models and check hardware fit', run: () => openLibrary() },
    { label: 'Settings', icon: 'gear', detail: 'Appearance, models, agent and shortcuts', run: () => openSettings() },
    { label: 'Usage and speed', icon: 'chart', run: () => openSettings('usage') },
    ...(isRemote() ? [] : [{ label: 'Projects dashboard', icon: 'list' as const, detail: 'Every project, its runs and what needs you', run: () => void openDashboard() }]),
    { label: 'What to build', icon: 'bolt' as const, detail: 'Project ideas you can hand to the crew, and features to add', run: () => void openIdeas(project) },
    ...(project ? [{ label: 'Improve this project', icon: 'sliders' as const, detail: 'What is missing or risky here, with a one-click fix for each', run: () => void openImprove(project!) }] : []),
    { label: 'Top GitHub repos', icon: 'bolt' as const, detail: 'Browse the most popular repos and add them as skills, a project or a reference', run: () => void openGithubTop() },
    ...(project ? [{ label: 'Project rules', icon: 'shield' as const, detail: 'What every agent must follow in this project', run: () => void openRules(project!) }, { label: 'Reference library', icon: 'clip' as const, detail: 'Design screenshots, documents and links for this project', run: () => void openReferences(project!) }] : []),
    ...(project && !isRemote() ? [{ label: 'Restore points for this project', icon: 'undo' as const, detail: 'Browse and restore earlier states', run: () => void openRestorePoints(project!) }] : []),
    ...(isRemote() ? [] : [{ label: 'Toggle workspace', icon: 'code' as const, detail: 'Files, editor and terminal · Ctrl J', run: () => $('ws-toggle').click() }, { label: 'Toggle build brief', icon: 'list' as const, detail: 'Ctrl .', run: () => $('brief-toggle').click() }]),
    { label: 'Focus message', icon: 'keyboard', detail: 'Ctrl L', run: () => prompt.focus() },
    { label: 'Collapse or expand the sidebar', icon: 'sidebar', detail: 'Ctrl B', run: () => $('hist-toggle').click() },
    { label: 'Go to Solo', icon: 'edit', detail: 'Ctrl 1', run: () => $('mode-chat').click() },
    ...($('mode-team').hidden ? [] : [{ label: 'Go to Crew', icon: 'users' as const, detail: 'Ctrl 2', run: () => $('mode-team').click() }]),
    ...(['ask-all', 'auto-edit', 'full-auto'] as const).map((mode, i) => ({ label: `Autonomy: ${['Ask before edits', 'Auto-edit', 'Full auto'][i]}`, icon: 'sliders' as const, run: () => { modeSel.value = mode; localStorage.setItem('forge.mode', mode) } })),
    ...(project && !isRemote() ? [{ label: 'Open project folder', icon: 'folder' as const, run: () => { window.forge.openFolder(activeId).catch(e => toast(cleanErr(e), 4000)) } }] : []),
    ...chats.map(c => ({ label: c.title, icon: 'edit' as const, detail: `Chat · ${folderName(c.project)}`, run: () => openChat(c.id) })),
    ...Array.from($<HTMLSelectElement>('model').options).map(m => ({ label: `Use ${m.text}`, icon: 'cpu' as const, detail: 'Model', run: () => { const sel = $<HTMLSelectElement>('model'); sel.value = m.value; sel.dispatchEvent(new Event('change')) } })),
  ])
  showEmpty()
  window.forge.chatsViewing(activeId)
  window.forge.onAgentEvent(({ chatId, ev }) => {
    if (chatId === activeId) handle(ev)
  })
  window.forge.onChatsChanged(refreshHistory)
  window.addEventListener('forge-crew-changed', () => void refreshHistory())
  window.addEventListener('forge-open-chat-now', (e) => { const id = (e as CustomEvent<string>).detail; if (id) void openChat(id) }) // a search hit
  if (typeof window.forge.onTeamEvent === 'function') window.forge.onTeamEvent((ev) => { if (ev.type === 'run' || ev.type === 'task' || ev.type === 'approval' || ev.type === 'final') refreshRunsSoon() })
  window.forge.onChatsFocus((id) => openChat(id))
  window.addEventListener('forge-models', () => {
    if (emptyEl && !hasMessages) {
      emptyEl.remove()
      emptyEl = null
      showEmpty()
    }
  })

  $('composer').insertBefore(att.strip, prompt)
  $('composer').append(att.input)
  $('project').before(att.button)
  $('project').before(attachVoice(prompt, $('composer'))) // dictate a prompt with a local speech-to-text program
  $('model').addEventListener('change', att.redraw)
  prompt.oninput = grow
  prompt.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  }
  sendBtn.onclick = () => (running ? window.forge.agentStop(activeId) : send())
  projectBtn.onclick = chooseFolder
  $('gear').onclick = () => openSettings()
  $('models-btn').onclick = () => openLibrary()
  initLibrary()
  $('usage-badge').onclick = () => openSettings('usage')
  $('new-chat').onclick = newChat
  $('side-new').onclick = newChat
  $('side-collapse').onclick = () => $('hist-toggle').click()
  $('more').onclick = moreMenu
  titleEl.onclick = startTitleEdit
  searchEl.oninput = () => {
    query = searchEl.value
    refreshHistory()
  }
  toBottom.onclick = toEnd
  scroller.addEventListener('scroll', () => (toBottom.hidden = nearBottom(240)))
  const compactWindow = matchMedia('(max-width: 1000px)')
  let autoHidden = false
  compactWindow.addEventListener('change', ({ matches }) => {
    if (matches && !$('app').classList.contains('no-hist')) { $('app').classList.add('no-hist'); autoHidden = true }
    else if (!matches && autoHidden) { $('app').classList.remove('no-hist'); autoHidden = false }
    railLabels()
  })
  // Desktop: collapsing leaves the icon rail (rail.css), so every place stays one click away. Phones: the drawer.
  const railLabels = () => { const off = $('app').classList.contains('no-hist'); for (const id of ['side-collapse', 'hist-toggle', 'team-hist-toggle']) { const b = $(id); b.title = `${off ? 'Expand' : 'Collapse'} sidebar (Ctrl B)`; b.setAttribute('aria-label', `${off ? 'Expand' : 'Collapse'} sidebar`); b.setAttribute('aria-expanded', String(!off)) } }
  $('hist-toggle').onclick = () => {
    if (phone.matches) return toggleDrawer()
    autoHidden = false
    const off = $('app').classList.toggle('no-hist')
    railLabels()
    try {
      localStorage.setItem('forge.hist', off ? '0' : '1')
    } catch {}
  }
  railLabels()

  // Delegated clicks inside replies: copy buttons on code blocks, and links open in the real browser.
  thread.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.classList.contains('copy')) copy(t.closest('.code')?.querySelector('code')?.textContent ?? '', 'Code copied')
    const a = t.closest('a[data-ext]') as HTMLAnchorElement | null
    if (a) {
      e.preventDefault()
      if (isRemote()) window.open(a.href, '_blank', 'noopener') // on the phone, not on the computer
      else window.forge.openExternal(a.href)
    }
  })

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    const inEditor = !!(e.target as HTMLElement).closest?.('#editor, #term')
    if (e.key === 'Escape' && running && !document.querySelector('dialog[open]')) {
      window.forge.agentStop(activeId)
    } else if (mod && !inEditor) {
      const k = e.key.toLowerCase()
      const run = (fn: () => void) => (e.preventDefault(), fn())
      if (k === 'n') run(newChat)
      else if (k === 'l') run(() => prompt.focus())
      else if (k === 'b') run(() => $('hist-toggle').click())
      else if (k === 'j') run(() => $('ws-toggle').click())
      else if (k === ',') run(() => openSettings())
      else if (k === '1') run(() => $('mode-chat').click()) // Solo
      else if (k === '2' && !$('mode-team').hidden) run(() => $('mode-team').click()) // Crew
      else if (k === '.') run(() => $('brief-toggle').click())
    }
  })

  // The phone paints the last chat list it saw at once (skeleton rows the first time), then the real one.
  if (isRemote()) {
    const cached = cacheGet<{ chats: ChatListItem[]; project: string | null }>('boot')
    if (cached?.chats?.length) renderHistory(cached.chats.map((c) => ({ ...c, status: 'idle' as const })), activeId, '', { open: openChat, remove: removeChat, rename: renameChat })
    else $('chat-list').replaceChildren(...Array.from({ length: 6 }, () => h('div', 'chat-skel skel')))
    onResync(async () => { await refreshHistory(); await reloadActive(); setUsage(await window.forge.usageSummary()) })
  }
  // One round trip: the models, the chat list and usage are asked for together.
  const [, init] = await Promise.all([initModels(), window.forge.appInit(), initUsage()])
  project = init.project
  chats = init.chats
  setProject(project)
  renderHistory(chats.filter((c) => matchesQuery(c, query)), activeId, query, { open: openChat, remove: removeChat, rename: renameChat })
  void loadRuns().then(() => refreshHistory()) // the Crew runs join the list once they are read
  if (isRemote()) cacheSet('boot', { chats: chats.slice(0, 60), project })
  if (project) await onProject(project)
  // First run: nothing to talk to yet, so open the library with a welcome instead of an empty chat.
  let onboarded = false
  try {
    onboarded = localStorage.getItem('forge.onboarded') === '1'
  } catch {}
  if (noModels && !onboarded) openLibrary({ welcome: true })
}
