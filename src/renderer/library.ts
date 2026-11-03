import type { CatalogItem, InstalledModel, PullEvent } from '../preload'
import { icon } from './icons'
import { loadModels } from './models'
import { $, cleanErr, h, toast } from './ui'

// The model library: what is installed, what could be, and the engine that runs them. Like LM Studio, inside the app.
type Tab = 'installed' | 'discover' | 'hf'
let tab: Tab = 'discover'
let welcome = false
const pulling = new Map<string, PullEvent>()
let engineProgress: { phase: string; done: number; total: number; bytesPerSec?: number } | null = null
let hfQuery = ''
let hfResults: { id: string; pullName: string; downloads: number; likes: number }[] | null = null
let hfError = ''

const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`)
const fmtSpeed = (bps: number) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`)
const fmtCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const PHASE = { lookup: 'Finding the latest version…', verify: 'Checking the download…', extract: 'Unpacking…', start: 'Starting the engine…', done: 'Done' } as Record<string, string>

const FIT: Record<CatalogItem['fit'], [string, string]> = {
  gpu: ['Fits your graphics card', 'ok'],
  partial: ['Partly on the GPU, slower', 'accent'],
  cpu: ['CPU only, slow', ''],
  'too-big': ['Too big for this PC', 'bad'],
}

let body: HTMLElement | null = null
let engineBox: HTMLElement | null = null
let hwLine: HTMLElement | null = null
let dlBox: HTMLElement | null = null

const useModel = (name: string) => {
  try {
    localStorage.setItem('forge.model', `ollama:${name}`)
  } catch {}
  loadModels().then(() => toast(`Using ${name}`))
}

// ---- downloads ----
function startPull(name: string) {
  pulling.set(name, { name, status: 'starting', completed: 0, total: 0, percent: 0, bytesPerSec: 0, done: false })
  renderDownloads()
  paintPulls()
  window.forge
    .modelsPull(name)
    .catch((e) => toast(cleanErr(e), 5000))
    .finally(() => {
      pulling.delete(name)
      renderDownloads()
      refresh()
    })
}

function pullBar(p: PullEvent): HTMLElement {
  const w = h('div', 'pull')
  w.dataset.pull = p.name
  const bar = h('div', 'pbar')
  const fill = h('i')
  fill.style.width = p.percent + '%'
  bar.append(fill)
  const txt = h('span', 'ptxt', progressText(p))
  const cancel = h('button', 'icon-btn sm')
  cancel.append(icon('x', 'sm'))
  cancel.title = 'Cancel download'
  cancel.onclick = () => window.forge.modelsCancel(p.name)
  w.append(bar, txt, cancel)
  return w
}
const progressText = (p: PullEvent) => (p.total ? `${p.percent}% · ${fmtBytes(p.completed)} of ${fmtBytes(p.total)}${p.bytesPerSec > 0 ? ` · ${fmtSpeed(p.bytesPerSec)}` : ''}` : p.status || 'Starting…')

function paintPulls() {
  for (const el of document.querySelectorAll<HTMLElement>('#library [data-pull]')) {
    const p = pulling.get(el.dataset.pull!)
    if (!p) continue
    ;(el.querySelector('.pbar i') as HTMLElement).style.width = p.percent + '%'
    el.querySelector('.ptxt')!.textContent = progressText(p)
  }
  // rows that just started downloading need their button swapped for a bar
  for (const row of document.querySelectorAll<HTMLElement>('#library [data-model]')) {
    const name = row.dataset.model!
    const slot = row.querySelector('.act') as HTMLElement | null
    if (slot && pulling.has(name) && !slot.querySelector('.pull')) slot.replaceChildren(pullBar(pulling.get(name)!))
  }
}

function actionFor(name: string, installed: boolean): HTMLElement {
  const p = pulling.get(name)
  if (p) return pullBar(p)
  if (installed) {
    const b = h('button', 'btn', 'Use')
    b.onclick = () => useModel(name)
    return b
  }
  const b = h('button', 'btn')
  b.append(icon('download', 'sm'), document.createTextNode('Download'))
  b.onclick = () => startPull(name)
  return b
}

// A strip with every active download, so one started by typing a name (which has no row of its own) is still visible.
function renderDownloads() {
  if (!dlBox) return
  dlBox.hidden = pulling.size === 0
  dlBox.replaceChildren(
    ...[...pulling.values()].map((p) => {
      const r = h('div', 'dl-row')
      r.append(h('span', 'dl-name', p.name), pullBar(p))
      return r
    }),
  )
}

// ---- engine card ----
async function renderEngine() {
  if (!engineBox) return
  const st = await window.forge.engineStatus()
  const card = h('div', 'engine')
  if (st.state === 'ready-external' || st.state === 'ready-managed') {
    const l = h('div', 'engine-line')
    l.append(h('span', 'badge ok', 'Engine running'), h('span', 'muted', `Ollama ${st.version ?? ''}${st.state === 'ready-managed' ? ' · managed by Forge' : ''}`))
    card.append(l)
    if (st.cpuOnly) card.append(h('div', 'engine-warn', 'The model is running on the CPU, not the graphics card, so it will be several times slower. Install the GPU build of Ollama.'))
  } else if (st.installing || engineProgress) {
    const p = engineProgress ?? { phase: 'lookup', done: 0, total: 0 }
    card.append(h('div', 'engine-title', 'Setting up the AI engine'))
    const bar = h('div', 'pbar wide')
    const fill = h('i')
    fill.style.width = (p.phase === 'download' && p.total ? Math.round((p.done / p.total) * 100) : p.phase === 'extract' || p.phase === 'start' ? 100 : 0) + '%'
    bar.append(fill)
    card.append(bar)
    const txt = p.phase === 'download' ? `Downloading ${fmtBytes(p.done)} of ${fmtBytes(p.total)}${p.bytesPerSec ? ` · ${fmtSpeed(p.bytesPerSec)}` : ''}` : (PHASE[p.phase] ?? '')
    const row = h('div', 'engine-line')
    row.append(h('span', 'muted', txt))
    const cancel = h('button', 'btn', 'Cancel')
    cancel.onclick = () => window.forge.engineCancel()
    row.append(cancel)
    card.append(row)
  } else if (st.state === 'installed') {
    card.append(h('div', 'engine-title', 'The AI engine is installed but not running'))
    const b = h('button', 'btn primary', 'Start engine') as HTMLButtonElement
    b.onclick = async () => {
      b.disabled = true
      try {
        await window.forge.engineStart()
      } catch (e) {
        toast(cleanErr(e), 5000)
      }
      refresh()
    }
    card.append(b)
  } else {
    card.classList.add('need')
    card.append(h('div', 'engine-title', 'Forge needs an AI engine to run models on this computer'))
    card.append(h('div', 'muted', 'It is Ollama, the open-source engine. About 1.5 GB, downloaded once into Forge’s own folder and run privately. Nothing is installed system-wide.'))
    const b = h('button', 'btn primary') as HTMLButtonElement
    b.append(icon('download', 'sm'), document.createTextNode('Install the engine'))
    b.onclick = async () => {
      b.disabled = true
      engineProgress = { phase: 'lookup', done: 0, total: 0 }
      renderEngine()
      try {
        await window.forge.engineInstall()
      } catch (e) {
        toast(cleanErr(e), 7000)
      }
      engineProgress = null
      refresh()
    }
    card.append(b)
  }
  engineBox.replaceChildren(card)
}

async function renderHardware() {
  if (!hwLine) return
  const s = await window.forge.systemInfo()
  const gpu = s.gpu ? `${s.gpu.name} · ${s.gpu.freeGB.toFixed(1)} GB free of ${Math.round(s.gpu.vramGB)} GB` : 'No supported graphics card found (CPU only)'
  hwLine.textContent = `${gpu} · ${Math.round(s.ramGB)} GB memory${s.diskFreeGB !== null ? ` · ${Math.round(s.diskFreeGB)} GB disk free` : ''}`
}

// ---- tabs ----
function row(name: string, title: string, sub: string, side: HTMLElement[], act: HTMLElement) {
  const r = h('div', 'mrow')
  r.dataset.model = name
  const info = h('div', 'minfo')
  info.append(h('div', 'mt', title), h('div', 'ms', sub))
  const mid = h('div', 'mside')
  mid.append(...side)
  const slot = h('div', 'act')
  slot.append(act)
  r.append(info, mid, slot)
  return r
}

async function renderInstalled(into: HTMLElement) {
  const list = await window.forge.modelsInstalled()
  if (!list.length) {
    const e = h('div', 'empty-box')
    e.append(h('div', 'et', 'No models downloaded yet'), h('div', 'muted', 'Open the Discover tab and download one. Once it is here it works without internet.'))
    const go = h('button', 'btn primary', 'Browse models')
    go.onclick = () => setTab('discover')
    e.append(go)
    into.append(e)
    return
  }
  const box = h('div', 'sbox')
  for (const m of list as InstalledModel[]) {
    const del = h('button', 'btn danger-quiet', 'Delete')
    let armed = false
    del.onclick = async () => {
      if (!armed) {
        armed = true
        del.textContent = 'Click again to delete'
        setTimeout(() => ((armed = false), (del.textContent = 'Delete')), 3000)
        return
      }
      try {
        await window.forge.modelsDelete(m.name)
        toast(`Deleted ${m.name}`)
      } catch (e) {
        toast(cleanErr(e), 5000)
      }
      refresh()
    }
    const side = [h('span', 'badge', fmtBytes(m.sizeBytes))]
    if (m.loaded) side.push(h('span', 'badge ok', 'In memory'))
    const act = h('div', 'btns')
    act.append(actionFor(m.name, true), del)
    box.append(row(m.name, m.name, [m.params, m.quant].filter(Boolean).join(' · ') || 'Local model', side, act))
  }
  into.append(box)
}

async function renderDiscover(into: HTMLElement) {
  const cat = await window.forge.modelsCatalog()
  const best = cat.filter((m) => m.best)
  const rest = cat.filter((m) => !m.best)
  const section = (title: string, items: CatalogItem[]) => {
    if (!items.length) return
    const g = h('div', 'sgroup')
    g.append(h('div', 'gt', title))
    const box = h('div', 'sbox')
    for (const m of items) {
      const [label, cls] = FIT[m.fit]
      const side = [h('span', 'badge ' + cls, label), h('span', 'badge', `${m.sizeGB} GB`)]
      for (const t of m.tags.slice(0, 2)) side.push(h('span', 'badge tag', t))
      box.append(row(m.id, m.name, m.blurb, side, actionFor(m.id, m.installed)))
    }
    g.append(box)
    into.append(g)
  }
  section('Best for this computer', best)
  section(best.length ? 'More models' : 'Models', rest)

  const g = h('div', 'sgroup')
  g.append(h('div', 'gt', 'Download any model by name'))
  const f = h('form', 'custom')
  const input = document.createElement('input')
  input.placeholder = 'for example llama3.1:8b'
  input.setAttribute('aria-label', 'Model name')
  const go = h('button', 'btn', 'Download')
  go.setAttribute('type', 'submit')
  f.append(input, go)
  f.onsubmit = (e) => {
    e.preventDefault()
    const n = input.value.trim()
    if (n) {
      input.value = ''
      startPull(n)
    }
  }
  g.append(f, h('div', 'note', 'Any name from ollama.com/library works. Models need tool support to edit files.'))
  into.append(g)
}

async function renderHF(into: HTMLElement) {
  const f = h('form', 'custom wide')
  const input = document.createElement('input')
  input.placeholder = 'Search Hugging Face, for example qwen coder'
  input.value = hfQuery
  input.setAttribute('aria-label', 'Search Hugging Face')
  const go = h('button', 'btn primary') as HTMLButtonElement
  go.append(icon('search', 'sm'), document.createTextNode('Search'))
  go.setAttribute('type', 'submit')
  f.append(input, go)
  f.onsubmit = async (e) => {
    e.preventDefault()
    hfQuery = input.value.trim()
    if (!hfQuery) return
    hfError = ''
    go.disabled = true
    try {
      hfResults = await window.forge.modelsSearch(hfQuery)
    } catch (err) {
      hfResults = null
      hfError = cleanErr(err)
    }
    refresh()
  }
  into.append(f, h('div', 'note', 'Community models in GGUF format. Quality and tool support vary; the ones from well-known publishers are safest.'))
  if (hfError) into.append(h('div', 'errtext', hfError))
  if (hfResults && !hfResults.length) into.append(h('div', 'muted pad', 'Nothing found. Try other words.'))
  if (hfResults?.length) {
    const box = h('div', 'sbox')
    for (const m of hfResults) box.append(row(m.pullName, m.id, `${fmtCount(m.downloads)} downloads · ${fmtCount(m.likes)} likes`, [], actionFor(m.pullName, false)))
    into.append(box)
  }
}

async function render() {
  if (!body) return
  const fresh = h('div')
  try {
    if (tab === 'installed') await renderInstalled(fresh)
    else if (tab === 'discover') await renderDiscover(fresh)
    else await renderHF(fresh)
  } catch (e) {
    fresh.append(h('div', 'errtext', cleanErr(e)))
  }
  body.replaceChildren(...fresh.childNodes)
  document.querySelectorAll<HTMLElement>('#library .lib-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab))
}

const refresh = () => {
  renderDownloads()
  return Promise.all([renderEngine(), render(), renderHardware()])
}
function setTab(t: Tab) {
  tab = t
  render()
}

export async function openLibrary(opts: { welcome?: boolean; tab?: Tab } = {}) {
  welcome = !!opts.welcome
  if (opts.tab) tab = opts.tab
  else if (welcome) tab = 'discover'
  const dlg = $<HTMLDialogElement>('library')
  const wrap = h('div', 'lib')
  const head = h('div', 'lib-head')
  const titles = h('div')
  titles.append(h('h3', '', welcome ? 'Welcome to Forge' : 'Models'), h('div', 'muted', welcome ? 'Pick a model to download. It runs on your computer, so once it is here Forge works offline.' : 'Download models and run them on this computer.'))
  const close = h('button', 'icon-btn')
  close.append(icon('x'))
  close.title = 'Close (Esc)'
  close.setAttribute('aria-label', 'Close')
  close.onclick = () => dlg.close()
  head.append(titles, close)
  engineBox = h('div', 'engine-wrap')
  hwLine = h('div', 'hw')
  dlBox = h('div', 'downloads')
  dlBox.hidden = true
  const tabs = h('div', 'lib-tabs')
  for (const [id, label] of [['installed', 'Installed'], ['discover', 'Discover'], ['hf', 'Hugging Face']] as [Tab, string][]) {
    const b = h('button', '', label)
    b.dataset.tab = id
    b.onclick = () => setTab(id)
    tabs.append(b)
  }
  body = h('div', 'lib-body')
  wrap.append(head, engineBox, dlBox, hwLine, tabs, body)
  if (welcome) {
    const skip = h('button', 'link-btn', 'I will use an API key instead')
    skip.onclick = () => {
      try {
        localStorage.setItem('forge.onboarded', '1')
      } catch {}
      dlg.close()
    }
    wrap.append(skip)
  }
  dlg.replaceChildren(wrap)
  if (!dlg.open) dlg.showModal()
  ;(document.activeElement as HTMLElement | null)?.blur()
  body.replaceChildren(...Array.from({ length: 3 }, () => h('div', 'skel skel-row')))
  await refresh()
}

export function initLibrary() {
  window.forge.onModelsProgress((p) => {
    if (p.done) {
      pulling.delete(p.name)
      renderDownloads()
      if (p.error) toast(p.error, 5000)
      else if (!p.cancelled) toast(`${p.name} is ready`)
      return
    }
    const known = pulling.has(p.name)
    pulling.set(p.name, p)
    if (!known) renderDownloads()
    paintPulls()
  })
  window.forge.onModelsChanged(() => {
    loadModels()
    if ($<HTMLDialogElement>('library').open) refresh()
  })
  window.forge.onEngineProgress((p) => {
    engineProgress = p.phase === 'done' ? null : p
    if ($<HTMLDialogElement>('library').open) renderEngine()
  })
  window.forge.onEngineChanged(() => {
    if ($<HTMLDialogElement>('library').open) refresh()
    loadModels()
  })
}
