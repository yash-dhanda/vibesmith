import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import type { ForgeApi } from '../preload'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

declare global {
  interface Window {
    forge: ForgeApi
  }
}

self.MonacoEnvironment = { getWorker: () => new editorWorker() }

const editor = monaco.editor.create(document.getElementById('editor')!, {
  theme: 'vs-dark', // replaced by the 'forge' theme once the tokens are read
  fontFamily: "'Geist Mono Variable', ui-monospace, Menlo, Consolas, monospace",
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
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
  await ensureTerminal()
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

// Files were put back on disk (undo): reload open tabs, close tabs whose file no longer exists, refresh the tree.
async function filesRestored(paths: string[]) {
  for (const path of paths) {
    const t = tabs.get(path)
    if (!t) continue
    try {
      const text = await window.forge.read(path)
      t.model.setValue(text)
      t.saved = text
    } catch {
      t.model.dispose()
      tabs.delete(path)
      if (active === path) {
        active = null
        const next = [...tabs.keys()][0]
        if (next) show(next)
        else editor.setModel(null)
      }
    }
  }
  renderTabs()
  const tree = document.getElementById('tree')!
  tree.replaceChildren()
  await renderDir('.', tree, 0)
}

// ---- workspace drawer: hidden until asked for. The app opens as a chat, not an editor. ----
const app = document.getElementById('app')!
let projectRoot: string | null = null
let termFor: string | null = null

function setWorkspace(open: boolean) {
  app.classList.toggle('ws-open', open)
  try {
    localStorage.setItem('forge.ws', open ? '1' : '0')
  } catch {}
  if (open) ensureTerminal()
}

// The shell only starts once the drawer is opened for the current project, so a chat never spawns a hidden terminal.
async function ensureTerminal() {
  if (!projectRoot || !app.classList.contains('ws-open') || termFor === projectRoot) return
  termFor = projectRoot
  await startTerminal()
}

export async function setProject(root: string | null) {
  projectRoot = root
  termFor = null
  await loadTree()
}
export { agentChangedFile, filesRestored, setWorkspace }

const term = new Terminal({ fontSize: 13, fontFamily: "'Geist Mono Variable', ui-monospace, Menlo, Consolas, monospace", cursorBlink: true })
const fit = new FitAddon()
term.loadAddon(fit)
term.open(document.getElementById('term')!)
term.onData((d) => window.forge.termWrite(d))
window.forge.onTermData((d) => term.write(d))
new ResizeObserver(() => {
  if (!document.getElementById('term')!.offsetWidth) return // drawer closed: nothing to fit
  fit.fit()
  window.forge.termResize(term.cols, term.rows)
}).observe(document.getElementById('term')!)

async function startTerminal() {
  fit.fit()
  term.clear()
  await window.forge.termSpawn(term.cols, term.rows)
}

// The editor and terminal follow the app theme and take their colours from the same tokens as the rest of the UI.
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
function paintTheme() {
  const dark = document.documentElement.dataset.theme !== 'light'
  monaco.editor.defineTheme('forge', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': token('--bg'),
      'editor.foreground': token('--text'),
      'editorLineNumber.foreground': token('--faint'),
      'editorLineNumber.activeForeground': token('--muted'),
      'editor.lineHighlightBackground': token('--panel'),
      'editorCursor.foreground': token('--accent'),
      'editor.selectionBackground': token('--accent') + '44',
      'editorWidget.background': token('--panel'),
      'editorGutter.background': token('--bg'),
    },
  })
  monaco.editor.setTheme('forge')
  term.options.theme = { background: token('--term-bg'), foreground: token('--text'), cursor: token('--accent'), selectionBackground: token('--accent') + '44' }
}
window.addEventListener('forge-theme', paintTheme)
paintTheme()
