import type { AgentEvent, ChatListItem, Mode, TranscriptItem } from '../preload'
import { exportMarkdown, folderName, formatRate, formatTokens, matchesQuery, md, toolTarget, toolVerb } from './format'
import { renderHistory } from './history'
import { initModels, noModels, selectedModel } from './models'
import { openSettings } from './settings'
import { $, cleanErr, copy, h, numCtxPref, showMenu, toast } from './ui'
import { initUsage } from './usage'

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

// ---- what the screen is showing ----
let activeId: string = crypto.randomUUID() // a new chat gets its id up front, so live events can be matched to it
let chats: ChatListItem[] = []
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
let thinkingEl: HTMLElement | null = null
let runUsage = { input: 0, output: 0, genSec: 0, calls: 0 }
const live = { chars: 0, start: 0, timer: null as ReturnType<typeof setInterval> | null }

type Card = { dot: HTMLElement; body: HTMLElement; name: string; path: string; group: { failed: boolean }; actions?: HTMLElement }
const cards = new Map<string, Card>()

let onFileChanged: (path: string) => void = () => {}
let onFilesRestored: (paths: string[]) => void = () => {}
let onProject: (root: string | null) => Promise<void> | void = () => {}
let openWorkspace: () => void = () => {}

const statusOf = (id: string) => chats.find((c) => c.id === id)?.status ?? 'idle'

// ---- scrolling ----
const nearBottom = (slack = 80) => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < slack
const toEnd = () => (scroller.scrollTop = scroller.scrollHeight)
const add = (el: HTMLElement) => {
  const stick = nearBottom()
  thread.insertBefore(el, thinkingEl) // the "thinking" dots always stay last
  if (stick) toEnd()
  return el
}

function showThinking() {
  if (thinkingEl) return
  thinkingEl = h('div', 'thinking')
  thinkingEl.append(h('i'), h('i'), h('i'))
  thread.append(thinkingEl)
  if (nearBottom()) toEnd()
}
function hideThinking() {
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
  ctxChip.textContent = ev.ctxLimit ? `${formatTokens(ev.input)} / ${formatTokens(ev.ctxLimit)} memory` : `${formatTokens(ev.input)} in context`
  const full = !!ev.ctxLimit && ev.input / ev.ctxLimit > 0.8
  ctxChip.classList.toggle('warn', full)
  ctxChip.title = full
    ? 'The model is close to its memory limit and will start forgetting the start of this chat. Start a new chat for new work, or raise the size in Settings.'
    : "How much of the model's memory this chat uses"
}

// ---- empty state ----
const SUGGESTIONS = ['Build a Telegram bot', 'Make a simple website', 'Explain this project', 'Find and fix bugs']

function showEmpty() {
  emptyEl = h('div', 'empty')
  emptySub = h('div', '')
  emptyEl.append(h('h2', '', 'What are we building?'), emptySub)
  const chips = h('div', 'chips')
  for (const t of SUGGESTIONS) {
    const c = h('button', 'chip', t)
    c.onclick = () => {
      prompt.value = t
      prompt.focus()
      grow()
    }
    chips.append(c)
  }
  emptyEl.append(chips)
  if (noModels) {
    const b = h('div', 'banner')
    b.append(h('div', '', 'No AI model found. Start Ollama and pull a model, or add an API key.'))
    const open = h('button', '', 'Open settings')
    open.onclick = openSettings
    b.append(open)
    emptyEl.append(b)
  }
  thread.append(emptyEl)
  setProject(project)
}

function setProject(p: string | null) {
  project = p
  projectBtn.textContent = p ? folderName(p) : 'Choose folder'
  projectBtn.title = hasMessages ? `This chat works in ${p}` : (p ?? 'Choose the folder the agent works in')
  projectBtn.classList.toggle('need', !p)
  projectBtn.disabled = hasMessages
  if (emptySub) emptySub.textContent = p ? `Working in ${folderName(p)}` : 'Choose a folder below, then describe what you want.'
}

function setRunning(on: boolean) {
  running = on
  sendBtn.classList.toggle('stop', on)
  sendBtn.textContent = on ? '■' : '↑'
  sendBtn.title = on ? 'Stop (Esc)' : 'Send'
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
  g.label.textContent = working ? `Working: ${text}…` : text.charAt(0).toUpperCase() + text.slice(1)
}

function ensureGroup(): Group {
  if (group) return group
  const el = h('div', 'steps')
  const head = h('button', 'steps-head')
  const dot = h('span', 'dot run')
  const label = h('span', 'steps-label', 'Working…')
  head.append(dot, label, h('span', 'chev', '›'))
  const body = h('div', 'steps-body')
  body.hidden = true
  head.onclick = () => {
    body.hidden = !body.hidden
    el.classList.toggle('open', !body.hidden)
  }
  el.append(head, body)
  add(el)
  return (group = { el, dot, label, body, counts: new Map(), failed: false })
}

function finishGroup() {
  if (!group) return
  group.dot.className = 'dot ' + (group.failed ? 'err' : 'ok')
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
  const writes = ev.name === 'edit_file' || ev.name === 'create_file'

  const card = h('div', 'tool')
  const head = h('button', 'tool-head')
  const dot = h('span', 'dot run')
  head.append(dot, h('span', 'tool-label', verb), h('span', 'tool-path', path))
  const body = h('div', 'tool-body')
  body.hidden = true
  if (ev.name === 'edit_file') body.append(diff(String(a.old_text ?? ''), String(a.new_text ?? '')))
  if (ev.name === 'create_file') body.append(diff('', String(a.content ?? '')))
  if (ev.name === 'run_command') body.append(h('pre', '', `$ ${path}`))
  head.onclick = () => (body.hidden = !body.hidden)
  card.append(head, body)

  const g = ensureGroup()
  g.counts.set(verb, (g.counts.get(verb) ?? 0) + 1)
  summarize(g, true)
  const entry: Card = { dot, body, name: writes ? 'write' : ev.name, path, group: g }
  if (ev.needsApproval) {
    dot.className = 'dot wait'
    body.hidden = false
    g.body.hidden = false // an action that needs a yes must be visible
    g.el.classList.add('open')
    const actions = h('div', 'approve')
    const yes = h('button', 'yes', 'Accept')
    const no = h('button', '', 'Reject')
    const answer = (ok: boolean) => {
      actions.remove()
      entry.actions = undefined
      dot.className = 'dot run'
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

function changesCard(ev: Extract<AgentEvent, { type: 'changes' }>) {
  const card = h('div', 'changes')
  const sum = (k: 'added' | 'removed') => ev.files.reduce((n, f) => n + f[k], 0)
  const head = h('div', 'changes-head')
  const title = h('span', '', `${ev.files.length} file${ev.files.length === 1 ? '' : 's'} changed`)
  const stat = h('span', 'stat')
  stat.append(h('span', 'plus', `+${sum('added')}`), document.createTextNode(' '), h('span', 'minus', `−${sum('removed')}`))
  const undo = h('button', 'undo', 'Undo') as HTMLButtonElement
  head.append(title, stat, undo)
  card.append(head)
  for (const f of ev.files) {
    const row = h('button', 'file-row')
    row.append(h('span', 'file-status ' + f.status, f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M'), h('span', 'tool-path', f.path))
    if (f.status !== 'deleted') row.onclick = () => (openWorkspace(), onFileChanged(f.path))
    card.append(row)
  }
  undo.onclick = async () => {
    undo.disabled = true
    try {
      onFilesRestored(await window.forge.agentUndo(activeId, ev.checkpoint))
      card.replaceChildren(h('div', 'note changes-done', `Undone: ${ev.files.length} file${ev.files.length === 1 ? '' : 's'} restored.`))
    } catch (e) {
      undo.disabled = false
      card.append(h('div', 'errtext', cleanErr(e)))
    }
  }
  add(card)
}

function addUser(text: string) {
  emptyEl?.remove()
  emptyEl = null
  hasMessages = true
  runUsage = { input: 0, output: 0, genSec: 0, calls: 0 }
  log.push({ type: 'user', text })
  add(h('div', 'user', text))
  setProject(project)
}

// ---- events from the agent ----
function handle(ev: AgentEvent) {
  log.push(ev)
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
      const stick = nearBottom()
      reply.el.innerHTML = md(reply.text)
      if (stick) toEnd()
      break
    }
    case 'turn_end':
      if (reply) {
        const text = reply.text
        const actions = h('div', 'msg-actions')
        const c = h('button', '', 'Copy')
        c.onclick = () => copy(text, 'Copied reply')
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
      c.dot.className = 'dot ' + (ev.ok ? 'ok' : denied ? '' : 'err')
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
      head.append(h('span', 'dot ' + (ev.ok ? 'ok' : 'err')), h('span', 'tool-label', ev.ok ? 'Check passed' : 'Check failed'), h('span', 'tool-path', ev.command))
      const body = h('div', 'tool-body')
      body.hidden = ev.ok
      body.append(h('pre', ev.ok ? '' : 'err', ev.output.length > 3000 ? '…' + ev.output.slice(-3000) : ev.output))
      head.onclick = () => (body.hidden = !body.hidden)
      card.append(head, body)
      add(card)
      if (running) showThinking()
      break
    }
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
        finished: '',
        unverified: 'Finished, but the project check still fails. Review the changes before keeping them.',
      }[ev.reason]
      if (msg) add(h('div', 'note', msg))
      if (runUsage.calls) {
        const rate = runUsage.genSec > 0 ? ` · ${formatRate(runUsage.output / runUsage.genSec)} tok/s` : ''
        add(h('div', 'runstats', `↑ ${formatTokens(runUsage.input)} read · ↓ ${formatTokens(runUsage.output)} written${rate} · ${plural(runUsage.calls, 'model call', 'model calls')}`))
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
  prompt.style.height = Math.min(prompt.scrollHeight, 200) + 'px'
}

async function chooseFolder() {
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

async function send() {
  const text = prompt.value.trim()
  if (!text || running || sending) return
  if (!project) await chooseFolder() // like Codex: no folder, no run
  if (!project) return
  sending = true
  addUser(text)
  prompt.value = ''
  grow()
  setRunning(true)
  showThinking()
  try {
    localStorage.setItem('forge.mode', modeSel.value)
  } catch {}
  try {
    await window.forge.agentSend({ chatId: activeId, text, mode: modeSel.value as Mode, model: selectedModel(), numCtx: numCtxPref() })
  } catch (e) {
    hideThinking()
    add(h('div', 'errcard', cleanErr(e)))
    setRunning(false)
  } finally {
    sending = false
  }
}

// ---- switching between chats ----
function resetView() {
  thread.replaceChildren()
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

function replay(items: TranscriptItem[], liveRun: boolean) {
  setRunning(false)
  for (const it of items) {
    if (it.type === 'user') addUser(it.text)
    else handle(it)
  }
  finishGroup()
  if (!liveRun) {
    // A chat saved mid-run (app closed) can end on a step that never got an answer: no dead buttons.
    for (const c of cards.values()) {
      c.actions?.remove()
      if (c.dot.classList.contains('wait') || c.dot.classList.contains('run')) c.dot.className = 'dot'
    }
  } else {
    setRunning(true) // still working in the background: keep following it live
    showThinking()
  }
  toEnd()
}

async function refreshHistory() {
  chats = await window.forge.chatsList()
  const shown = chats.filter((c) => matchesQuery(c, query))
  renderHistory(shown, activeId, query, { open: openChat, remove: removeChat, rename: renameChat })
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
}

async function openChat(id: string) {
  if (id === activeId) return
  try {
    const c = await window.forge.chatsOpen(id)
    activeId = c.id
    window.forge.chatsViewing(id)
    project = c.missing ? null : c.project
    resetView()
    if (c.transcript.length) replay(c.transcript, c.status !== 'idle')
    else showEmpty()
    if (c.missing) add(h('div', 'note', `The folder for this chat (${c.project}) no longer exists.`))
    await onProject(project)
    await refreshHistory()
    prompt.focus()
  } catch (e) {
    toast(cleanErr(e), 3500)
  }
}

async function newChat() {
  activeId = crypto.randomUUID()
  window.forge.chatsViewing(activeId)
  setRunning(false)
  resetView()
  showEmpty()
  await refreshHistory()
  prompt.focus()
}

async function removeChat(id: string) {
  if (!confirm('Delete this chat? This cannot be undone.')) return
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
    {
      label: 'Export as Markdown…',
      run: async () => {
        if (await window.forge.saveText(`${title.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'chat'}.md`, asMarkdown())) toast('Exported')
      },
    },
    ...(me ? [{ label: 'Rename', run: startTitleEdit }, { label: 'Delete chat', danger: true, run: () => removeChat(me.id) }] : []),
  ])
}

// ---- boot ----
export async function initChat(opts: {
  onFileChanged: (path: string) => void
  onFilesRestored: (paths: string[]) => void
  onProject: (root: string | null) => Promise<void> | void
  openWorkspace: () => void
}) {
  onFileChanged = opts.onFileChanged
  onFilesRestored = opts.onFilesRestored
  onProject = opts.onProject
  openWorkspace = opts.openWorkspace
  try {
    modeSel.value = localStorage.getItem('forge.mode') ?? 'ask-all'
    if (localStorage.getItem('forge.hist') === '0') $('app').classList.add('no-hist')
  } catch {}

  showEmpty()
  window.forge.chatsViewing(activeId)
  window.forge.onAgentEvent(({ chatId, ev }) => {
    if (chatId === activeId) handle(ev)
  })
  window.forge.onChatsChanged(refreshHistory)
  window.forge.onChatsFocus((id) => openChat(id))
  window.addEventListener('forge-models', () => {
    if (emptyEl && !hasMessages) {
      emptyEl.remove()
      emptyEl = null
      showEmpty()
    }
  })

  prompt.oninput = grow
  prompt.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  }
  sendBtn.onclick = () => (running ? window.forge.agentStop(activeId) : send())
  projectBtn.onclick = chooseFolder
  $('gear').onclick = openSettings
  $('new-chat').onclick = newChat
  $('more').onclick = moreMenu
  titleEl.onclick = startTitleEdit
  searchEl.oninput = () => {
    query = searchEl.value
    refreshHistory()
  }
  toBottom.onclick = toEnd
  scroller.addEventListener('scroll', () => (toBottom.hidden = nearBottom(240)))
  $('hist-toggle').onclick = () => {
    const off = $('app').classList.toggle('no-hist')
    try {
      localStorage.setItem('forge.hist', off ? '0' : '1')
    } catch {}
  }

  // Delegated clicks inside replies: copy buttons on code blocks, and links open in the real browser.
  thread.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.classList.contains('copy')) copy(t.closest('.code')?.querySelector('code')?.textContent ?? '', 'Code copied')
    const a = t.closest('a[data-ext]') as HTMLAnchorElement | null
    if (a) {
      e.preventDefault()
      window.forge.openExternal(a.href)
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
      else if (k === 'k') run(() => ($('app').classList.remove('no-hist'), searchEl.focus(), searchEl.select()))
      else if (k === 'l') run(() => prompt.focus())
      else if (k === 'b') run(() => $('hist-toggle').click())
      else if (k === 'j') run(() => $('ws-toggle').click())
      else if (k === ',') run(openSettings)
    }
  })

  await initModels()
  const init = await window.forge.appInit()
  project = init.project
  chats = init.chats
  setProject(project)
  renderHistory(chats.filter((c) => matchesQuery(c, query)), activeId, query, { open: openChat, remove: removeChat, rename: renameChat })
  if (project) await onProject(project)
  await initUsage()
}
