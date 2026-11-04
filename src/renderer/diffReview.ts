import { liteColor } from './codeColor'
import { commentsToMessage, parseUnifiedDiff, type DiffFile, type DiffLine, type ReviewComment } from './diffParse'
import { icon } from './icons'
import { cleanErr, h, toast } from './ui'

// A diff drawn by hand, file by file with line numbers, so a line can carry a review comment. Monaco's diff editor (Crew's own view) is read-only.
// Also used by the restore points browser, without the comment buttons.

const LINE_CAP = 6000 // rows drawn at first and per "show more"; a huge diff would otherwise freeze the dialog
const COLOR_CAP = 600 // longer lines (minified code) stay plain: colouring them costs more than it shows
const STATUS_WORD = { added: 'new', deleted: 'deleted', renamed: 'renamed', modified: '' } as const

export type DiffView = { collapseAll(on: boolean): void }

export function mountDiffView(host: HTMLElement, files: DiffFile[], opts: { onComment?: (file: DiffFile, line: DiffLine, row: HTMLElement) => void } = {}): DiffView {
  host.replaceChildren()
  host.classList.add('dr-diff')
  const bodies: HTMLElement[] = []
  const blocks: HTMLElement[] = []
  const total = files.reduce((n, f) => n + f.hunks.reduce((m, k) => m + k.lines.length, 0) + (f.hunks.length ? 0 : 1), 0)
  const more = h('button', 'btn dr-more') as HTMLButtonElement
  more.type = 'button'
  let drawn = 0, limit = 0
  let f = 0, k = 0, l = 0 // the next line to draw: file, hunk, line

  const startFile = (file: DiffFile) => {
    const block = h('section', 'dr-file')
    const head = h('button', 'dr-file-head') as HTMLButtonElement
    head.type = 'button'
    head.setAttribute('aria-expanded', 'true')
    const word = STATUS_WORD[file.status]
    head.append(icon('down', 'sm'), h('span', 'dr-path', file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path), ...(word ? [h('span', 'dr-chip ' + file.status, word)] : []), h('span', 'dr-count', `+${file.added} −${file.removed}`))
    const body = h('div', 'dr-file-body')
    head.onclick = () => head.setAttribute('aria-expanded', String(block.classList.toggle('collapsed') === false))
    block.append(head, body)
    more.before(block)
    blocks.push(block)
    bodies.push(body)
  }

  const rowOf = (file: DiffFile, line: DiffLine) => {
    const row = h('div', `dr-row ${line.kind}`)
    const add = h('span', 'dr-gap')
    if (opts.onComment) {
      const b = h('button', 'dr-add', '+') as HTMLButtonElement
      b.type = 'button'
      b.title = b.ariaLabel = `Comment on line ${line.kind === 'del' ? line.oldNo : line.newNo}`
      b.onclick = () => opts.onComment!(file, line, row)
      add.append(b)
    }
    const code = h('span', 'dr-code')
    if (line.text.length <= COLOR_CAP) code.innerHTML = liteColor(line.text, file.path) || ' '
    else code.textContent = line.text
    row.append(h('span', 'dr-no', line.oldNo === null ? '' : String(line.oldNo)), h('span', 'dr-no', line.newNo === null ? '' : String(line.newNo)), add, code)
    return row
  }

  const draw = (n: number) => {
    limit += n
    while (f < files.length && drawn < limit) {
      if (!bodies[f]) startFile(files[f])
      const file = files[f], body = bodies[f]
      if (!file.hunks.length) {
        body.append(h('p', 'dr-note-line', file.binary ? 'Binary file, or its contents are hidden.' : 'No line changes to show.'))
        drawn++, f++, k = l = 0
        continue
      }
      const hunk = file.hunks[k]
      if (!hunk) { f++, (k = l = 0); continue }
      if (l === 0) body.append(h('div', 'dr-hunk', hunk.header))
      const line = hunk.lines[l]
      if (line) { body.append(rowOf(file, line)); drawn++, l++ }
      if (l >= hunk.lines.length) { k++, (l = 0) }
    }
    more.hidden = f >= files.length
    more.textContent = `Show more (${Math.max(0, total - drawn).toLocaleString()} lines left)`
  }
  more.onclick = () => draw(LINE_CAP)
  host.append(more)
  draw(LINE_CAP)
  return { collapseAll: (on) => blocks.forEach((b) => { b.classList.toggle('collapsed', on); b.firstElementChild?.setAttribute('aria-expanded', String(!on)) }) }
}

type Item = ReviewComment & { note: HTMLElement }

export async function openDiffReview(o: { runId: string; taskId?: string; diff?: string }) {
  const d = h('dialog', 'diff-review') as HTMLDialogElement
  d.setAttribute('aria-label', 'Review the changes')
  const title = h('strong', '', 'Review the changes')
  const summary = h('span', 'dr-summary')
  const collapse = h('button', 'btn dr-collapse', 'Collapse all') as HTMLButtonElement
  collapse.type = 'button'
  collapse.hidden = true
  const x = h('button', 'icon-btn sm') as HTMLButtonElement
  x.type = 'button'
  x.title = x.ariaLabel = 'Close'
  x.append(icon('x', 'sm'))
  const head = h('div', 'dr-head')
  head.append(title, summary, collapse, x)
  const main = h('div', 'dr-main')
  const host = h('div', 'dr-host')
  host.append(h('p', 'dr-empty', 'Loading the changes…'))
  main.append(host)
  const foot = h('div', 'dr-foot')
  d.append(head, main, foot)

  const items: Item[] = []
  let view: DiffView | null = null
  let sending = false
  let error = ''

  const discard = () => !items.length || window.confirm(`Close without sending? ${items.length === 1 ? 'Your comment is' : `Your ${items.length} comments are`} not saved.`)
  const tryClose = () => { if (discard()) d.close() }
  x.onclick = tryClose
  d.addEventListener('cancel', (e) => { if (!discard()) e.preventDefault() })
  d.addEventListener('click', (e) => { if (e.target === d) tryClose() })
  d.addEventListener('close', () => d.remove())

  const send = async () => {
    if (!items.length || sending) return
    sending = true, (error = '')
    paintFoot()
    try {
      const { text, sent } = commentsToMessage(items)
      await window.forge.teamFollow(o.runId, text)
      items.splice(0, sent).forEach((i) => i.note.remove())
      if (items.length) toast(`Sent ${sent} comments. The rest did not fit in one message: send them now.`, 4000)
      else {
        toast(`Sent ${sent} ${sent === 1 ? 'comment' : 'comments'} to the crew`)
        d.close()
        return
      }
    } catch (e) {
      error = cleanErr(e)
    } finally {
      sending = false
    }
    paintFoot()
  }

  function paintFoot() {
    foot.replaceChildren()
    if (!items.length) {
      foot.append(h('span', 'dr-hint', 'Click + next to a line to leave a comment for the crew.'))
      return
    }
    const list = h('ul', 'dr-list')
    for (const c of items) {
      const li = h('li', 'dr-item')
      const where = h('button', 'dr-where', `${c.path}:${c.line}`) as HTMLButtonElement
      where.type = 'button'
      where.title = `Go to the ${c.side} side of line ${c.line}`
      where.onclick = () => c.note.scrollIntoView({ block: 'center' })
      const rm = h('button', 'icon-btn xs') as HTMLButtonElement
      rm.type = 'button'
      rm.title = rm.ariaLabel = 'Remove this comment'
      rm.append(icon('x', 'sm'))
      rm.onclick = () => { items.splice(items.indexOf(c), 1); c.note.remove(); paintFoot() }
      li.append(where, h('span', 'dr-text', c.text), rm)
      list.append(li)
    }
    const bar = h('div', 'dr-bar')
    const go = h('button', 'btn primary', sending ? 'Sending…' : `Send ${items.length} ${items.length === 1 ? 'comment' : 'comments'} to the crew`) as HTMLButtonElement
    go.type = 'button'
    go.disabled = sending
    go.onclick = () => void send()
    const err = h('span', 'dr-error', error)
    err.setAttribute('role', 'alert')
    bar.append(err, h('kbd', '', 'Ctrl Enter'), go)
    foot.append(list, bar)
  }

  const addComment = (file: DiffFile, line: DiffLine, row: HTMLElement) => {
    const side = line.kind === 'del' ? 'old' : 'new'
    const no = (side === 'old' ? line.oldNo : line.newNo) ?? 0
    const box = h('div', 'dr-box')
    const area = h('textarea') as HTMLTextAreaElement
    area.rows = 2
    area.placeholder = 'What should change here?'
    area.ariaLabel = `Comment on ${file.path} line ${no}`
    const save = h('button', 'btn primary', 'Add comment') as HTMLButtonElement
    const cancel = h('button', 'btn', 'Cancel') as HTMLButtonElement
    save.type = cancel.type = 'button'
    const actions = h('div', 'dr-box-actions')
    actions.append(h('kbd', '', 'Ctrl Enter'), cancel, save)
    box.append(area, actions)
    const add = () => {
      const text = area.value.trim()
      if (!text) return area.focus()
      const note = h('div', 'dr-note')
      note.append(h('span', '', text))
      const item: Item = { path: file.path, line: no, side, text, code: line.text, note }
      items.push(item)
      box.replaceWith(note)
      paintFoot()
    }
    save.onclick = add
    cancel.onclick = () => box.remove()
    area.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); box.remove() }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); add() }
    }
    row.after(box)
    area.focus()
  }

  d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && items.length) { e.preventDefault(); void send() } })
  collapse.onclick = () => {
    const on = collapse.textContent === 'Collapse all'
    view?.collapseAll(on)
    collapse.textContent = on ? 'Expand all' : 'Collapse all'
  }

  document.body.append(d)
  d.showModal()
  paintFoot()
  try {
    const text = o.diff ?? (await window.forge.teamDiff(o.runId, o.taskId))
    const files = parseUnifiedDiff(text)
    if (!files.length) {
      host.replaceChildren(h('p', 'dr-empty', text.trim() || 'No changes are available yet.'))
      return
    }
    summary.textContent = `${files.length} ${files.length === 1 ? 'file' : 'files'} · +${files.reduce((n, f) => n + f.added, 0)} −${files.reduce((n, f) => n + f.removed, 0)}`
    collapse.hidden = false
    view = mountDiffView(host, files, { onComment: addComment })
  } catch (e) {
    host.replaceChildren(h('div', 'errcard', cleanErr(e)))
  }
}
