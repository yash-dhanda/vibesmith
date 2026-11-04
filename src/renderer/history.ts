import type { ChatListItem } from '../preload'
import type { RunSummary } from '../main/team/service'
import { folderName, timeAgo, groupOf } from './format'
import { icon } from './icons'
import { h } from './ui'
import { STEP_GLYPH } from './glyphs'

const list = document.getElementById('chat-list')!
const seen = new Set<string>() // only chats appearing for the first time animate in, so live re-renders stay still

export { folderName }

type Handlers = { open: (id: string) => void; remove: (id: string) => void; rename: (id: string, title: string) => void; openRun?: (id: string) => void }

const RUN_STATUS: Record<RunSummary['status'], string> = { planning: 'Planning', running: 'Working', paused: 'Paused', verifying: 'Checking', awaiting_approval: 'Ready for you', done: 'Finished', failed: 'Needs attention', cancelled: 'Cancelled', interrupted: 'Interrupted' }
const clip = (t: string, n = 60) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x }

// A Crew run sits in the same list as the chats, newest first, with the crew icon; opening it goes to the Crew screen.
function runItem(r: RunSummary, active: boolean, handlers: Handlers, fresh: () => number) {
  const item = h('div', 'chat-item run-item' + (active ? ' active' : ''))
  const key = `run:${r.id}`
  if (!seen.has(key)) { seen.add(key); item.classList.add('enter'); item.style.setProperty('--i', String(Math.min(fresh(), 12))) }
  item.title = `${r.goal}\n${r.project}`
  const open = h('button', 'chat-open run-open')
  open.setAttribute('aria-label', `Open Crew run: ${clip(r.goal, 80)}`)
  if (active) open.setAttribute('aria-current', 'page')
  const row = h('span', 'row1')
  const waiting = r.status === 'awaiting_approval' || r.pendingApprovals > 0
  if (['planning', 'running', 'verifying'].includes(r.status) && !waiting) row.append(h('span', 'st running'))
  else if (waiting) row.append(h('span', 'st waiting'))
  const crew = icon('users', 'sm'); crew.classList.add('run-icon')
  row.append(crew, h('span', 't', clip(r.goal)))
  const sub = h('span', 's' + (waiting ? ' wait' : ''), `${folderName(r.project)} · ${waiting && r.status !== 'awaiting_approval' ? 'Needs your answer' : RUN_STATUS[r.status]} · ${timeAgo(r.updatedAt)}`)
  open.append(row, sub); item.append(open)
  open.onclick = () => handlers.openRun?.(r.id)
  return item
}

export function renderHistory(chats: ChatListItem[], activeId: string, query: string, handlers: Handlers, runs: RunSummary[] = [], activeRun = '') {
  list.replaceChildren()
  if (!chats.length && !runs.length) {
    list.append(h('div', 'empty-list', query ? 'No chats or runs match.' : 'Your chats and Crew runs will show up here.'))
    return
  }
  const merged: ({ at: number; chat: ChatListItem } | { at: number; run: RunSummary })[] = [...chats.map((chat) => ({ at: chat.updatedAt, chat })), ...runs.map((run) => ({ at: run.updatedAt, run }))].sort((a, b) => b.at - a.at)
  let last = ''
  let fresh = 0
  for (const entry of merged) {
    const g = groupOf(entry.at)
    if (g !== last) {
      list.append(h('div', 'group-label', g))
      last = g
    }
    if ('run' in entry) { list.append(runItem(entry.run, entry.run.id === activeRun, handlers, () => fresh++)); continue }
    const c = entry.chat
    const item = h('div', 'chat-item' + (c.id === activeId && !activeRun ? ' active' : ''))
    if (!seen.has(c.id)) { seen.add(c.id); item.classList.add('enter'); item.style.setProperty('--i', String(Math.min(fresh++, 12))) }
    item.title = c.project ?? ''
    const open = h('button', 'chat-open')
    open.setAttribute('aria-label', `Open ${c.title}`)
    if (c.id === activeId && !activeRun) open.setAttribute('aria-current', 'page')
    const row = h('span', 'row1')
    if (c.status !== 'idle') row.append(h('span', 'st ' + c.status))
    const title = h('span', 't', c.title)
    row.append(title)
    const sub = h('span', 's' + (c.status === 'waiting' ? ' wait' : ''), c.status === 'running' ? `${STEP_GLYPH.working} Working…` : c.status === 'waiting' ? `${STEP_GLYPH.ask} Needs your approval` : `${folderName(c.project)} · ${timeAgo(c.updatedAt)}`)
    const x = h('button', 'x')
    x.append(icon('x', 'sm'))
    x.title = 'Delete chat'
    x.setAttribute('aria-label', `Delete ${c.title}`)
    // Two clicks, no native popup: the first turns the button into "Delete?", the second deletes.
    let armed: ReturnType<typeof setTimeout> | null = null
    x.onclick = (e) => {
      e.stopPropagation()
      if (!armed) {
        x.classList.add('confirm')
        x.replaceChildren(document.createTextNode('Delete?'))
        armed = setTimeout(() => {
          armed = null
          x.classList.remove('confirm')
          x.replaceChildren(icon('x', 'sm'))
        }, 3000)
        return
      }
      clearTimeout(armed)
      handlers.remove(c.id)
    }
    open.append(row, sub)
    item.append(open, x)
    open.onclick = () => handlers.open(c.id)
    // Double-click renames in place, like a file manager.
    item.ondblclick = (e) => {
      e.preventDefault()
      const input = document.createElement('input')
      input.className = 'edit'
      input.value = c.title
      open.hidden = true
      item.prepend(input)
      input.focus()
      input.select()
      let done = false
      const finish = (save: boolean) => {
        if (done) return
        done = true
        if (save && input.value.trim() && input.value.trim() !== c.title) handlers.rename(c.id, input.value)
        input.remove()
        open.hidden = false
      }
      input.onkeydown = (ev) => {
        ev.stopPropagation()
        if (ev.key === 'Enter') finish(true)
        if (ev.key === 'Escape') finish(false)
      }
      input.onblur = () => finish(true)
      input.onclick = (ev) => ev.stopPropagation()
    }
    list.append(item)
  }
}
