// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ChatListItem } from '../preload'

document.body.innerHTML = '<div id="chat-list"></div>'
const { renderHistory } = await import('./history') // it takes #chat-list when it loads
const list = document.getElementById('chat-list')!

const chats: ChatListItem[] = [
  { id: 'c1', title: 'Busy', project: '/home/me/app', updatedAt: 3, status: 'running' },
  { id: 'c2', title: 'Hi', project: '/home/me/app', updatedAt: 2, status: 'idle' },
  { id: 'c3', title: 'Other', project: '/home/me/site', updatedAt: 1, status: 'idle' },
]
const row = (id: string) => list.querySelector<HTMLElement>(`[data-key="chat:${id}"]`)!

describe('sidebar redraw', () => {
  it('keeps the rows on the page, an armed Delete? and a rename in progress', () => {
    const handlers = { open: vi.fn(), remove: vi.fn(), rename: vi.fn() }
    renderHistory(chats, 'c2', '', handlers)
    const rows = Array.from(list.children), spinner = row('c1').querySelector('.ck-mark[data-state="active"]')
    expect(spinner).not.toBeNull()
    renderHistory(chats.map((c) => ({ ...c })), 'c2', '', handlers)
    expect(Array.from(list.children).every((n, i) => n === rows[i])).toBe(true)
    expect(row('c1').querySelector('.ck-mark[data-state="active"]')).toBe(spinner)

    const x = row('c3').querySelector<HTMLElement>('.x')!
    x.click()
    renderHistory(chats, 'c2', '', handlers)
    expect(x.isConnected).toBe(true); expect(x.textContent).toBe('Delete?')
    const site = list.querySelector<HTMLElement>('[data-key="head:/home/me/site"]')! // folded away and back while armed: the new row asks again
    site.click(); expect(list.querySelector('[data-key="chat:c3"]')).toBeNull()
    site.click(); row('c3').querySelector<HTMLElement>('.x')!.click()
    expect(handlers.remove).not.toHaveBeenCalled(); expect(row('c3').querySelector('.x')!.textContent).toBe('Delete?')
    row('c3').querySelector<HTMLElement>('.x')!.click()
    expect(handlers.remove).toHaveBeenCalledWith('c3')

    row('c2').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const input = row('c2').querySelector<HTMLInputElement>('input.edit')!
    input.value = 'Renamed half'
    renderHistory([chats[0], chats[1], { ...chats[2], updatedAt: 5 }], 'c2', '', handlers) // another folder jumps above it mid-rename
    expect(list.firstElementChild?.nextElementSibling?.nextElementSibling?.textContent).toContain('site')
    expect(input.isConnected).toBe(true); expect(handlers.rename).not.toHaveBeenCalled()
    input.value = 'Renamed'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(handlers.rename).toHaveBeenCalledWith('c2', 'Renamed')
    expect(row('c2').hasAttribute('data-hold')).toBe(false)
  })
})
