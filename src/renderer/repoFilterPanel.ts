import { loadFilters, MIN_STARS, saveFilters, type RepoFilters } from './repoFilters'
import { compactCount } from './stars'
import { h, onOff } from './ui'

// The collapsible "Filters" block shared by the Top GitHub repos dialog and More suggestions: Off | On pairs, each with a line of explanation,
// remembered in localStorage and applied live (onChange runs after every change).
const ROWS: [Exclude<keyof RepoFilters, 'minStars'>, string, string][] = [
  ['verified', 'Verified owners only', 'Keep repositories owned by a GitHub organisation that GitHub has verified. GitHub does not verify individual accounts.'],
  ['hideFake', 'Hide fake-looking repos', 'Hide fake download pages and star-botted copies.'],
  ['hideForks', 'Hide forks and archived', 'Hide copies of other repositories and ones the owner has stopped maintaining.'],
  ['licensed', 'Only repos with a license', 'Keep repositories that state how they may be used.'],
  ['recent', 'Only repos updated in the last year', 'Hide repositories nobody has pushed to for a year.'],
]

export function repoFilterPanel(o: { storeKey: string; defaults: RepoFilters; onChange: () => void }) {
  const openKey = `${o.storeKey}.open`
  let f = loadFilters(localStorage, o.storeKey, o.defaults)
  const root = h('details', 'gh-filters') as HTMLDetailsElement
  root.open = localStorage.getItem(openKey) !== '0'
  root.ontoggle = () => { try { localStorage.setItem(openKey, root.open ? '1' : '0') } catch {} }
  const sum = h('summary', '', 'Filters')
  const count = h('span', 'gh-count')
  count.setAttribute('role', 'status')
  sum.append(count)
  const rows = h('div', 'gh-frows')
  const ownerNote = h('div', 'gh-fnote faint')
  ownerNote.setAttribute('role', 'status')
  const verifiedNote = h('span', 'gh-vcount')
  root.append(sum, rows, ownerNote)

  const change = (p: Partial<RepoFilters>) => { f = { ...f, ...p }; saveFilters(localStorage, o.storeKey, f); o.onChange() }
  function build() {
    rows.replaceChildren(...ROWS.map(([k, title, desc]) => {
      const row = h('div', 'gh-frow')
      const text = h('div', 'gh-ftext')
      const t = h('strong', '', title)
      if (k === 'verified') t.append(verifiedNote)
      text.append(t, h('span', 'gh-fdesc', desc))
      const sw = onOff(f[k], (v) => change({ [k]: v }))
      sw.setAttribute('aria-label', title)
      row.append(text, sw)
      return row
    }))
    const row = h('div', 'gh-frow')
    const sel = document.createElement('select')
    sel.className = 'gh-select'
    sel.setAttribute('aria-label', 'Minimum stars')
    for (const n of MIN_STARS) sel.append(new Option(n ? compactCount(n) : 'Any', String(n)))
    sel.value = String(f.minStars)
    sel.onchange = () => change({ minStars: Number(sel.value) })
    const text = h('div', 'gh-ftext')
    text.append(h('strong', '', 'Minimum stars'), h('span', 'gh-fdesc', 'Hide repositories with fewer stars.'))
    const reset = h('button', 'link-btn', 'Reset filters') as HTMLButtonElement
    reset.type = 'button'
    reset.onclick = () => { f = { ...o.defaults }; saveFilters(localStorage, o.storeKey, f); build(); o.onChange() }
    row.append(text, sel)
    rows.append(row, reset)
  }
  build()
  return {
    el: root,
    get: () => f,
    // Used by the "Show N hidden" shortcut: changes a switch from outside and redraws the panel.
    set(p: Partial<RepoFilters>) { f = { ...f, ...p }; saveFilters(localStorage, o.storeKey, f); build(); o.onChange() },
    setCount(shown: number, total: number) { count.textContent = ` · Showing ${shown} of ${total}` },
    setVerified(verified: number, total: number) { verifiedNote.textContent = verified || total ? ` (${verified} verified of ${total})` : '' },
    setOwnerNote(text: string) { ownerNote.textContent = text },
  }
}
