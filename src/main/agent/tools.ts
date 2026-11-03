import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveIn } from '../project'
import { runCommand } from './commands'
import { checkSyntax, findLoose, reindent, resolveToolName } from './guards'

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
    name: 'search',
    description: 'Search project files for a regular expression. Returns up to 100 matching lines as path:line: text.',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'JavaScript regular expression' } }, required: ['pattern'] },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the project folder (tests, builds, git). Times out after 60 seconds. Output is truncated to the last 10000 characters.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command' } }, required: ['command'] },
  },
  {
    name: 'create_file',
    description: 'Create a new file with the given content. Missing folders are created too. Fails if the file already exists (use edit_file for that). Use this to build things for the user instead of pasting code into the chat.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File relative to project root' }, content: { type: 'string', description: 'Full content of the new file' } },
      required: ['path', 'content'],
    },
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
  constructor(private root: string) {}

  private inRoot = (p: string) => resolveIn(this.root, p)

  // path -> content hash at last read; edit_file needs a fresh entry (read-before-edit, enforced in code)
  private seen = new Map<string, string>()

  async run(name: string, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<string> {
    name = resolveToolName(name) ?? name
    const def = toolDefs.find((t) => t.name === name)
    if (!def) return `ERROR: unknown tool "${name}". Available: ${toolDefs.map((t) => t.name).join(', ')}`
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    for (const k of def.parameters.required) if (typeof a[k] !== 'string') return `ERROR: ${name} needs string argument "${k}"`
    try {
      if (name === 'list_dir') return await this.list(a.path as string)
      if (name === 'read_file') return await this.read(a.path as string)
      if (name === 'search') return await this.search(a.pattern as string)
      if (name === 'run_command') return await runCommand(a.command as string, this.root, signal)
      if (name === 'create_file') return await this.create(a.path as string, a.content as string)
      return await this.edit(a.path as string, a.old_text as string, a.new_text as string)
    } catch (e) {
      return `ERROR: ${(e as Error).message}`
    }
  }

  private async list(path: string) {
    const entries = await readdir(this.inRoot(path), { withFileTypes: true })
    const lines = entries
      .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((d) => d.name + (d.isDirectory() ? '/' : ''))
    return lines.join('\n') || '(empty)'
  }

  private async search(pattern: string) {
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      return `ERROR: invalid regular expression: ${(e as Error).message}`
    }
    const root = this.root
    const hits: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const d of await readdir(join(root, dir), { withFileTypes: true })) {
        if (hits.length >= 100) return
        if (d.name === '.git' || d.name === 'node_modules' || d.isSymbolicLink()) continue
        const rel = dir ? `${dir}/${d.name}` : d.name
        if (d.isDirectory()) await walk(rel)
        else {
          const buf = await readFile(join(root, rel)).catch(() => null)
          if (!buf || buf.length > 1_000_000 || buf.includes(0)) continue // skip unreadable, big and binary files
          buf.toString('utf8').split('\n').forEach((line, i) => {
            if (hits.length < 100 && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.slice(0, 200)}`)
          })
        }
      }
    }
    await walk('')
    return hits.length ? hits.join('\n') : 'no matches'
  }

  private async read(path: string) {
    const text = await readFile(this.inRoot(path), 'utf8')
    this.seen.set(this.inRoot(path), hash(text))
    return text.length > MAX_READ ? text.slice(0, MAX_READ) + `\n[truncated, file is ${text.length} chars]` : text
  }

  private async create(path: string, content: string) {
    const real = this.inRoot(path)
    if ((await readFile(real, 'utf8').catch(() => null)) !== null) return `ERROR: ${path} already exists. Use read_file, then edit_file, to change it.`
    await mkdir(dirname(real), { recursive: true })
    return this.commit(path, real, null, content, '')
  }

  private async edit(path: string, oldText: string, newText: string) {
    const real = this.inRoot(path)
    const current = await readFile(real, 'utf8').catch(() => null)
    if (current === null) {
      if (oldText !== '') return `ERROR: ${path} does not exist. To create it, pass an empty old_text.`
      await mkdir(dirname(real), { recursive: true })
      return this.commit(path, real, null, newText, '')
    }
    if (this.seen.get(real) !== hash(current)) return `ERROR: read ${path} first (not read this run, or it changed since).`
    if (oldText === '') return `ERROR: ${path} already exists; old_text must not be empty.`

    // Tier 1: exact. Tier 2: same lines ignoring whitespace. Both must match exactly once.
    const first = current.indexOf(oldText)
    if (first !== -1) {
      if (current.indexOf(oldText, first + 1) !== -1) return `ERROR: old_text matches more than once in ${path}. Add surrounding lines to make it unique.`
      return this.commit(path, real, current, current.slice(0, first) + newText + current.slice(first + oldText.length), '')
    }
    const loose = findLoose(current, oldText)
    if (loose.length === 0) return `ERROR: old_text not found in ${path}. Re-read the file and copy the text exactly.`
    if (loose.length > 1) return `ERROR: old_text matches ${loose.length} places in ${path} (ignoring whitespace). Add surrounding lines to make it unique.`
    const [m] = loose
    const replacement = reindent(newText, oldText, m.indent).replace(/\n$/, '')
    return this.commit(path, real, current, current.slice(0, m.start) + replacement + current.slice(m.end), ' (matched ignoring whitespace differences)')
  }

  // Writes, then syntax-checks. A new error caused by this edit reverts the file.
  private async commit(path: string, real: string, before: string | null, after: string, note: string) {
    await writeFile(real, after)
    const err = await checkSyntax(real)
    if (err) {
      if (before === null) await rm(real)
      else await writeFile(real, before)
      const brokenBefore = before !== null && (await checkSyntax(real))
      if (!brokenBefore) {
        if (before !== null) this.seen.set(real, hash(before))
        return `ERROR: this edit would leave ${path} with a syntax error, so it was NOT applied:\n${err}\nFix the new_text and try again.`
      }
      await writeFile(real, after) // file was already broken before this edit, so the edit is not to blame
      note += ' (file already had a syntax error before this edit)'
    }
    this.seen.set(real, hash(after))
    return before === null ? `created ${path} (${after.length} chars)` : `edited ${path}${note}`
  }
}
