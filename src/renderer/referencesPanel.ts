import type { Reference } from '../main/references'
import { fmtSize, nameFor, readBase64 } from './attachments'
import { folderName } from './format'
import { icon } from './icons'
import { isRemote } from './phone'
import { toolDialog } from './rulesPanel'
import { cleanErr, h, onOff, toast } from './ui'

const MAX_BYTES = 25 * 1024 * 1024

// Pictures, documents and links kept with the project. Add by the paperclip, by pasting or by dropping them anywhere on the dialog.
export async function openReferences(project: string) {
  const { dlg, head, close } = toolDialog('references-panel', 'Reference library', 'clip')
  const body = h('div', 'refs-body')
  const foot = h('div', 'modal-foot')
  const hint = h('span', 'modal-hint', `Kept in .forge/references in ${folderName(project)}, out of git. Up to 100 items, 25 MB each.`)
  foot.append(hint)
  dlg.replaceChildren(head, body, foot)
  if (!dlg.open) dlg.showModal()
  close.focus()

  let items: Reference[] = []
  let auto = false
  const thumbs = new Map<string, string | null>()
  const grid = h('div', 'refs-grid')
  const status = h('p', 'tool-intro faint')
  status.setAttribute('role', 'status')

  // switch: every new Crew run in this project starts with these attached
  const sw = h('div', 'refs-auto')
  const swText = h('div', 'refs-auto-text')
  swText.append(h('strong', '', 'Attach these to every new Crew run in this project'), h('span', '', 'Pictures and files go along with the first message. Links and notes are not files, so they stay here.'))
  const swCtl = h('div', 'refs-auto-ctl')
  sw.append(swText, swCtl)
  const drawSwitch = () => swCtl.replaceChildren(onOff(auto, (v) => { auto = v; window.forge.referencesAuto(v).catch((e) => { auto = !v; drawSwitch(); toast(cleanErr(e), 5000) }) }))

  // add: files (button, paste, drop) and a link with a note
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.hidden = true
  input.onchange = () => { void addFiles([...(input.files ?? [])]); input.value = '' }
  const pick = h('button', 'btn', 'Add pictures or files') as HTMLButtonElement
  pick.type = 'button'
  pick.prepend(icon('clip', 'sm'))
  pick.onclick = () => input.click()
  const drop = h('span', 'refs-drop', 'or paste a screenshot, or drop files here')
  const fileRow = h('div', 'refs-row')
  fileRow.append(pick, drop, input)
  const url = document.createElement('input')
  url.type = 'url'
  url.placeholder = 'https://…'
  url.setAttribute('aria-label', 'Link address')
  const linkNote = document.createElement('input')
  linkNote.type = 'text'
  linkNote.placeholder = 'What is it for? (optional)'
  linkNote.setAttribute('aria-label', 'Note for the link')
  const addLink = h('button', 'btn', 'Add link') as HTMLButtonElement
  addLink.type = 'button'
  addLink.prepend(icon('globe', 'sm'))
  const linkRow = h('div', 'refs-row link')
  linkRow.append(url, linkNote, addLink)
  const doLink = async () => {
    if (!url.value.trim()) return
    addLink.disabled = true
    try { await window.forge.referencesAdd({ url: url.value.trim(), note: linkNote.value }); url.value = linkNote.value = ''; await reload() } catch (e) { toast(cleanErr(e), 5000) } finally { addLink.disabled = false }
  }
  addLink.onclick = () => void doLink()
  url.onkeydown = linkNote.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void doLink() } }

  async function addFiles(files: File[]) {
    let done = 0
    for (const raw of files) {
      const file = nameFor(raw)
      status.textContent = `Adding ${++done} of ${files.length}: ${file.name}`
      if (file.size > MAX_BYTES) { toast(`${file.name} is too big (up to ${fmtSize(MAX_BYTES)}).`, 5000); continue }
      try { await window.forge.referencesAdd({ name: file.name, data: await readBase64(file, () => {}) }) } catch (e) { toast(cleanErr(e), 5000) }
    }
    status.textContent = ''
    await reload()
  }
  dlg.onpaste = (e) => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (!files.length) return
    e.preventDefault()
    void addFiles(files)
  }
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
  dlg.ondragover = (e) => { if (hasFiles(e)) { e.preventDefault(); dlg.classList.add('dropping') } }
  dlg.ondragleave = (e) => { if (e.target === dlg) dlg.classList.remove('dropping') }
  dlg.ondrop = (e) => { dlg.classList.remove('dropping'); if (!hasFiles(e)) return; e.preventDefault(); void addFiles([...e.dataTransfer!.files]) }

  function card(r: Reference) {
    const c = h('div', `ref-card ${r.kind}`)
    const thumb = h('div', 'ref-thumb')
    thumb.append(icon(r.kind === 'link' ? 'globe' : 'file'))
    if (r.kind === 'image') {
      const show = (src: string | null) => { if (!src) return; const img = document.createElement('img'); img.src = src; img.alt = ''; thumb.replaceChildren(img) }
      if (thumbs.has(r.id)) show(thumbs.get(r.id)!)
      else void window.forge.referencesThumb(r.id).then((src) => { thumbs.set(r.id, src); show(src) }).catch(() => {})
    }
    const name = h('strong', 'ref-name', r.kind === 'link' ? (() => { try { return new URL(r.url!).host } catch { return r.name } })() : r.name)
    name.title = r.name
    const sub = r.kind === 'link' ? h('a', 'ref-sub', r.url!) as HTMLAnchorElement : h('span', 'ref-sub', fmtSize(r.size ?? 0))
    if (r.kind === 'link') {
      const a = sub as HTMLAnchorElement
      a.href = r.url!
      a.onclick = (e) => { e.preventDefault(); if (isRemote()) window.open(r.url, '_blank', 'noopener'); else void window.forge.openExternal(r.url!) }
    }
    const note = document.createElement('input')
    note.type = 'text'
    note.className = 'ref-note'
    note.value = r.note
    note.maxLength = 500
    note.placeholder = 'Add a note'
    note.setAttribute('aria-label', `Note for ${r.name}`)
    let saved = r.note
    note.onchange = () => { const v = note.value; window.forge.referencesNote(r.id, v).then(() => { saved = v }, (e) => { note.value = saved; toast(cleanErr(e), 5000) }) }
    const x = h('button', 'att-x') as HTMLButtonElement
    x.type = 'button'
    x.append(icon('x', 'sm'))
    x.title = `Remove ${r.name}`
    x.setAttribute('aria-label', `Remove ${r.name}`)
    x.onclick = () => { thumbs.delete(r.id); window.forge.referencesRemove(r.id).then(reload, (e) => toast(cleanErr(e), 5000)) }
    const meta = h('div', 'ref-meta')
    meta.append(name, sub, note)
    c.append(thumb, meta, x)
    return c
  }

  function draw() {
    if (!items.length) {
      const empty = h('div', 'empty-state')
      const mark = h('div', 'empty-glyph')
      mark.append(icon('clip'))
      empty.append(mark, h('div', 'empty-title', 'No references yet'), h('p', 'empty-copy', 'Keep screenshots, designs and links you want agents to look at. Add some above.'))
      grid.replaceChildren(empty)
    } else grid.replaceChildren(...items.map(card))
  }
  async function reload() {
    try { const s = await window.forge.referencesList(); items = s.items; auto = s.autoAttach; drawSwitch(); draw() } catch (e) { grid.replaceChildren(h('p', 'errtext', cleanErr(e))) }
  }
  body.append(sw, fileRow, linkRow, status, grid)
  drawSwitch()
  await reload()
}
