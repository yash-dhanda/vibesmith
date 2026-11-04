import { icon } from './icons'
import { cleanErr, h, seg, toast } from './ui'

// The run's website beside the work: a collapsible panel whose placeholder box is covered by a native view (the same
// sandboxed view Solo's preview uses, keyed `crew:<runId>` in the main process). Run website / Stop use the run's AppRunners,
// so it shows the crew's unapplied copy. The view follows the box: moved when it moves, hidden when a dialog is open, the
// screen is hidden or the box is scrolled out, and removed when the panel collapses or the run changes.

type Phase = 'idle' | 'starting' | 'running' | 'failed' | 'stopped'
type Box = { x: number; y: number; width: number; height: number }
type Status = { chatId: string; state: 'loading' | 'ready' | 'error' | 'closed'; url: string; title: string; error?: string }
type Instance = { runId: string; el: HTMLElement; destroy: () => void; status: (s: Status) => void }

const OPEN_KEY = 'forge.crewPreview'
const isRemote = () => (window as { __forgeRemote?: boolean }).__forgeRemote === true
let current: Instance | null = null // the run screen redraws itself often: the same panel (and its state) is handed back for the same run
let listening = false

const pill = (text: string, title: string) => { const b = h('button', 'btn', text) as HTMLButtonElement; b.type = 'button'; b.title = title; return b }

export function renderCrewPreview(runId: string): HTMLElement {
  if (isRemote() || typeof window.forge.teamRunApp !== 'function' || typeof window.forge.previewCrewAttach !== 'function') return Object.assign(h('div'), { hidden: true })
  if (!listening && typeof window.forge.onPreviewStatus === 'function') { listening = true; window.forge.onPreviewStatus((s) => current?.status(s)) }
  if (current?.runId === runId) return current.el
  current?.destroy()
  return (current = build(runId)).el
}

function build(runId: string): Instance {
  const key = `crew:${runId}`
  let open = sessionStorage.getItem(OPEN_KEY) === 'open'
  let phase: Phase = 'idle', url = '', note = ''
  let attached = false, shown = true, epoch = 0, gone = 0, lastBox = ''

  const el = h('section', 'crew-preview')
  el.setAttribute('aria-label', 'Website preview')
  const head = h('button', 'crew-preview-head') as HTMLButtonElement
  head.type = 'button'
  const sum = h('span', 'crew-preview-sum')
  head.append(icon('chevron', 'sm'), h('strong', '', 'Preview'), sum)
  const body = h('div', 'crew-preview-body')
  const run = pill('Run website', 'Start the crew\'s copy of the website here')
  const stop = pill('Stop', 'Stop the website')
  const reload = pill('Reload', 'Load the page again')
  const ext = pill('Open in browser', 'Open the page in your browser')
  const urlText = h('span', 'crew-preview-url')
  const box = h('div', 'crew-preview-box')
  const msg = h('p', 'crew-preview-msg')
  box.append(msg)
  const width = seg<'desktop' | 'phone'>([['desktop', 'Desktop'], ['phone', 'Phone']], 'desktop', (v) => { box.classList.toggle('phone', v === 'phone'); sync() })
  width.setAttribute('aria-label', 'Preview width')
  const bar = h('div', 'crew-preview-bar')
  bar.append(run, stop, urlText, reload, ext, width)
  const stage = h('div', 'crew-preview-stage')
  stage.append(box)
  body.append(bar, stage)
  el.append(head, body)

  // The box in window coordinates, cut to the scrolling run page so the view never spills over the header; null when nothing of it shows.
  const rect = (): Box | null => {
    if (!el.isConnected) return null
    const r = box.getBoundingClientRect()
    const c = (box.closest('#team-root') ?? document.body).getBoundingClientRect()
    const x = Math.max(r.left, c.left), y = Math.max(r.top, c.top)
    const w = Math.min(r.right, c.right) - x, ht = Math.min(r.bottom, c.bottom) - y
    return w >= 2 && ht >= 2 ? { x, y, width: w, height: ht } : null
  }

  function sync() {
    if (!attached) return
    gone = el.isConnected ? 0 : gone + 1
    if (gone > 12) return destroy() // about three seconds off screen: the user left this run
    const b = rect()
    const visible = !!b && !document.querySelector('dialog[open]') // menus and dialogs are drawn by the page, which a native view would cover
    if (visible !== shown) { shown = visible; window.forge.previewVisible(key, visible) }
    const same = b && [b.x, b.y, b.width, b.height].map(Math.round).join()
    if (b && same !== lastBox) { lastBox = same!; window.forge.previewCrewBounds(runId, b) }
  }

  const detach = () => { if (attached) { attached = false; window.forge.previewDetach(key) } }

  async function show() {
    if (!open || phase !== 'running') return
    try {
      await window.forge.previewCrewAttach(runId, url, rect() ?? { x: 0, y: 0, width: 1, height: 1 })
      attached = true; shown = true; lastBox = ''
      sync()
    } catch (e) { phase = 'failed'; note = cleanErr(e); paint() }
  }

  function paint() {
    el.classList.toggle('open', open)
    body.hidden = !open
    head.setAttribute('aria-expanded', String(open))
    const going = phase === 'starting' || phase === 'running'
    sum.textContent = { idle: 'Not started', starting: 'Starting…', running: url, failed: 'Could not start', stopped: 'Stopped' }[phase]
    run.hidden = going
    stop.hidden = !going
    reload.hidden = ext.hidden = phase !== 'running'
    urlText.textContent = phase === 'running' ? url : ''
    msg.hidden = phase === 'running'
    msg.textContent = { idle: note || 'Press Run website to see the crew\'s work here. This is the crew\'s copy, not your project, until you apply it.', starting: 'Starting the website. The first start can take a minute.', running: '', failed: note, stopped: 'The website was stopped.' }[phase]
    msg.setAttribute('role', phase === 'failed' ? 'alert' : 'status')
  }

  async function start() {
    const mine = ++epoch
    phase = 'starting'; note = ''; paint()
    try {
      const r = await window.forge.teamRunApp(runId)
      if (mine !== epoch) return // stopped or restarted while it was starting
      if (r.ok && r.url) { phase = 'running'; url = r.url; paint(); await show() }
      else { phase = r.ok ? 'idle' : 'failed'; note = r.message; paint() } // ok without a url: a plain page, or no port yet; the message says which
    } catch (e) {
      if (mine !== epoch) return
      phase = 'failed'; note = cleanErr(e); paint()
    }
  }

  head.onclick = () => {
    open = !open
    sessionStorage.setItem(OPEN_KEY, open ? 'open' : 'closed')
    paint()
    if (open) void show(); else detach()
  }
  run.onclick = () => void start()
  stop.onclick = async () => {
    epoch++; detach()
    try { await window.forge.teamStopApp(runId) } catch (e) { toast(cleanErr(e), 4000) }
    phase = 'stopped'; url = ''; paint()
  }
  reload.onclick = () => window.forge.previewReload(key)
  ext.onclick = () => void window.forge.openExternal(url).catch((e) => toast(cleanErr(e), 4000))

  const ro = new ResizeObserver(sync)
  ro.observe(box)
  const timer = setInterval(sync, 250) // catches dialogs opening, the screen hiding and layout moves no observer reports
  const onMove = () => sync()
  window.addEventListener('resize', onMove)
  document.addEventListener('scroll', onMove, true)

  function destroy() {
    epoch++
    clearInterval(timer); ro.disconnect()
    window.removeEventListener('resize', onMove); document.removeEventListener('scroll', onMove, true)
    detach()
    if (current?.runId === runId) current = null
  }

  paint()
  return {
    runId, el, destroy,
    status: (s) => {
      if (s.chatId !== key || s.state !== 'error' || phase !== 'running') return
      detach(); phase = 'failed'; note = `The page did not load${s.error ? ` (${s.error})` : ''}. Press Run website to try again.`; paint()
    },
  }
}

// "Check pages": screenshots of the run's pages at desktop and phone size, shown as a small grid. The same files go to the final reviewer.
export function visualCheckButton(runId: string, routes?: string[]): HTMLElement {
  const wrap = h('div', 'visual-check')
  if (isRemote() || typeof window.forge.teamVisualCheck !== 'function') return Object.assign(wrap, { hidden: true })
  const button = h('button', 'btn', 'Check pages') as HTMLButtonElement
  button.type = 'button'
  button.title = 'Take screenshots of the website at desktop and phone size'
  const note = h('p', 'visual-note')
  const grid = h('div', 'visual-grid')
  button.onclick = async () => {
    button.disabled = true; button.textContent = 'Checking…'; note.textContent = 'Starting the website and taking screenshots. This can take a minute.'; grid.replaceChildren()
    try {
      const r = await window.forge.teamVisualCheck(runId, routes)
      for (const s of r.shots) {
        const fig = h('figure', 'visual-shot')
        const img = h('img') as HTMLImageElement
        img.src = s.thumb; img.alt = `${s.route} at ${s.size} size`; img.title = s.path
        fig.append(img, h('figcaption', '', `${s.route} · ${s.size === 'phone' ? 'Phone' : 'Desktop'}`))
        grid.append(fig)
      }
      note.textContent = r.failures.length ? `${r.failures.length} could not be captured: ${r.failures.map((f) => `${f.route} (${f.size}): ${f.error}`).join('; ')}` : r.shots.length ? '' : 'Nothing was captured.'
    } catch (e) {
      note.textContent = cleanErr(e)
    } finally { button.disabled = false; button.textContent = 'Check pages' }
  }
  wrap.append(button, note, grid)
  return wrap
}
