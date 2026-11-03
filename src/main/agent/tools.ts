import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { inRoot } from '../project'

export type ToolDef = {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, { type: 'string'; description: string }>; required: string[] }
}

export const toolDefs: ToolDef[] = [
  {
    name: 'list_dir',
    description: 'List files and folders in a project directory. Use "." for the project root. Folders end with "/".',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to project root' } }, required: ['path'] },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the project. Always read a file before editing it.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File relative to project root' } }, required: ['path'] },
  },
  {
    name: 'edit_file',
    description:
      'Replace old_text with new_text in a file you already read. old_text must match the file exactly once. To create a new file, use an empty old_text on a path that does not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File relative to project root' },
        old_text: { type: 'string', description: 'Exact text to replace (empty to create a new file)' },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
]

const MAX_READ = 20_000
const hash = (s: string) => createHash('sha1').update(s).digest('hex')

// Tool errors are returned as text so the model can recover. Nothing here throws to the loop.
export class ToolBox {
  // path -> content hash at last read; edit_file needs a fresh entry (read-before-edit, enforced in code)
  private seen = new Map<string, string>()

  async run(name: string, args: unknown): Promise<string> {
    const def = toolDefs.find((t) => t.name === name)
    if (!def) return `ERROR: unknown tool "${name}". Available: ${toolDefs.map((t) => t.name).join(', ')}`
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    for (const k of def.parameters.required) if (typeof a[k] !== 'string') return `ERROR: ${name} needs string argument "${k}"`
    try {
      if (name === 'list_dir') return await this.list(a.path as string)
      if (name === 'read_file') return await this.read(a.path as string)
      return await this.edit(a.path as string, a.old_text as string, a.new_text as string)
    } catch (e) {
      return `ERROR: ${(e as Error).message}`
    }
  }

  private async list(path: string) {
    const entries = await readdir(inRoot(path), { withFileTypes: true })
    const lines = entries
      .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((d) => d.name + (d.isDirectory() ? '/' : ''))
    return lines.join('\n') || '(empty)'
  }

  private async read(path: string) {
    const text = await readFile(inRoot(path), 'utf8')
    this.seen.set(inRoot(path), hash(text))
    return text.length > MAX_READ ? text.slice(0, MAX_READ) + `\n[truncated, file is ${text.length} chars]` : text
  }

  private async edit(path: string, oldText: string, newText: string) {
    let real: string
    let current: string | null
    real = inRoot(path)
    try {
      current = await readFile(real, 'utf8')
    } catch {
      current = null
    }
    if (current === null) {
      if (oldText !== '') return `ERROR: ${path} does not exist. To create it, pass an empty old_text.`
      await writeFile(real, newText)
      this.seen.set(real, hash(newText))
      return `created ${path} (${newText.length} chars)`
    }
    if (this.seen.get(real) !== hash(current)) return `ERROR: read ${path} first (not read this run, or it changed since).`
    if (oldText === '') return `ERROR: ${path} already exists; old_text must not be empty.`
    const first = current.indexOf(oldText)
    if (first === -1) return `ERROR: old_text not found in ${path}. Re-read the file and copy the text exactly.`
    if (current.indexOf(oldText, first + 1) !== -1) return `ERROR: old_text matches more than once in ${path}. Add surrounding lines to make it unique.`
    const next = current.slice(0, first) + newText + current.slice(first + oldText.length)
    await writeFile(real, next)
    this.seen.set(real, hash(next))
    return `edited ${path}: replaced ${oldText.length} chars with ${newText.length} chars`
  }
}
