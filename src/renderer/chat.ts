import type { AgentEvent, Mode } from '../preload'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const thread = $('thread')
const prompt = $<HTMLTextAreaElement>('prompt')
const sendBtn = $<HTMLButtonElement>('send')
const modeSel = $<HTMLSelectElement>('mode')
const modelSel = $<HTMLSelectElement>('model')

const h = (tag: string, cls = '', text = '') => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

// ---- markdown-lite: everything is escaped first, so model output can never inject HTML ----
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inline = (s: string) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')

function md(src: string): string {
  return src
    .split('```')
    .map((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n') // first line is the language tag
        return `<pre><code>${esc((nl === -1 ? '' : part.slice(nl + 1)).replace(/\n$/, ''))}</code></pre>`
      }
      return part
        .split(/\n{2,}/)
        .filter((b) => b.trim())
        .map((b) => {
          const lines = b.split('\n')
          if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`
          return `<p>${lines.map(inline).join('<br>')}</p>`
        })
        .join('')
    })
    .join('')
}

const cleanErr = (e: unknown) => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// ---- thread ----
let emptyEl: HTMLElement | null = null
let reply: { el: HTMLElement; text: string } | null = null
const cards = new Map<string, { dot: HTMLElement; body: HTMLElement; name: string; path: string; actions?: HTMLElement }>()
let running = false
let onFileChanged: (path: string) => void = () => {}

const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80
const add = (el: HTMLElement) => {
  const stick = nearBottom()
  thread.append(el)
  if (stick) thread.scrollTop = thread.scrollHeight
  return el
}

function showEmpty() {
  emptyEl = h('div', 'empty')
  emptyEl.append(h('h2', '', 'What should we build?'), h('div', '', 'The agent can read and edit files in your open folder.'))
  const chips = h('div', 'chips')
  for (const t of ['Explain this project', 'Find and fix bugs', 'Add tests for the main logic']) {
    const c = h('button', 'chip', t)
    c.onclick = () => {
      prompt.value = t
      prompt.focus()
      grow()
    }
    chips.append(c)
  }
  emptyEl.append(chips)
  thread.append(emptyEl)
}

function setRunning(on: boolean) {
  running = on
  sendBtn.classList.toggle('stop', on)
  sendBtn.textContent = on ? '■' : '↑'
  sendBtn.title = on ? 'Stop' : 'Send'
  modeSel.disabled = modelSel.disabled = on
}

const VERB: Record<string, string> = { list_dir: 'Listed', read_file: 'Read', edit_file: 'Edited', search: 'Searched', run_command: 'Ran' }

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
  const path = [a.path, a.pattern, a.command].find((v) => typeof v === 'string') ?? ''
  const isEdit = ev.name === 'edit_file'
  const verb = isEdit && a.old_text === '' ? 'Created' : (VERB[ev.name] ?? ev.name)

  const card = h('div', 'tool')
  const head = h('button', 'tool-head')
  const dot = h('span', 'dot run')
  head.append(dot, h('span', 'tool-label', verb), h('span', 'tool-path', path))
  const body = h('div', 'tool-body')
  body.hidden = true
  if (isEdit) body.append(diff(String(a.old_text ?? ''), String(a.new_text ?? '')))
  if (ev.name === 'run_command') body.append(h('pre', '', `$ ${path}`))
  head.onclick = () => (body.hidden = !body.hidden)
  card.append(head, body)

  const entry: { dot: HTMLElement; body: HTMLElement; name: string; path: string; actions?: HTMLElement } = { dot, body, name: ev.name, path }
  if (ev.needsApproval) {
    dot.className = 'dot wait'
    body.hidden = false
    const actions = h('div', 'approve')
    const yes = h('button', 'yes', 'Accept')
    const no = h('button', '', 'Reject')
    const answer = (ok: boolean) => {
      actions.remove()
      entry.actions = undefined
      dot.className = 'dot run'
      window.forge.agentApprove(ev.id, ok)
    }
    yes.onclick = () => answer(true)
    no.onclick = () => answer(false)
    actions.append(yes, no)
    card.append(actions)
    entry.actions = actions
  }
  cards.set(ev.id, entry)
  add(card)
}

function handle(ev: AgentEvent) {
  switch (ev.type) {
    case 'delta': {
      if (!reply) reply = { el: add(h('div', 'assistant')), text: '' }
      reply.text += ev.text
      const stick = nearBottom()
      reply.el.innerHTML = md(reply.text)
      if (stick) thread.scrollTop = thread.scrollHeight
      break
    }
    case 'turn_end':
      reply = null
      break
    case 'tool':
      toolCard(ev)
      break
    case 'tool_result': {
      const c = cards.get(ev.id)
      if (!c) break
      c.actions?.remove()
      const denied = ev.text.startsWith('DENIED:')
      c.dot.className = 'dot ' + (ev.ok ? 'ok' : denied ? '' : 'err')
      if (ev.ok && c.name === 'edit_file') onFileChanged(c.path)
      if (c.name !== 'edit_file' || !ev.ok) {
        const pre = h('pre', ev.ok ? '' : 'err', ev.text.length > 3000 ? ev.text.slice(0, 3000) + '\n…' : ev.text)
        c.body.append(pre)
        if (!ev.ok && !denied) c.body.hidden = false
      }
      break
    }
    case 'done': {
      const msg = { stopped: 'Stopped.', stuck: 'Stopped: the agent kept repeating a failing step.', max_steps: 'Stopped: step limit reached.', finished: '' }[ev.reason]
      if (msg) add(h('div', 'note', msg))
      setRunning(false)
      break
    }
    case 'error':
      add(h('div', 'errcard', ev.message))
      setRunning(false)
      break
  }
}

// ---- composer ----
function grow() {
  prompt.style.height = 'auto'
  prompt.style.height = Math.min(prompt.scrollHeight, 180) + 'px'
}

async function send() {
  const text = prompt.value.trim()
  if (!text || running) return
  emptyEl?.remove()
  emptyEl = null
  add(h('div', 'user', text))
  prompt.value = ''
  grow()
  setRunning(true)
  try {
    localStorage.setItem('forge.model', modelSel.value)
    localStorage.setItem('forge.mode', modeSel.value)
  } catch {}
  try {
    await window.forge.agentSend({ text, mode: modeSel.value as Mode, model: modelSel.value })
  } catch (e) {
    add(h('div', 'errcard', cleanErr(e)))
    setRunning(false)
  }
}

const CLOUD = { openai: 'OpenAI', openrouter: 'OpenRouter' } as const
const customIds = (p: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem('forge.custom.' + p) ?? '[]')
  } catch {
    return []
  }
}

async function loadModels() {
  const [list, keys] = await Promise.all([window.forge.agentModels(), window.forge.keysStatus()])
  for (const p of ['openai', 'openrouter'] as const) if (keys[p]) for (const id of customIds(p)) list.push({ id: `${p}:${id}`, label: id, group: CLOUD[p] })
  let saved = ''
  try {
    saved = localStorage.getItem('forge.model') ?? ''
  } catch {}
  modelSel.replaceChildren()
  const groups = new Map<string, HTMLOptGroupElement>()
  for (const m of list) {
    let g = groups.get(m.group)
    if (!g) {
      g = document.createElement('optgroup')
      g.label = m.group
      groups.set(m.group, g)
      modelSel.append(g)
    }
    g.append(new Option(m.label, m.id))
  }
  if (!list.length) modelSel.append(new Option('qwen3:8b (Ollama not running)', 'ollama:qwen3:8b'))
  if (list.some((m) => m.id === saved)) modelSel.value = saved
}

async function openSettings() {
  const dlg = $<HTMLDialogElement>('settings')
  const render = async () => {
    const keys = await window.forge.keysStatus()
    const box = h('div', 'dlg')
    box.append(h('h3', '', 'API keys'), h('p', 'note', 'Stored encrypted by your OS keychain. A key is only sent to the provider you pick. Local Ollama models need no key.'))
    for (const [p, name] of [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['openrouter', 'OpenRouter']] as const) {
      const row = h('div', 'keyrow')
      const input = document.createElement('input')
      input.type = 'password'
      input.autocomplete = 'off'
      input.placeholder = keys[p] ? '•••••••• saved (paste to replace)' : 'Paste API key'
      const msg = h('div', 'errtext')
      const save = h('button', '', 'Save')
      save.onclick = async () => {
        try {
          await window.forge.keysSet(p, input.value)
          await loadModels()
          await render()
        } catch (e) {
          msg.textContent = cleanErr(e)
        }
      }
      row.append(h('label', '', name), input, save)
      if (keys[p]) {
        const rm = h('button', '', 'Remove')
        rm.onclick = async () => {
          await window.forge.keysClear(p)
          await loadModels()
          await render()
        }
        row.append(rm)
      }
      box.append(row, msg)
      if (p !== 'anthropic') {
        const mrow = h('div', 'modelrow')
        const ids = document.createElement('input')
        ids.placeholder = 'Model IDs, comma-separated'
        ids.value = customIds(p).join(', ')
        ids.onchange = () => {
          try {
            localStorage.setItem('forge.custom.' + p, JSON.stringify(ids.value.split(',').map((s) => s.trim()).filter(Boolean)))
          } catch {}
          loadModels()
        }
        mrow.append(h('label', 'note', 'Models'), ids)
        box.append(mrow)
      }
    }
    const close = h('button', 'close', 'Done')
    close.onclick = () => dlg.close()
    box.append(close)
    dlg.replaceChildren(box)
  }
  await render()
  dlg.showModal()
}

export function initChat(opts: { onFileChanged: (path: string) => void }) {
  onFileChanged = opts.onFileChanged
  try {
    modeSel.value = localStorage.getItem('forge.mode') ?? 'ask-all'
  } catch {}
  loadModels()
  modelSel.onfocus = loadModels
  showEmpty()
  window.forge.onAgentEvent(handle)

  prompt.oninput = grow
  prompt.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  }
  sendBtn.onclick = () => (running ? window.forge.agentStop() : send())
  $('gear').onclick = openSettings
  $('new').onclick = () => {
    if (running) return
    window.forge.agentNew()
    thread.replaceChildren()
    cards.clear()
    reply = null
    showEmpty()
  }
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
      e.preventDefault()
      prompt.focus()
    }
  })
}
