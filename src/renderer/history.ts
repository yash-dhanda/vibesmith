import type { ChatListItem } from '../preload'
import { folderName, timeAgo, groupOf } from './format'
import { icon } from './icons'
import { h } from './ui'

const list = document.getElementById('chat-list')!

export { folderName }

type Handlers = { open: (id: string) => void; remove: (id: string) => void; rename: (id: string, title: string) => void }

export function renderHistory(chats: ChatListItem[], activeId: string, query: string, handlers: Handlers) {
  list.replaceChildren()
  if (!chats.length) {
    list.append(h('div', 'empty-list', query ? 'No chats match.' : 'Your chats will show up here.'))
    return
  }
  let last = ''
  for (const c of chats) {
    const g = groupOf(c.updatedAt)
    if (g !== last) {
      list.append(h('div', 'group-label', g))
      last = g
    }
    const item = h('div', 'chat-item' + (c.id === activeId ? ' active' : ''))
    item.title = c.project ?? ''
    const open = h('button', 'chat-open')
    open.setAttribute('aria-label', `Open ${c.title}`)
    if (c.id === activeId) open.setAttribute('aria-current', 'page')
    const row = h('span', 'row1')
    if (c.status !== 'idle') row.append(h('span', 'st ' + c.status))
    const title = h('span', 't', c.title)
    row.append(title)
    const sub = h('span', 's', c.status === 'running' ? 'Working…' : c.status === 'waiting' ? 'Needs your approval' : `${folderName(c.project)} · ${timeAgo(c.updatedAt)}`)
    if (c.status === 'waiting') sub.style.color = 'var(--warn)'
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
