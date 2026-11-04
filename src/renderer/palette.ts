import { $, h } from './ui'
import { icon, type IconName } from './icons'
import { openSearch } from './searchPanel'

export type Command = { label: string; icon?: IconName; detail?: string; run: () => void }
export function initPalette(commands: () => Command[]) {
  const dialog = $<HTMLDialogElement>('palette')
  const input = $<HTMLInputElement>('command-search')
  const list = $('command-results')
  let active = 0
  let matches: Command[] = []
  const paint = () => {
    const q = input.value.trim().toLowerCase()
    matches = [{ label: 'Search everything', icon: 'search' as IconName, detail: 'Chats, Crew runs, history · Ctrl Shift F', run: openSearch }, ...commands()].filter(c => `${c.label} ${c.detail ?? ''}`.toLowerCase().includes(q)).slice(0, 40)
    active = Math.min(active, Math.max(0, matches.length - 1))
    list.replaceChildren()
    matches.forEach((c, i) => {
      const b = h('button', 'command' + (i === active ? ' selected' : ''))
      b.id = `command-${i}`
      b.setAttribute('role', 'option')
      b.setAttribute('aria-selected', String(i === active))
      const text = h('span')
      text.append(h('strong', '', c.label))
      if (c.detail) text.append(h('small', '', c.detail))
      b.append(icon(c.icon ?? 'chevron', 'sm'), text)
      b.onmousedown = e => e.preventDefault()
      b.onclick = () => { dialog.close(); c.run() }
      list.append(b)
    })
    if (!matches.length) list.append(h('p', 'palette-empty', 'No matches. Try a chat title, model, or action.'))
    if (matches.length) input.setAttribute('aria-activedescendant', `command-${active}`)
    else input.removeAttribute('aria-activedescendant')
    $('command-count').textContent = `${matches.length}`
  }
  const open = () => {
    input.value = ''
    active = 0
    list.classList.add('opening') // results stagger in on open, not on every keystroke
    paint()
    if (!dialog.open) dialog.showModal()
    input.focus()
  }
  input.oninput = () => { list.classList.remove('opening'); active = 0; paint() }
  input.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      list.classList.remove('opening')
      active = matches.length ? (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0
      paint()
      list.children[active]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && matches[active]) {
      e.preventDefault()
      const c = matches[active]
      dialog.close()
      c.run()
    }
  }
  $('commands').onclick = open
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open() }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch() }
  })
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close() } })
}
