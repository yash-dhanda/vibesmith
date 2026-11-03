import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import type { ForgeApi } from '../preload'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { initChat } from './chat'

declare global {
  interface Window {
    forge: ForgeApi
  }
}

self.MonacoEnvironment = { getWorker: () => new editorWorker() }

const editor = monaco.editor.create(document.getElementById('editor')!, {
  theme: 'vs-dark',
  automaticLayout: true,
  model: null,
})

type Tab = { path: string; model: monaco.editor.ITextModel; saved: string }
const tabs = new Map<string, Tab>()
let active: string | null = null

const tabsEl = document.getElementById('tabs')!

function renderTabs() {
  tabsEl.replaceChildren(
    ...[...tabs.values()].map((t) => {
      const el = document.createElement('div')
      const dirty = t.model.getValue() !== t.saved
      el.className = 'tab' + (t.path === active ? ' active' : '')
      el.textContent = t.path.split('/').pop() + (dirty ? ' ●' : '')
      el.onclick = () => show(t.path)
      return el
    }),
  )
}

function show(path: string) {
  active = path
  editor.setModel(tabs.get(path)!.model)
  renderTabs()
}

async function openFile(path: string) {
  if (!tabs.has(path)) {
    const text = await window.forge.read(path)
    const model = monaco.editor.createModel(text, undefined, monaco.Uri.file('/' + path))
    model.onDidChangeContent(renderTabs)
    tabs.set(path, { path, model, saved: text })
  }
  show(path)
}

async function save() {
  const t = active && tabs.get(active)
  if (!t) return
  const text = t.model.getValue()
  await window.forge.write(t.path, text)
  t.saved = text
  renderTabs()
}

editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save)

async function renderDir(dir: string, into: HTMLElement, depth: number) {
  for (const e of await window.forge.list(dir)) {
    const path = dir === '.' ? e.name : `${dir}/${e.name}`
    const row = document.createElement('div')
    row.className = 'row'
    row.style.paddingLeft = 8 + depth * 14 + 'px'
    row.textContent = (e.dir ? '▸ ' : '  ') + e.name
    into.append(row)
    if (e.dir) {
      const kids = document.createElement('div')
      into.append(kids)
      let loaded = false
      row.onclick = async () => {
        if (!loaded) {
          loaded = true
          await renderDir(path, kids, depth + 1)
        } else kids.hidden = !kids.hidden
        row.textContent = (kids.hidden ? '▸ ' : '▾ ') + e.name
      }
    } else row.onclick = () => openFile(path)
  }
}

async function loadTree() {
  const tree = document.getElementById('tree')!
  tree.replaceChildren()
  for (const t of tabs.values()) t.model.dispose()
  tabs.clear()
  active = null
  editor.setModel(null)
  renderTabs()
  await renderDir('.', tree, 0)
  await startTerminal()
}

// The agent edited a file on disk: show it. A tab with unsaved user changes is left alone.
async function agentChangedFile(path: string) {
  const t = tabs.get(path)
  if (!t) {
    await openFile(path)
    // ponytail: rebuilds the tree, which collapses folders; track created paths and patch the tree if that annoys
    const tree = document.getElementById('tree')!
    tree.replaceChildren()
    await renderDir('.', tree, 0)
  } else if (t.model.getValue() === t.saved) {
    const text = await window.forge.read(path)
    t.model.setValue(text)
    t.saved = text
    show(path)
  }
}

initChat({ onFileChanged: agentChangedFile })

document.getElementById('open')!.onclick = async () => {
  if (await window.forge.openProject()) await loadTree()
}

window.forge.currentProject().then((r) => {
  if (r) loadTree()
})

const term = new Terminal({ fontSize: 13, theme: { background: '#1e1e1e' }, cursorBlink: true })
const fit = new FitAddon()
term.loadAddon(fit)
term.open(document.getElementById('term')!)
term.onData((d) => window.forge.termWrite(d))
window.forge.onTermData((d) => term.write(d))
new ResizeObserver(() => {
  fit.fit()
  window.forge.termResize(term.cols, term.rows)
}).observe(document.getElementById('term')!)

async function startTerminal() {
  fit.fit()
  term.clear()
  await window.forge.termSpawn(term.cols, term.rows)
}
