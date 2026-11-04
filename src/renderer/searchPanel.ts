import type { SearchHit } from '../main/search'
import { timeAgo } from './format'
import { icon } from './icons'
import { openProjectHistory } from './projectHistory'
import { cleanErr, h, toast } from './ui'

// "Search everything": chats, Crew runs and project history in one box. Opened by Ctrl Shift F and the palette entry.
const GROUPS: { kind: SearchHit['kind']; title: string }[] = [
  { kind: 'chat', title: 'Chats' },
  { kind: 'run', title: 'Crew runs' },
  { kind: 'history', title: 'History' },
]
let dialog: HTMLDialogElement | null = null
let reset = () => {}

function open(hit: SearchHit) {
  if (hit.kind === 'chat') window.dispatchEvent(new CustomEvent('forge-open-chat', { detail: hit.id }))
  else if (hit.kind === 'run') window.dispatchEvent(new CustomEvent('forge-open-run', { detail: hit.id }))
  // A screen that wants to show this project's history cancels the event; otherwise the history of the folder on screen opens.
  else if (window.dispatchEvent(new CustomEvent('forge-open-history', { detail: hit.project, cancelable: true }))) void openProjectHistory().catch((e) => toast(cleanErr(e), 4000))
}

function marked(text: string, ranges: [number, number][]) {
  const p = h('span', 'sa-snippet')
  let at = 0
  for (const [a, b] of ranges) {
    if (a > at) p.append(text.slice(at, a))
    p.append(h('mark', '', text.slice(a, b)))
    at = b
  }
  p.append(text.slice(at))
  return p
}

function build(): HTMLDialogElement {
  const d = h('dialog') as HTMLDialogElement
  d.id = 'search-all'
  d.setAttribute('aria-label', 'Search everything')
  const bar = h('div', 'palette-search')
  const input = h('input') as HTMLInputElement
  input.id = 'search-all-input'
  input.placeholder = 'Search chats, Crew runs and history'
  input.autocomplete = 'off'
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-label', 'Search chats, Crew runs and history')
  input.setAttribute('aria-controls', 'search-all-results')
  input.setAttribute('aria-expanded', 'true')
  input.setAttribute('aria-autocomplete', 'list')
  bar.append(icon('search', 'sm'), input, h('kbd', '', 'Esc'))
  const list = h('div')
  list.id = 'search-all-results'
  list.setAttribute('role', 'listbox')
  const count = h('span')
  const foot = h('div', 'palette-foot')
  const keys = h('span')
  keys.append(h('kbd', '', '↑'), h('kbd', '', '↓'), ' move · ', h('kbd', '', '↵'), ' open')
  foot.append(keys, count)
  d.append(bar, list, foot)

  let hits: SearchHit[] = []
  let active = 0
  let seq = 0
  let timer: ReturnType<typeof setTimeout>
  const message = (text: string) => { list.replaceChildren(h('p', 'palette-empty', text)); count.textContent = ''; hits = []; input.removeAttribute('aria-activedescendant') }
  const paint = () => {
    list.replaceChildren()
    hits.forEach((hit, i) => {
      if (i === 0 || hits[i - 1].kind !== hit.kind) list.append(h('div', 'sa-group', GROUPS.find((g) => g.kind === hit.kind)!.title))
      const b = h('button', 'sa-hit' + (i === active ? ' selected' : '')) as HTMLButtonElement
      b.id = `sa-hit-${i}`
      b.type = 'button'
      b.setAttribute('role', 'option')
      b.setAttribute('aria-selected', String(i === active))
      b.onmousedown = (e) => e.preventDefault()
      b.onclick = () => { d.close(); open(hit) }
      const top = h('span', 'sa-top')
      top.append(h('strong', '', hit.title || 'New chat'), h('small', '', [hit.project?.split(/[\\/]/).filter(Boolean).pop(), timeAgo(hit.at)].filter(Boolean).join(' · ')))
      b.append(top, marked(hit.snippet.text, hit.snippet.ranges))
      list.append(b)
    })
    count.textContent = `${hits.length}`
    input.setAttribute('aria-activedescendant', `sa-hit-${active}`)
  }
  const run = async () => {
    const q = input.value.trim()
    const mine = ++seq
    if (q.length < 2) return message('Type at least two letters.')
    try {
      const found = await window.forge.searchAll(q)
      if (mine !== seq) return // a newer keystroke is already on its way
      hits = GROUPS.flatMap((g) => found.filter((f) => f.kind === g.kind)) // grouped, ranked inside each group
      active = 0
      if (hits.length) paint()
      else message('Nothing found. Every word has to appear.')
    } catch (e) {
      if (mine === seq) message(cleanErr(e))
    }
  }
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 150) }
  input.onkeydown = (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && hits.length) {
      e.preventDefault()
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length
      paint()
      list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault()
      const hit = hits[active]
      d.close()
      open(hit)
    }
  }
  d.addEventListener('click', (e) => { if (e.target === d) d.close() })
  d.addEventListener('close', () => { seq++; clearTimeout(timer) })
  reset = () => { input.value = ''; message('Type at least two letters.') }
  return d
}

export function openSearch() {
  if (typeof window.forge.searchAll !== 'function') return
  if (!dialog) document.body.append((dialog = build()))
  if (!dialog.open) dialog.showModal()
  const input = dialog.querySelector<HTMLInputElement>('#search-all-input')!
  if (!input.value) reset()
  input.focus()
  input.select()
}
