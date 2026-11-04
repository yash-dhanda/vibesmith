import { icon } from './icons'
import { cleanErr, copy, h, toast } from './ui'

const TIP = 'What happened in this project so far'

// A quiet "History" link for the crew start screen and run header.
export function historyButton(runId?: string): HTMLButtonElement {
  const b = h('button', 'link-btn history-btn', 'History') as HTMLButtonElement
  b.type = 'button'
  b.prepend(icon('list', 'sm'))
  b.title = TIP
  b.hidden = typeof window.forge.teamHistory !== 'function'
  b.onclick = () => void openProjectHistory(runId)
  return b
}

let dlg: HTMLDialogElement | null = null

// The project's .forge/what-happened.txt in a modal: mono text, newest at the bottom, a filter, Copy path and Open file.
export async function openProjectHistory(runId?: string) {
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'project-history'; dlg.setAttribute('aria-label', 'History'); document.body.append(dlg) }
  const head = h('div', 'modal-head')
  const title = h('h3', '', 'History')
  title.prepend(icon('list'))
  const close = h('button', 'icon-btn')
  close.append(icon('x'))
  close.title = 'Close (Esc)'
  close.setAttribute('aria-label', 'Close')
  close.onclick = () => dlg!.close()
  head.append(title, h('span', 'grow'), close)
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.placeholder = 'Filter the history'
  filter.setAttribute('aria-label', 'Filter the history')
  const bar = h('label', 'history-filter')
  bar.append(icon('search', 'sm'), filter)
  const body = h('div', 'history-body')
  body.append(h('div', 'skel skel-row'))
  const foot = h('div', 'modal-foot')
  const where = h('span', 'modal-hint', TIP)
  where.prepend(icon('file', 'sm'))
  const copyPath = h('button', 'btn', 'Copy path') as HTMLButtonElement
  const open = h('button', 'btn primary', 'Open file') as HTMLButtonElement
  open.onclick = () => window.forge.teamHistoryOpen(runId).catch((e) => toast(cleanErr(e), 4000))
  open.hidden = (window as { __forgeRemote?: boolean }).__forgeRemote === true // it opens on the computer, not here
  foot.append(where, h('span', 'grow'), copyPath, open)
  dlg.replaceChildren(head, bar, body, foot)
  if (!dlg.open) dlg.showModal()
  close.focus()

  let hist: { path: string; text: string } | null = null
  try { hist = await window.forge.teamHistory(runId) } catch (e) { body.replaceChildren(h('p', 'errtext', cleanErr(e))); return }
  const lines = (hist?.text ?? '').split('\n')
  if (!hist || !hist.text.trim()) {
    body.replaceChildren(h('div', 'empty-state', ''))
    const empty = body.firstElementChild!
    const mark = h('div', 'empty-glyph')
    mark.append(icon('list'))
    empty.append(mark, h('div', 'empty-title', 'No history yet'), h('p', 'empty-copy', 'Nothing has happened here yet. The history starts with your first run.'))
    filter.disabled = copyPath.disabled = open.disabled = true
    return
  }
  where.replaceChildren(icon('file', 'sm'), document.createTextNode(hist.path))
  where.title = hist.path
  copyPath.onclick = () => void copy(hist!.path, 'Path copied')
  const pre = h('pre', 'history-text')
  const paint = () => {
    const q = filter.value.trim().toLowerCase()
    const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines
    pre.textContent = shown.length ? shown.join('\n') : 'No lines match.'
    body.scrollTop = body.scrollHeight // newest at the bottom
  }
  filter.oninput = paint
  body.replaceChildren(pre)
  paint()
}
