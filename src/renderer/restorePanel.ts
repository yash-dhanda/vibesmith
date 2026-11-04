import type { RestorePoint } from '../main/restorePoints'
import { parseUnifiedDiff } from './diffParse'
import { mountDiffView } from './diffReview'
import { folderName, timeAgo } from './format'
import { icon } from './icons'
import { cleanErr, h, toast } from './ui'

// Restore points: the snapshots Forge took before Solo runs, Crew landings and restores. Pick one, see what changed since, put files back.

type Detail = Awaited<ReturnType<typeof window.forge.restoreDiff>>
const STATUS_WORD = { modified: 'edited since', added: 'created since', deleted: 'deleted since' } as const
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export async function openRestorePoints(project: string) {
  const d = h('dialog', 'restore-points') as HTMLDialogElement
  d.setAttribute('aria-label', 'Restore points')
  const x = h('button', 'icon-btn sm') as HTMLButtonElement
  x.type = 'button'
  x.title = x.ariaLabel = 'Close'
  x.append(icon('x', 'sm'))
  x.onclick = () => d.close()
  const head = h('div', 'rp-head')
  head.append(icon('undo', 'sm'), h('strong', '', 'Restore points'), h('span', 'rp-sub', folderName(project)), x)
  const list = h('div', 'rp-list')
  const detail = h('div', 'rp-detail')
  const body = h('div', 'rp-body')
  body.append(list, detail)
  d.append(head, body)
  d.addEventListener('click', (e) => { if (e.target === d) d.close() })
  d.addEventListener('close', () => d.remove())

  let points: RestorePoint[] = []
  let selected = ''
  let seq = 0
  let busy = false

  const loadList = async () => {
    try {
      points = await window.forge.restoreList(project)
    } catch (e) {
      list.replaceChildren(h('p', 'rp-empty', cleanErr(e)))
      return
    }
    paintList()
  }

  function paintList() {
    if (!points.length) {
      list.replaceChildren(h('p', 'rp-empty', 'No restore points yet. Forge saves one before each Solo run and each Crew landing in this folder.'))
      detail.replaceChildren()
      return
    }
    list.replaceChildren(...points.map((p) => {
      const b = h('button', 'rp-point' + (p.id === selected ? ' selected' : '')) as HTMLButtonElement
      b.type = 'button'
      b.ariaPressed = String(p.id === selected)
      b.title = new Date(p.at).toLocaleString()
      b.append(h('strong', '', p.label), h('span', 'rp-when', timeAgo(p.at)), h('span', 'rp-delta', p.filesChanged ? `${plural(p.filesChanged, 'file')} differ · +${p.additions} −${p.deletions}` : 'Same as now'))
      b.onclick = () => void select(p.id)
      return b
    }))
  }

  async function select(id: string) {
    selected = id
    const mine = ++seq
    paintList()
    detail.replaceChildren(h('p', 'rp-empty', 'Reading the changes…'))
    let data: Detail
    try {
      data = await window.forge.restoreDiff(project, id)
    } catch (e) {
      if (mine === seq) detail.replaceChildren(h('div', 'errcard', cleanErr(e)))
      return
    }
    if (mine === seq) paintDetail(points.find((p) => p.id === id)!, data)
  }

  function paintDetail(point: RestorePoint, data: Detail) {
    const when = timeAgo(point.at)
    if (!data.files.length) {
      detail.replaceChildren(h('p', 'rp-empty', 'Your project matches this restore point. Nothing to restore.'))
      return
    }
    // Files created since the point stay unticked: putting the point back would delete them.
    const checked = new Set(data.files.filter((f) => f.status !== 'added').map((f) => f.path))
    const files = h('div', 'rp-files')
    const boxes = new Map<string, HTMLInputElement>()
    for (const f of data.files) {
      const row = h('label', 'rp-file')
      const box = h('input') as HTMLInputElement
      box.type = 'checkbox'
      box.checked = checked.has(f.path)
      box.onchange = () => { box.checked ? checked.add(f.path) : checked.delete(f.path); sync() }
      boxes.set(f.path, box)
      row.append(box, h('span', 'rp-path', f.path), h('span', 'dr-chip ' + f.status, STATUS_WORD[f.status]), h('span', 'dr-count', `+${f.added} −${f.removed}`))
      files.append(row)
    }
    const all = h('button', 'btn rp-toggle', 'Select all') as HTMLButtonElement
    all.type = 'button'
    all.onclick = () => {
      const on = checked.size < data.files.length
      for (const [p, box] of boxes) (box.checked = on) ? checked.add(p) : checked.delete(p)
      sync()
    }
    const top = h('div', 'rp-detail-head')
    top.append(h('strong', '', `${point.label} · ${when}`), h('span', 'rp-sub', plural(data.files.length, 'file') + ' differ'), all)
    const diffHost = h('div', 'rp-diff')
    mountDiffView(diffHost, parseUnifiedDiff(data.diff))
    if (data.truncated) diffHost.append(h('p', 'rp-note', 'The diff is cut short because it is very large. All files are still listed above.'))

    const actions = h('div', 'rp-actions')
    const confirm = h('div', 'rp-confirm')
    confirm.hidden = true
    confirm.setAttribute('role', 'alert')
    const some = h('button', 'btn primary', 'Restore selected files') as HTMLButtonElement
    const everything = h('button', 'btn', 'Restore everything') as HTMLButtonElement
    some.type = everything.type = 'button'
    actions.append(everything, some)
    function sync() {
      some.disabled = busy || !checked.size
      everything.disabled = busy
      all.textContent = checked.size < data.files.length ? 'Select all' : 'Select none'
      confirm.hidden = true
    }
    const ask = (question: string, run: () => Promise<void>) => {
      const ok = h('button', 'btn primary', 'Restore') as HTMLButtonElement
      const no = h('button', 'btn', 'Cancel') as HTMLButtonElement
      ok.type = no.type = 'button'
      no.onclick = () => (confirm.hidden = true)
      ok.onclick = async () => {
        busy = true
        sync()
        confirm.hidden = false
        confirm.replaceChildren(h('span', '', 'Restoring…'))
        try {
          await run()
        } catch (e) {
          toast(cleanErr(e), 5000)
        }
        busy = false
        void loadList().then(() => select(point.id))
      }
      confirm.replaceChildren(h('span', '', `${question} Forge saves a new restore point of the project as it is now first, so this can be undone.`), no, ok)
      confirm.hidden = false
      ok.focus()
    }
    const done = (r: { restored: string[]; checkpoint: string | null }) => toast(r.checkpoint ? `Restored ${plural(r.restored.length, 'file')}. The previous state is saved as a restore point.` : 'Nothing to restore.', 4000)
    some.onclick = () => ask(`Restore ${plural(checked.size, 'file')} from ${when}?${data.files.some((f) => f.status === 'added' && checked.has(f.path)) ? ' Ticked files that were created since will be deleted.' : ''}`, async () => done(await window.forge.restoreApply(project, point.id, [...checked])))
    everything.onclick = () => ask(`Restore every edited or deleted file from ${when}? Files created since then are kept.`, async () => done(await window.forge.restoreApply(project, point.id)))
    sync()
    detail.replaceChildren(top, files, diffHost, confirm, actions)
  }

  document.body.append(d)
  d.showModal()
  list.replaceChildren(h('p', 'rp-empty', 'Loading…'))
  await loadList()
  if (points[0]) void select(points[0].id)
}
