import type { Run as TeamRun, TeamLandings } from '../main/team/types'
import { timeAgo } from './format'
import { fileIcon, icon } from './icons'
import { cleanErr, h, toast } from './ui'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// "Land part of this result": the changed files grouped by the task that wrote them, with checkboxes. Landing puts just those files into the
// project; the rest stays waiting for the final Apply or Don't apply. Each landing can be undone on its own.
export function renderLandPanel(run: TeamRun, onDone: () => void): HTMLElement {
  const root = h('section', 'land-panel')
  const body = h('div', 'land-body')
  root.append(body)
  const picked = new Set<string>()
  let data: TeamLandings | null = null
  let busy = false

  const load = async () => {
    try { data = await window.forge.teamLandings(run.id) } catch (e) { body.replaceChildren(h('p', 'errtext', cleanErr(e))); return }
    for (const p of [...picked]) if (data?.files.find((f) => f.path === p)?.state !== 'pending') picked.delete(p)
    draw()
  }

  const land = async (files: string[]) => {
    if (busy || !files.length) return
    busy = true
    draw()
    try {
      const r = await window.forge.teamLandPart(run.id, files)
      toast(r.message, r.ok ? 1800 : 5000)
      if (r.ok) { picked.clear(); onDone() }
    } catch (e) { toast(cleanErr(e), 5000) }
    busy = false
    await load()
  }

  const undo = async (checkpoint: string) => {
    if (busy) return
    busy = true
    draw()
    try {
      const r = await window.forge.teamUndoLanding(run.id, checkpoint)
      toast(r.ok ? `Put back ${plural(r.paths.length, 'file', 'files')}.` : r.message, r.ok ? 1800 : 5000)
      if (r.ok) onDone()
    } catch (e) { toast(cleanErr(e), 5000) }
    busy = false
    await load()
  }

  const draw = () => {
    if (!data) return
    const d = data
    const info = new Map(d.files.map((f) => [f.path, f]))
    const open = d.pending && d.files.some((f) => f.state === 'pending')
    const head = h('div', 'land-head')
    const left = h('div', 'land-title')
    left.append(icon('filter', 'sm'), h('span', '', 'Land part of this result'))
    head.append(left, h('span', 'land-count', `${d.files.filter((f) => f.state === 'landed').length} of ${d.files.length} landed`))
    const groups = h('div', 'land-groups')
    for (const t of d.tasks) {
      const group = h('div', 'land-group')
      const pending = t.files.filter((p) => info.get(p)?.state === 'pending')
      const gh = h('div', 'land-group-head')
      const all = document.createElement('input')
      all.type = 'checkbox'
      all.disabled = !open || busy || !pending.length
      all.checked = pending.length > 0 && pending.every((p) => picked.has(p))
      all.indeterminate = !all.checked && pending.some((p) => picked.has(p))
      all.setAttribute('aria-label', `Select all files from ${t.title}`)
      all.onchange = () => { for (const p of pending) all.checked ? picked.add(p) : picked.delete(p); draw() }
      gh.append(all, h('span', 'land-task', t.title), h('span', 'land-task-n', plural(t.files.length, 'file', 'files')))
      if (open && pending.length) {
        const one = h('button', 'link-btn', 'Land this task') as HTMLButtonElement
        one.type = 'button'
        one.disabled = busy
        one.onclick = () => void land(pending)
        gh.append(h('span', 'grow'), one)
      }
      group.append(gh)
      for (const p of t.files) {
        const f = info.get(p)
        if (!f) continue
        const landed = f.state === 'landed'
        const row = h('label', `land-file${landed ? ' landed' : ''}`)
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.disabled = landed || !open || busy
        box.checked = landed || picked.has(p)
        box.onchange = () => { box.checked ? picked.add(p) : picked.delete(p); draw() }
        const name = h('span', 'land-path', p)
        name.prepend(fileIcon(f.status))
        row.append(box, name, h('span', 'land-add', `+${f.added}`), h('span', 'land-del', `-${f.removed}`), h('span', 'land-state', landed ? 'Landed' : ''))
        group.append(row)
      }
      groups.append(group)
    }
    const foot = h('div', 'land-foot')
    const go = h('button', 'btn primary', picked.size ? `Land selected (${picked.size})` : 'Land selected') as HTMLButtonElement
    go.type = 'button'
    go.disabled = busy || !picked.size
    go.onclick = () => void land([...picked])
    const clear = h('button', 'link-btn', 'Select none') as HTMLButtonElement
    clear.type = 'button'
    clear.hidden = !picked.size
    clear.onclick = () => { picked.clear(); draw() }
    const everything = h('button', 'link-btn', 'Select all') as HTMLButtonElement
    everything.type = 'button'
    everything.onclick = () => { for (const f of d.files) if (f.state === 'pending') picked.add(f.path); draw() }
    foot.append(go, everything, clear)
    const log = h('div', 'land-log')
    for (const l of [...d.landings].reverse()) {
      if (l.undone) continue
      const row = h('div', 'land-log-row')
      row.append(h('span', '', `Landed ${plural(l.files.length, 'file', 'files')} · ${timeAgo(l.at)}`))
      if (l.checkpoint) {
        const u = h('button', 'link-btn', 'Undo') as HTMLButtonElement
        u.type = 'button'
        u.disabled = busy
        u.title = `Put back only these files: ${l.files.slice(0, 6).join(', ')}${l.files.length > 6 ? ', …' : ''}`
        u.prepend(icon('undo', 'sm'))
        u.onclick = () => void undo(l.checkpoint!)
        row.append(u)
      }
      log.append(row)
    }
    body.replaceChildren(head, groups, ...(open ? [foot] : []), ...(log.childElementCount ? [log] : []))
  }

  void load()
  return root
}
