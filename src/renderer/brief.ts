import type { AgentEvent } from '../preload'
import { folderName } from './format'
import { $, h, cleanErr, toast } from './ui'
import { icon } from './icons'

type Priority = { text: string; skipped: boolean }
let chatId = ''
let priorities: Priority[] = []
let goal = ''
let changed = new Map<string, string>()
let state = 'Ready when you are'
let page: string | null = null
let plan: { text: string; status: 'todo' | 'doing' | 'done' }[] = []
let openFile: (path: string) => void = () => {}
const save = () => { try { localStorage.setItem(`forge.brief.${chatId}`, JSON.stringify(priorities)) } catch {} }

export function initBrief(onFile: (path: string) => void) {
  openFile = onFile
  $('brief-toggle').onclick = () => {
    const on = $('app').classList.toggle('brief-open')
    $('brief-toggle').setAttribute('aria-expanded', String(on))
  }
  $('brief-close').onclick = () => {
    $('app').classList.remove('brief-open')
    $('brief-toggle').setAttribute('aria-expanded', 'false')
    $('brief-toggle').focus()
  }
  $('priority-form').onsubmit = (e) => {
    e.preventDefault()
    const input = $<HTMLInputElement>('priority-input')
    const text = input.value.trim()
    if (!text || priorities.length >= 12) return
    priorities.push({ text: text.slice(0, 240), skipped: false })
    input.value = ''
    save()
    renderPriorities()
  }
}

function renderPriorities() {
  const list = $('priorities')
  list.replaceChildren()
  for (const [index, item] of priorities.entries()) {
    const row = h('li', 'priority' + (item.skipped ? ' skipped' : ''))
    const label = h('label')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = !item.skipped
    check.onchange = () => { item.skipped = !check.checked; save(); renderPriorities() }
    label.append(check, h('span', '', item.text))
    const up = h('button', 'icon-btn sm') as HTMLButtonElement
    up.append(icon('arrowup', 'sm'))
    up.disabled = index === 0
    up.setAttribute('aria-label', `Move ${item.text} earlier`)
    up.onclick = () => { [priorities[index - 1], priorities[index]] = [item, priorities[index - 1]]; save(); renderPriorities(); ($('priorities').children[index - 1].querySelector('input') as HTMLElement).focus() }
    const remove = h('button', 'icon-btn sm')
    remove.append(icon('x', 'sm'))
    remove.setAttribute('aria-label', `Remove ${item.text}`)
    remove.onclick = () => { priorities.splice(index, 1); save(); renderPriorities(); $('priority-input').focus() }
    row.append(label, up, remove)
    list.append(row)
  }
  $('priority-count').textContent = `${priorities.filter(p => !p.skipped).length} included`
  $<HTMLInputElement>('priority-input').disabled = priorities.length >= 12
}

export function resetBrief(id: string, project: string | null) {
  chatId = id
  goal = ''
  changed = new Map()
  page = null
  plan = []
  state = 'Ready when you are'
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`forge.brief.${id}`) ?? '[]')
    priorities = Array.isArray(stored) ? stored.filter((p): p is Priority => p && typeof p.text === 'string' && typeof p.skipped === 'boolean').slice(0, 12) : []
  } catch { priorities = [] }
  renderPriorities()
  projectBrief(project)
  render()
}

export function projectBrief(project: string | null) {
  $('brief-name').textContent = project ? folderName(project) : 'Your next idea'
  $('brief-folder').textContent = project ? 'Saved in your project folder' : 'Choose a folder to begin'
}

export function briefGoal(text: string) {
  if (!goal) goal = text
  render()
}

// User priorities are explicit instructions for the NEXT message, never a fabricated agent plan.
export function withPriorities(text: string) {
  const included = priorities.filter(p => !p.skipped)
  return included.length ? `${text}\n\nMy build priorities, in order:\n${included.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}` : text
}

export function briefEvent(ev: AgentEvent) {
  if (ev.type === 'plan') plan = ev.items
  if (ev.type === 'tool') state = ev.needsApproval ? 'Your approval is needed' : ev.name === 'run_command' ? 'Trying the next step' : /edit|create/.test(ev.name) ? 'Shaping your project' : 'Getting to know your project'
  if (ev.type === 'verify') state = ev.ok ? 'Project check passed' : 'Project check needs attention'
  if (ev.type === 'changes') for (const f of ev.files) {
    changed.set(f.path, f.status)
    if (f.status !== 'deleted' && /\.html?$/i.test(f.path)) page = f.path
  }
  if (ev.type === 'done') state = ev.reason === 'finished' ? 'Run finished · review the result' : ev.reason === 'unverified' ? 'Finished · check still failing' : 'Run stopped · you can continue'
  if (ev.type === 'error') state = 'Couldn’t finish this run'
  render()
}

export function briefUndone(paths: string[]) {
  for (const path of paths) changed.delete(path)
  if (page && paths.includes(page)) page = null
  state = 'Changes restored'
  render()
}

function render() {
  const checklist = $('agent-plan')
  $('agent-plan-section').hidden = !plan.length
  checklist.replaceChildren()
  for (const item of plan) {
    const row = h('li', `plan-item ${item.status}`)
    row.append(h('span', 'plan-marker', item.status === 'done' ? '✓' : item.status === 'doing' ? '•' : '○'), h('span', '', item.text))
    checklist.append(row)
  }
  $('brief-goal').textContent = goal || 'A small idea can become something real. Describe yours to start the build.'
  $('brief-status').textContent = state
  const files = $('brief-files')
  files.replaceChildren()
  $('brief-files-title').textContent = changed.size ? `Taking shape · ${changed.size} files` : 'Taking shape'
  if (!changed.size) files.append(h('p', 'brief-muted', 'Files you change will appear here as your idea takes shape.'))
  for (const [path, status] of [...changed].slice(-8)) {
    const b = h('button', 'artifact') as HTMLButtonElement
    const info = h('span')
    info.append(h('strong', '', folderName(path)), h('small', '', `${status === 'added' ? 'Created' : status === 'deleted' ? 'Removed' : 'Updated'} · ${path}`))
    b.append(icon('code'), info, icon('chevron', 'sm'))
    b.disabled = status === 'deleted'
    b.onclick = () => openFile(path)
    files.append(b)
  }
  const preview = $('brief-preview')
  preview.hidden = !page
  preview.onclick = async () => {
    if (!page) return
    const id = chatId
    try {
      if (typeof window.forge.previewStart === 'function') {
        const { url } = await window.forge.previewStart(id)
        await window.forge.openExternal(url)
      } else await window.forge.openPath(id, page)
    } catch (e) { toast(cleanErr(e), 4000) }
  }
}
