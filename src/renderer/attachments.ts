// One attachment strip for every composer: a paperclip button, paste, drag and drop, and a row of chips that upload as soon as a file is added.
// The caller says where a file goes (Crew stores it and hands back a path, Solo stores it per chat and hands back an id).
import { icon } from './icons'
import { cleanErr, copy, h } from './ui'

export type Kind = 'image' | 'video' | 'file' | 'text'
export type Uploaded = { id: string; name?: string; size?: number; path?: string; kind?: Kind; frames?: string[] }
export type Item = { key: number; file: File; kind: Kind; state: 'uploading' | 'ready' | 'error'; progress: number; error?: string; detail?: string; result?: Uploaded; url?: string }
export type Options = {
  host: HTMLElement // the whole card: files dropped anywhere on it are attached
  textarea: HTMLTextAreaElement // pictures and files pasted here are attached
  max: number
  maxBytes: number
  limits: string // shown under the chips, e.g. "Up to 12 files per run, 200 MB each."
  note?: string // one muted line under the chips
  upload: (file: File, progress: (fraction: number) => void) => Promise<Uploaded>
  explain?: (e: unknown, file: File) => string // turns a refusal into words for the chip
  warn?: (item: Item) => string // a muted warning on a ready chip, or ''
  onChange?: () => void
}

const VIDEO = /\.(mp4|mov|webm|mkv|avi|m4v)$/i
const PICTURE = /\.(png|jpe?g|gif|webp|bmp|heic)$/i
export const kindOf = (f: File): Kind => (f.type.startsWith('image/') || PICTURE.test(f.name) ? 'image' : f.type.startsWith('video/') || VIDEO.test(f.name) ? 'video' : 'file')
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`)

// A pasted screenshot arrives as "image.png": give it the time it was taken.
export function nameFor(f: File, now = new Date()): File {
  if (f.name && !/^image\.\w+$/i.test(f.name)) return f
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^\w]/g, '')
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('-')
  return new File([f], `screenshot-${t}.${ext}`, { type: f.type, lastModified: f.lastModified })
}

// Base64 without building it in script: the browser encodes off the main thread and reports progress as it reads.
export function readBase64(file: Blob, progress: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onprogress = (e) => { if (e.lengthComputable) progress(e.loaded / e.total) }
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => reject(r.error ?? new Error(`Could not read ${(file as File).name ?? 'the file'}.`))
    r.readAsDataURL(file)
  })
}

const PART = 8 * 1024 * 1024
const BIG = 24 * 1024 * 1024

// A Crew file goes in one call, or, over 24 MB, in 8 MB parts (a phone cannot send a 200 MB request). Parts keep the progress honest.
export async function uploadCrewFile(file: File, progress: (fraction: number) => void): Promise<Uploaded> {
  if (file.size <= BIG) {
    const data = await readBase64(file, progress); progress(1)
    const [a] = await window.forge.teamAttach([{ name: file.name, data }])
    if (!a) throw new Error(`Forge did not keep ${file.name}.`)
    return a
  }
  const total = Math.ceil(file.size / PART)
  const uploadId = (crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, '')
  let a: Uploaded | undefined
  for (let index = 0; index < total; index++) {
    const data = await readBase64(file.slice(index * PART, (index + 1) * PART), () => {})
    ;[a] = await window.forge.teamAttachPart({ uploadId, index, total, name: file.name, data })
    progress((index + 1) / total)
  }
  if (!a) throw new Error(`Forge did not keep ${file.name}.`)
  return a
}

export function attachmentStrip(o: Options) {
  let items: Item[] = []
  let seq = 0
  let notice = ''
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.hidden = true
  input.setAttribute('aria-hidden', 'true')
  input.tabIndex = -1
  const button = h('button', 'icon-btn att-btn') as HTMLButtonElement
  button.type = 'button'
  button.append(icon('clip'))
  button.title = `Attach photos, videos or files. ${o.limits} You can also paste or drop them here.`
  button.setAttribute('aria-label', 'Attach photos, videos or files')
  button.onclick = () => input.click()
  input.onchange = () => { add([...(input.files ?? [])]); input.value = '' }

  const strip = h('div', 'att-strip')
  strip.setAttribute('aria-live', 'polite')
  const overlay = h('div', 'att-drop', 'Drop to attach')
  overlay.setAttribute('aria-hidden', 'true')
  o.host.classList.add('att-host')
  o.host.append(overlay)

  const changed = () => { draw(); o.onChange?.() }

  function add(files: File[]) {
    notice = ''
    for (const raw of files) {
      if (items.length >= o.max) { notice = `Only ${o.max} files can be attached. ${files.length > 1 ? 'The rest were left out.' : ''}`.trim(); break }
      const file = nameFor(raw)
      const item: Item = { key: ++seq, file, kind: kindOf(file), state: 'uploading', progress: 0 }
      if (item.kind === 'image') item.url = URL.createObjectURL(file)
      items.push(item)
      if (file.size > o.maxBytes) { item.state = 'error'; item.error = `Too big: up to ${fmtSize(o.maxBytes)} each.`; continue }
      void o.upload(file, (p) => { if (item.state === 'uploading') { item.progress = p; paint(item) } }).then(
        (res) => { item.state = 'ready'; item.result = res; if (res.kind) item.kind = res.kind; if (items.includes(item)) changed() },
        (e) => { item.state = 'error'; item.error = o.explain ? o.explain(e, file) : cleanErr(e); item.detail = cleanErr(e); if (items.includes(item)) changed() },
      )
    }
    changed()
  }

  function remove(item: Item) {
    items = items.filter((x) => x !== item)
    if (item.url) URL.revokeObjectURL(item.url)
    notice = ''
    changed()
  }

  // Chips are redrawn as a whole; only the progress text is touched while a file uploads.
  const bars = new Map<number, HTMLElement>()
  const paint = (item: Item) => { const el = bars.get(item.key); if (el) el.textContent = item.progress < 1 ? `Uploading ${Math.round(item.progress * 100)}%` : 'Saving…' }
  const drawn = new Set<number>() // a chip rises in (.enter, motion.css) the first time it is drawn, not on every redraw
  function chip(item: Item) {
    const c = h('div', `att-chip ${item.kind} ${item.state}`)
    if (!drawn.has(item.key)) { drawn.add(item.key); c.classList.add('enter') }
    const path = item.result?.path
    c.title = path ?? item.detail ?? item.file.name
    const thumb = h('span', 'att-thumb')
    if (item.url) { const img = document.createElement('img'); img.src = item.url; img.alt = ''; thumb.append(img) } else thumb.append(icon(item.kind === 'video' ? 'film' : 'file', 'sm'))
    const text = h('span', 'att-text')
    const sub = h('span', 'att-sub')
    text.append(h('strong', '', item.file.name), sub)
    if (item.state === 'uploading') { sub.classList.add('busy'); bars.set(item.key, sub); paint(item) }
    else if (item.state === 'error') { sub.classList.add('bad'); sub.textContent = item.error ?? 'Could not attach.' }
    else {
      const bits = [fmtSize(item.file.size)]
      if (item.kind === 'video' && item.result) bits.push(item.result.frames?.length ? `${item.result.frames.length} frames extracted` : 'No frames (ffmpeg missing or video unreadable)')
      sub.textContent = bits.join(' · ')
      const w = o.warn?.(item)
      if (w) text.append(h('span', 'att-warn', w))
    }
    c.append(thumb, text)
    if (path) {
      const cp = h('button', 'att-act', 'Copy path') as HTMLButtonElement
      cp.type = 'button'
      cp.title = path
      cp.onclick = () => void copy(path, 'Path copied')
      c.append(cp)
    }
    const x = h('button', 'att-x') as HTMLButtonElement
    x.type = 'button'
    x.append(icon('x', 'sm'))
    x.title = `Remove ${item.file.name}`
    x.setAttribute('aria-label', `Remove ${item.file.name}`)
    x.onclick = () => remove(item)
    c.append(x)
    return c
  }

  function draw() {
    bars.clear()
    const chips = h('div', 'att-chips')
    chips.append(...items.map(chip))
    const foot = h('div', 'att-note')
    if (notice) foot.append(h('span', 'bad', notice + ' '))
    foot.append(document.createTextNode([o.note, o.limits].filter(Boolean).join(' ')))
    strip.replaceChildren(...(items.length ? [chips, foot] : notice ? [foot] : []))
    strip.hidden = !items.length && !notice
  }

  // Paste: pictures from a screenshot tool, files copied in a file manager. Text pastes as usual.
  o.textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (!files.length) return
    if (!e.clipboardData?.getData('text/plain')) e.preventDefault()
    add(files)
  })
  // Drop anywhere on the card. The counter keeps the overlay steady while the pointer crosses child elements.
  let depth = 0
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
  o.host.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; o.host.classList.add('dropping') })
  o.host.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = 'copy' })
  o.host.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; o.host.classList.remove('dropping') } })
  o.host.addEventListener('drop', (e) => {
    depth = 0
    o.host.classList.remove('dropping')
    if (!hasFiles(e)) return
    e.preventDefault()
    add([...e.dataTransfer!.files])
  })

  draw()
  return {
    button,
    input,
    strip,
    add,
    items: () => items,
    ready: () => items.filter((x) => x.state === 'ready' && x.result).map((x) => x.result!),
    busy: () => items.some((x) => x.state === 'uploading'),
    redraw: draw,
    clear() { for (const x of items) if (x.url) URL.revokeObjectURL(x.url); items = []; notice = ''; changed() },
  }
}

// Small read-only chips for files already sent with a run or a message.
export function sentChips(list: { name: string; path?: string; kind: Kind; frames?: string[]; preview?: () => Promise<string | null> }[]) {
  const row = h('div', 'att-chips sent')
  for (const a of list) {
    const c = h('div', `att-chip ${a.kind} ready small`)
    c.title = a.path ?? a.name
    const thumb = h('span', 'att-thumb')
    thumb.append(icon(a.kind === 'video' ? 'film' : 'file', 'sm'))
    if (a.preview) void a.preview().then((src) => { if (!src) return; const img = document.createElement('img'); img.src = src; img.alt = a.name; thumb.replaceChildren(img) }).catch(() => {})
    const text = h('span', 'att-text')
    text.append(h('strong', '', a.name))
    if (a.kind === 'video') text.append(h('span', 'att-sub', a.frames?.length ? `${a.frames.length} frames` : 'No frames'))
    c.append(thumb, text)
    if (a.path) { const cp = h('button', 'att-act', 'Copy path') as HTMLButtonElement; cp.type = 'button'; cp.title = a.path; cp.onclick = (e) => { e.stopPropagation(); void copy(a.path!, 'Path copied') }; c.append(cp) }
    row.append(c)
  }
  return row
}
