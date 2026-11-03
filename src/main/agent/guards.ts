import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ToolCall } from './provider'

// ---- loose edit matching: small models often drop or mangle indentation ----
// Also ignores a trailing semicolon: models add and drop them all the time.
const norm = (l: string) => l.trim().replace(/\s+/g, ' ').replace(/;$/, '')
const indentOf = (l: string) => /^\s*/.exec(l)![0]

// Finds old_text ignoring whitespace differences, line by line. Returns every match as a char range.
export function findLoose(text: string, oldText: string): { start: number; end: number; indent: string }[] {
  const want = oldText.split('\n').map(norm)
  while (want.length && !want[0]) want.shift()
  while (want.length && !want.at(-1)) want.pop()
  if (!want.length) return []
  const lines = text.split('\n')
  const offsets: number[] = []
  let o = 0
  for (const l of lines) {
    offsets.push(o)
    o += l.length + 1
  }
  const hits: { start: number; end: number; indent: string }[] = []
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, j) => norm(lines[i + j]) === w)) {
      const last = i + want.length - 1
      hits.push({ start: offsets[i], end: offsets[last] + lines[last].length, indent: indentOf(lines[i]) })
    }
  }
  return hits
}

// If the model's old_text lost the file's indentation, put it back on new_text too.
export function reindent(newText: string, oldText: string, fileIndent: string): string {
  const first = oldText.split('\n').find((l) => l.trim()) ?? ''
  const modelIndent = indentOf(first)
  if (!fileIndent.startsWith(modelIndent) || fileIndent === modelIndent) return newText
  const add = fileIndent.slice(modelIndent.length)
  return newText.split('\n').map((l) => (l.trim() ? add + l : l)).join('\n')
}

// ---- syntax check after every edit. Cheap checks only; types and tests are the verify step's job ----
const PY = 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf8").read())'

function exec(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 10_000 }, (err, _out, stderr) => {
      if (!err) return resolve(null)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null) // checker not installed: skip
      resolve(stderr.split('\n').filter(Boolean).slice(0, 5).join('\n') || err.message)
    })
  })
}

export async function checkSyntax(file: string): Promise<string | null> {
  const ext = extname(file).toLowerCase()
  if (ext === '.json') {
    try {
      JSON.parse(await readFile(file, 'utf8'))
      return null
    } catch (e) {
      return (e as Error).message
    }
  }
  // ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain node, so no system node is needed
  if (['.js', '.mjs', '.cjs'].includes(ext)) return exec(process.execPath, ['--check', file], { ELECTRON_RUN_AS_NODE: '1' })
  if (ext === '.py') return exec('python3', ['-c', PY, file])
  return null
}

// ---- tool names: small models say read, cat, write_file. Resolve BEFORE the approval gate, never after ----
const NAMES = ['list_dir', 'read_file', 'search', 'run_command', 'edit_file', 'create_file']
const ALIAS: Record<string, string> = {
  read: 'read_file', readfile: 'read_file', cat: 'read_file', open: 'read_file', view: 'read_file', open_file: 'read_file',
  ls: 'list_dir', list: 'list_dir', listdir: 'list_dir', list_files: 'list_dir', list_directory: 'list_dir',
  grep: 'search', find: 'search', search_files: 'search', search_code: 'search',
  edit: 'edit_file', replace: 'edit_file', str_replace: 'edit_file', update_file: 'edit_file',
  create: 'create_file', write: 'create_file', write_file: 'create_file', new_file: 'create_file', make_file: 'create_file', save_file: 'create_file', add_file: 'create_file',
  run: 'run_command', bash: 'run_command', shell: 'run_command', exec: 'run_command', terminal: 'run_command', run_shell: 'run_command',
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

export function resolveToolName(name: string): string | null {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  if (NAMES.includes(n)) return n
  if (ALIAS[n]) return ALIAS[n]
  const near = NAMES.filter((c) => distance(n, c) <= 2)
  return near.length === 1 ? near[0] : null
}

// ---- tool calls written as text: <tool_call>{"name": ..., "arguments": {...}}</tool_call> ----
export function parseTextToolCalls(content: string): { content: string; calls: ToolCall[] } {
  const calls: ToolCall[] = []
  const stripped = content.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (whole, body: string) => {
    try {
      const j = JSON.parse(body) as { name?: unknown; arguments?: unknown; parameters?: unknown }
      if (typeof j.name !== 'string') return whole
      let args = j.arguments ?? j.parameters ?? {}
      if (typeof args === 'string') args = JSON.parse(args)
      calls.push({ name: j.name, args })
      return ''
    } catch {
      return whole
    }
  })
  return { content: stripped.trim(), calls }
}
