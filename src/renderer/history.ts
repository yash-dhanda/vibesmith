import type { ChatListItem } from '../preload'
import { folderName, timeAgo, groupOf } from './format'
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
    const item = h('button', 'chat-item' + (c.id === activeId ? ' active' : ''))
    item.title = c.project ?? ''
    const row = h('span', 'row1')
    if (c.status !== 'idle') row.append(h('span', 'st ' + c.status))
    const title = h('span', 't', c.title)
    row.append(title)
    const sub = h('span', 's', c.status === 'running' ? 'Working…' : c.status === 'waiting' ? 'Needs your approval' : `${folderName(c.project)} · ${timeAgo(c.updatedAt)}`)
    if (c.status === 'waiting') sub.style.color = 'var(--warn)'
    const x = h('button', 'x', '✕')
    x.title = 'Delete chat'
    x.onclick = (e) => {
      e.stopPropagation()
      handlers.remove(c.id)
    }
    item.append(row, sub, x)
    item.onclick = () => handlers.open(c.id)
    // Double-click renames in place, like a file manager.
    item.ondblclick = (e) => {
      e.preventDefault()
      const input = document.createElement('input')
      input.className = 'edit'
      input.value = c.title
      title.replaceWith(input)
      input.focus()
      input.select()
      let done = false
      const finish = (save: boolean) => {
        if (done) return
        done = true
        if (save && input.value.trim() && input.value.trim() !== c.title) handlers.rename(c.id, input.value)
        else input.replaceWith(title)
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
