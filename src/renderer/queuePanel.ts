import type { QueueItem, QueueStatus } from '../main/team/queue'
import type { ProjectHit } from '../main/projectScan'
import { folderName, md, timeAgo } from './format'
import { icon } from './icons'
import { cleanErr, copy, h, onOff, seg, toast } from './ui'

const LABEL: Record<QueueStatus, string> = { waiting: 'Waiting', running: 'Running', landed: 'Landed', ready: 'Needs you', failed: 'Failed', skipped: 'Not applied' }
let dlg: HTMLDialogElement | null = null
let listening = false
let current: (() => void) | null = null // the open dialog's redraw

// The overnight queue: goals that run one after another, a form to add more, and the morning report.
export async function openQueue() {
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'crew-queue'; dlg.setAttribute('aria-label', 'Overnight queue'); document.body.append(dlg) }
  const d = dlg
  let items: QueueItem[] = []
  let active = false
  let view: 'queue' | 'report' = 'queue'
  let projects: ProjectHit[] = []
  let autoLand = false
  let keepGoing = false
  let goalDraft = ''
  let projectDraft = ''

  const head = h('div', 'modal-head')
  const title = h('h3', '', 'Overnight queue')
  title.prepend(icon('list'))
  const close = h('button', 'icon-btn')
  close.append(icon('x'))
  close.title = 'Close (Esc)'
  close.setAttribute('aria-label', 'Close')
  close.onclick = () => d.close()
  const body = h('div', 'queue-body')
  const foot = h('div', 'modal-foot')
  const hint = h('span', 'modal-hint')
  const toggle = h('button', 'btn primary') as HTMLButtonElement
  const tabs = seg<'queue' | 'report'>([['queue', 'Queue'], ['report', 'Morning report']], view, (v) => { view = v; void draw() })
  head.append(title, h('span', 'grow'), tabs, close)
  foot.append(hint, h('span', 'grow'), toggle)
  d.replaceChildren(head, body, foot)

  const run = async (f: () => Promise<unknown>) => {
    try { await f() } catch (e) { toast(cleanErr(e), 4000) }
    await refresh()
  }
  const refresh = async () => {
    try { ({ items, active } = await window.forge.queueList()) } catch (e) { body.replaceChildren(h('p', 'errtext', cleanErr(e))); return }
    await draw()
  }

  async function draw() {
    const waiting = items.filter((i) => i.status === 'waiting').length
    toggle.textContent = active ? 'Pause after this goal' : 'Start queue'
    toggle.disabled = !active && !waiting && !items.some((i) => i.status === 'running')
    toggle.onclick = () => void run(() => (active ? window.forge.queuePause() : window.forge.queueStart()))
    hint.textContent = active ? 'Running one goal at a time.' : waiting ? `${waiting} waiting. Nothing runs until you start the queue.` : 'Add a goal to begin.'
    if (view === 'report') {
      const text = await window.forge.queueReport().catch(() => '')
      const bar = h('div', 'queue-report-bar')
      const cp = h('button', 'btn', 'Copy') as HTMLButtonElement
      cp.prepend(icon('copy', 'sm'))
      cp.onclick = () => void copy(text, 'Report copied')
      bar.append(cp)
      const doc = h('div', 'queue-report')
      doc.innerHTML = md(text)
      body.replaceChildren(bar, doc)
      return
    }
    const list = h('div', 'queue-list')
    if (!items.length) {
      const empty = h('div', 'empty-state')
      const mark = h('div', 'empty-glyph')
      mark.append(icon('list'))
      empty.append(mark, h('div', 'empty-title', 'The queue is empty'), h('p', 'empty-copy', 'Add goals below. They run one after another while you are away, and the morning report says what happened.'))
      list.append(empty)
    }
    items.forEach((it, n) => list.append(row(it, n)))
    body.replaceChildren(list, form())
  }

  const row = (it: QueueItem, n: number) => {
    const r = h('div', `queue-item st-${it.status}`)
    const movable = it.status !== 'running'
    r.draggable = movable
    r.dataset.id = it.id
    r.ondragstart = (e) => e.dataTransfer?.setData('text/plain', it.id)
    r.ondragover = (e) => { e.preventDefault(); r.classList.add('drop') }
    r.ondragleave = () => r.classList.remove('drop')
    r.ondrop = (e) => {
      e.preventDefault()
      const from = e.dataTransfer?.getData('text/plain')
      if (from && from !== it.id) void run(() => window.forge.queueMove(from, n))
    }
    const main = h('div', 'queue-main')
    const goal = h('div', 'queue-goal', it.goal.split('\n')[0].slice(0, 160))
    goal.title = it.goal
    const meta = h('div', 'queue-meta', `${folderName(it.project)}${it.autoLand ? ' · lands by itself' : ''}${it.continueOnFail ? ' · continues if it fails' : ''}${it.endedAt ? ` · ${timeAgo(it.endedAt)}` : ''}`)
    main.append(goal, meta)
    if (it.note) main.append(h('div', `queue-note${it.status === 'failed' || it.status === 'ready' ? ' warn' : ''}`, it.note))
    const ctl = h('div', 'queue-ctl')
    const mk = (name: 'arrowup' | 'arrowdown' | 'trash', label: string, off: boolean, f: () => Promise<unknown>) => {
      const b = h('button', 'icon-btn sm') as HTMLButtonElement
      b.type = 'button'
      b.append(icon(name, 'sm'))
      b.title = label
      b.setAttribute('aria-label', label)
      b.disabled = off
      b.onclick = () => void run(f)
      return b
    }
    ctl.append(
      mk('arrowup', 'Move up', !movable || n === 0, () => window.forge.queueMove(it.id, n - 1)),
      mk('arrowdown', 'Move down', !movable || n === items.length - 1, () => window.forge.queueMove(it.id, n + 1)),
      mk('trash', it.status === 'running' ? 'Stop the run before removing it' : 'Remove', !movable, () => window.forge.queueRemove(it.id)),
    )
    r.append(h('span', `queue-status st-${it.status}`, LABEL[it.status]), main, ctl)
    return r
  }

  const form = () => {
    const f = h('form', 'queue-add') as HTMLFormElement
    const goal = document.createElement('textarea')
    goal.rows = 3
    goal.value = goalDraft
    goal.placeholder = 'What should the team build?'
    goal.setAttribute('aria-label', 'Goal')
    goal.oninput = () => (goalDraft = goal.value)
    const where = document.createElement('select')
    where.setAttribute('aria-label', 'Folder')
    where.append(new Option('The folder open now', ''))
    for (const p of projects) where.append(new Option(`${p.name} (${p.path})`, p.path))
    where.value = projectDraft
    where.onchange = () => (projectDraft = where.value)
    const opts = h('div', 'queue-opts')
    const o1 = h('label', 'queue-opt')
    o1.append(h('span', '', 'Land automatically when checks pass'), onOff(autoLand, (v) => (autoLand = v)))
    const o2 = h('label', 'queue-opt')
    o2.append(h('span', '', 'Continue if one fails'), onOff(keepGoing, (v) => (keepGoing = v)))
    opts.append(o1, o2)
    const add = h('button', 'btn', 'Add to queue') as HTMLButtonElement
    add.type = 'submit'
    add.prepend(icon('plus', 'sm'))
    const bar = h('div', 'queue-add-bar')
    bar.append(where, h('span', 'grow'), add)
    f.append(goal, opts, bar)
    f.onsubmit = (e) => {
      e.preventDefault()
      if (!goal.value.trim()) { goal.focus(); return }
      void run(async () => {
        await window.forge.queueAdd({ goal: goal.value, project: where.value || undefined, autoLand, continueOnFail: keepGoing })
        goalDraft = ''
      })
    }
    return f
  }

  // A run changing state redraws the list, but never while the user is typing in the add form.
  current = () => { if (view === 'queue' && !d.querySelector('.queue-add :focus')) void refresh() }
  if (!listening) {
    listening = true
    window.forge.onTeamEvent((ev) => { if (ev.type === 'run' && dlg?.open) current?.() })
  }
  if (!d.open) d.showModal()
  close.focus()
  await refresh()
  if (typeof window.forge.scanProjects === 'function') window.forge.scanProjects().then((p) => { projects = p.slice(0, 60); if (d.open && view === 'queue' && !d.querySelector('.queue-add :focus')) void draw() }, () => {})
}
