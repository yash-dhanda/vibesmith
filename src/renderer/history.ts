import type { ChatListItem } from '../preload'
import type { RunSummary } from '../main/team/service'
import { folderName, timeAgo } from './format'
import { icon } from './icons'
import { h } from './ui'
import { mark } from './glyphs'
import { morphChildren } from './morph'

const list = document.getElementById('chat-list')!
const seen = new Set<string>() // only chats appearing for the first time animate in, so live re-renders stay still
const armed = new Map<string, ReturnType<typeof setTimeout>>() // chats whose Delete? is showing, waiting for the second click

export { folderName }

type Handlers = { open: (id: string) => void; remove: (id: string) => void; rename: (id: string, title: string) => void; openRun?: (id: string) => void }

const RUN_STATUS: Record<RunSummary['status'], string> = { planning: 'Planning', running: 'Working', paused: 'Paused', verifying: 'Checking', awaiting_approval: 'Ready for you', done: 'Finished', failed: 'Needs attention', cancelled: 'Cancelled', interrupted: 'Interrupted' }
const clip = (t: string, n = 60) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x }

// How long ago, without the word "ago": the sidebar row is one short line.
const when = (t: number) => timeAgo(t).replace(/ ago$/, '')
const statusOf = (r: RunSummary) => (r.status === 'awaiting_approval' || r.pendingApprovals > 0 ? 'waiting' : ['planning', 'running', 'verifying'].includes(r.status) ? 'running' : 'idle')

// A Crew run sits in the same list as the chats, with the crew icon; opening it goes to the Crew screen.
function runItem(r: RunSummary, active: boolean, handlers: Handlers, fresh: () => number) {
  const key = `run:${r.id}`
  const item = h('div', 'chat-item run-item' + (active ? ' active' : ''))
  item.dataset.key = key
  if (!seen.has(key)) { seen.add(key); item.classList.add('enter'); item.style.setProperty('--i', String(Math.min(fresh(), 12))) }
  const waiting = statusOf(r) === 'waiting'
  item.title = `${r.goal}\n${r.project}\n${waiting && r.status !== 'awaiting_approval' ? 'Needs your answer' : RUN_STATUS[r.status]} · ${timeAgo(r.updatedAt)}`
  const open = h('button', 'chat-open run-open')
  open.setAttribute('aria-label', `Open Crew run: ${clip(r.goal, 80)}`)
  if (active) open.setAttribute('aria-current', 'page')
  const row = h('span', 'row1')
  if (statusOf(r) === 'running') row.append(mark('active'))
  else if (waiting) row.append(mark('ask'))
  const crew = icon('users', 'sm'); crew.classList.add('run-icon')
  row.append(crew, h('span', 't', clip(r.goal, 90)), h('span', 'when', when(r.updatedAt)))
  open.append(row); item.append(open)
  open.onclick = () => handlers.openRun?.(r.id)
  return item
}

// Which project groups the user folded away (kept between sessions).
const FOLD_KEY = 'forge.sideFolded'
const folded = (() => { try { return new Set<string>(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]')) } catch { return new Set<string>() } })()
const saveFolded = () => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])) } catch {} }

function head(label: string, count: number, key: string | null, redraw: () => void, title = '') {
  const el = h('button', 'proj-head' + (key && folded.has(key) ? ' folded' : '')) as HTMLButtonElement
  el.type = 'button'
  el.dataset.key = `head:${key ?? 'active'}` // kept between redraws, so the chevron turns instead of jumping
  if (key) el.setAttribute('aria-expanded', String(!folded.has(key)))
  if (title) el.title = title
  const chev = icon('chevron', 'sm'); chev.classList.add('proj-chev')
  el.append(...(key ? [chev] : []), h('span', 'proj-name', label), h('span', 'proj-count', String(count)))
  if (key) el.onclick = () => { if (folded.has(key)) folded.delete(key); else folded.add(key); saveFolded(); redraw() }
  return el
}

type Entry = { at: number; chat: ChatListItem } | { at: number; run: RunSummary }
let lastArgs: Parameters<typeof renderHistory> | null = null

export function renderHistory(chats: ChatListItem[], activeId: string, query: string, handlers: Handlers, runs: RunSummary[] = [], activeRun = '') {
  lastArgs = [chats, activeId, query, handlers, runs, activeRun]
  const out = h('div') // built off the page, then morphed in: rows that stay keep hover, a rename, an armed Delete? and their spinner
  if (!chats.length && !runs.length) {
    out.append(h('div', 'empty-list', query ? 'No chats or runs match' : 'Your chats and Crew runs will show up here'))
    morphChildren(list, out)
    return
  }
  const redraw = () => { if (lastArgs) renderHistory(...lastArgs) }
  const merged: Entry[] = [...chats.map((chat) => ({ at: chat.updatedAt, chat })), ...runs.map((run) => ({ at: run.updatedAt, run }))].sort((a, b) => b.at - a.at)
  const live = (e: Entry) => ('run' in e ? statusOf(e.run) !== 'idle' : e.chat.status !== 'idle')
  const projectOf = (e: Entry) => ('run' in e ? e.run.project : e.chat.project) ?? ''
  let fresh = 0
  const draw = (e: Entry) => ('run' in e ? runItem(e.run, e.run.id === activeRun, handlers, () => fresh++) : chatItem(e.chat, e.chat.id === activeId && !activeRun, handlers, () => fresh++))

  // what is working or waiting for you comes first, wherever it lives
  const active = merged.filter(live)
  if (active.length) { out.append(head('Active', active.length, null, redraw, 'Working or waiting for you')); for (const e of active) out.append(draw(e)) }

  // the rest, by project folder, the most recently used folder first; a folder folds away
  const groups = new Map<string, Entry[]>()
  for (const e of merged.filter((x) => !live(x))) { const k = projectOf(e); groups.set(k, [...(groups.get(k) ?? []), e]) }
  for (const [project, items] of groups) {
    const key = project || 'none'
    const holdsActive = items.some((e) => ('run' in e ? e.run.id === activeRun : e.chat.id === activeId && !activeRun))
    const isFolded = folded.has(key) && !holdsActive && !query.trim()
    const header = head(project ? folderName(project) : 'No folder', items.length, key, redraw, project)
    if (isFolded) header.classList.add('folded')
    else header.classList.remove('folded')
    out.append(header)
    if (!isFolded) for (const e of items) out.append(draw(e))
  }
  morphChildren(list, out)
}

function chatItem(c: ChatListItem, active: boolean, handlers: Handlers, fresh: () => number) {
  const item = h('div', 'chat-item' + (active ? ' active' : ''))
  item.dataset.key = `chat:${c.id}`
  if (!seen.has(c.id)) { seen.add(c.id); item.classList.add('enter'); item.style.setProperty('--i', String(Math.min(fresh(), 12))) }
  item.title = `${c.title}\n${c.project ?? ''}\n${c.status === 'running' ? 'Working' : c.status === 'waiting' ? 'Needs your approval' : timeAgo(c.updatedAt)}`
  const open = h('button', 'chat-open')
  open.setAttribute('aria-label', `Open ${c.title}`)
  if (active) open.setAttribute('aria-current', 'page')
  const line = h('span', 'row1')
  if (c.status !== 'idle') line.append(mark(c.status === 'running' ? 'active' : 'ask'))
  line.append(h('span', 't', c.title), h('span', 'when', when(c.updatedAt)))
  const x = h('button', 'x')
  x.append(icon('x', 'sm'))
  x.title = 'Delete chat'
  x.setAttribute('aria-label', `Delete ${c.title}`)
  // Two clicks, no native popup: the first turns the button into "Delete?", the second deletes.
  // Handlers reach the live row through the event: a redraw copies them onto the row already on the page.
  x.onclick = (e) => {
    e.stopPropagation()
    const b = e.currentTarget as HTMLElement, row = b.closest('.chat-item')!
    clearTimeout(armed.get(c.id)); armed.delete(c.id)
    if (!b.classList.contains('confirm')) { // this button, not the timer, says whether it is armed: a row folded or filtered away while armed comes back unarmed
      row.setAttribute('data-hold', '') // a sidebar redraw leaves an armed row alone
      b.classList.add('confirm')
      b.replaceChildren(document.createTextNode('Delete?'))
      armed.set(c.id, setTimeout(() => {
        armed.delete(c.id)
        row.removeAttribute('data-hold')
        b.classList.remove('confirm')
        b.replaceChildren(icon('x', 'sm'))
      }, 3000))
      return
    }
    row.removeAttribute('data-hold')
    handlers.remove(c.id)
  }
  open.append(line)
  item.append(open, x)
  open.onclick = () => handlers.open(c.id)
  // Double-click renames in place, like a file manager.
  item.ondblclick = (e) => {
    e.preventDefault()
    const row = e.currentTarget as HTMLElement, openBtn = row.querySelector<HTMLElement>('.chat-open')!
    if (row.hasAttribute('data-hold')) return
    row.setAttribute('data-hold', '') // a redraw during a rename used to remove the input, and its blur saved the half-typed title
    const input = document.createElement('input')
    input.className = 'edit'
    input.value = c.title
    openBtn.hidden = true
    row.prepend(input)
    input.focus()
    input.select()
    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      const keys = document.activeElement === input // Enter or Escape, not a click elsewhere: the keyboard goes back to the row
      if (save && input.value.trim() && input.value.trim() !== c.title) handlers.rename(c.id, input.value)
      input.remove()
      openBtn.hidden = false
      row.removeAttribute('data-hold')
      if (keys) openBtn.focus()
    }
    input.onkeydown = (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Enter') finish(true)
      if (ev.key === 'Escape') finish(false)
    }
    input.onblur = () => finish(true)
    input.onclick = (ev) => ev.stopPropagation()
  }
  return item
}
