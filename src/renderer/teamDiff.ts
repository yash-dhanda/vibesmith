import editorWorker from 'monaco-editor/editor/editor.worker?worker'

let editor: import('monaco-editor').editor.IStandaloneDiffEditor | null = null
let models: import('monaco-editor').editor.ITextModel[] = []

if (!self.MonacoEnvironment) self.MonacoEnvironment = { getWorker: () => new editorWorker() }

function sides(diff: string) {
  const old: string[] = [], next: string[] = []
  for (const line of diff.split('\n')) {
    if (/^(---|\+\+\+|@@|diff |index )/.test(line)) continue
    if (line.startsWith('-')) old.push(line.slice(1))
    else if (line.startsWith('+')) next.push(line.slice(1))
    else { const value = line.startsWith(' ') ? line.slice(1) : line; old.push(value); next.push(value) }
  }
  return { old: old.join('\n'), next: next.join('\n') }
}

export async function mountTeamDiff(host: HTMLElement, diff: string) {
  const monaco = await import('monaco-editor')
  editor?.dispose(); models.forEach(m => m.dispose())
  const value = sides(diff)
  models = [monaco.editor.createModel(value.old, 'plaintext'), monaco.editor.createModel(value.next, 'plaintext')]
  editor = monaco.editor.createDiffEditor(host, { readOnly: true, automaticLayout: true, minimap: { enabled: false }, renderSideBySide: host.clientWidth > 720, fontSize: 12, scrollBeyondLastLine: false })
  editor.setModel({ original: models[0], modified: models[1] })
}
