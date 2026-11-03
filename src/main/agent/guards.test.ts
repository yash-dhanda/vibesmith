import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { setRoot } from '../project'
import { checkSyntax, findLoose, parseTextToolCalls, reindent, resolveToolName } from './guards'
import { ToolBox } from './tools'

describe('resolveToolName', () => {
  it('maps exact names, aliases, formatting variants and typos; rejects the rest', () => {
    expect(resolveToolName('read_file')).toBe('read_file')
    expect(resolveToolName('Read File')).toBe('read_file')
    expect(resolveToolName('cat')).toBe('read_file')
    expect(resolveToolName('write_file')).toBe('create_file')
    expect(resolveToolName('str_replace')).toBe('edit_file')
    expect(resolveToolName('bash')).toBe('run_command')
    expect(resolveToolName('read_flie')).toBe('read_file')
    expect(resolveToolName('delete_everything')).toBeNull()
  })
})

describe('parseTextToolCalls', () => {
  it('extracts calls written as text and strips them from the content', () => {
    const r = parseTextToolCalls('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.js"}}\n</tool_call>')
    expect(r.calls).toEqual([{ name: 'read_file', args: { path: 'a.js' } }])
    expect(r.content).toBe('Let me look.')
  })
  it('accepts string arguments and "parameters"; leaves malformed calls alone', () => {
    expect(parseTextToolCalls('<tool_call>{"name":"search","arguments":"{\\"pattern\\":\\"x\\"}"}</tool_call>').calls[0].args).toEqual({ pattern: 'x' })
    expect(parseTextToolCalls('<tool_call>{"name":"list_dir","parameters":{"path":"."}}</tool_call>').calls[0].args).toEqual({ path: '.' })
    const bad = parseTextToolCalls('<tool_call>not json</tool_call>')
    expect(bad.calls).toEqual([])
    expect(bad.content).toContain('not json')
  })
})

describe('findLoose / reindent', () => {
  const file = 'function f() {\n    if (x) {\n        go()\n    }\n}\n'
  it('matches ignoring indentation and spacing, reports every match', () => {
    const [m] = findLoose(file, 'if (x) {\n  go()\n}')
    expect(file.slice(m.start, m.end)).toBe('    if (x) {\n        go()\n    }')
    expect(m.indent).toBe('    ')
    expect(findLoose('a\na\n', 'a')).toHaveLength(2)
    expect(findLoose(file, 'nothing like this')).toEqual([])
    expect(findLoose(file, '   \n')).toEqual([])
  })
  it('restores the file indentation on the replacement', () => {
    expect(reindent('if (y) {\n  stop()\n}', 'if (x) {\n  go()\n}', '    ')).toBe('    if (y) {\n      stop()\n    }')
    expect(reindent('  z', '  z', '  ')).toBe('  z') // model already had the right indent
  })
})

describe('checkSyntax', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forge-'))
  })
  it('catches broken js and json, passes good files and unknown types', async () => {
    writeFileSync(join(dir, 'ok.js'), 'const a = 1\n')
    writeFileSync(join(dir, 'bad.js'), 'const a = (\n')
    writeFileSync(join(dir, 'ok.json'), '{"a":1}')
    writeFileSync(join(dir, 'bad.json'), '{"a":')
    writeFileSync(join(dir, 'x.md'), '((((')
    expect(await checkSyntax(join(dir, 'ok.js'))).toBeNull()
    expect(await checkSyntax(join(dir, 'bad.js'))).toMatch(/SyntaxError/)
    expect(await checkSyntax(join(dir, 'ok.json'))).toBeNull()
    expect(await checkSyntax(join(dir, 'bad.json'))).not.toBeNull()
    expect(await checkSyntax(join(dir, 'x.md'))).toBeNull()
  })
})

describe('ToolBox edit guards', () => {
  let dir: string
  let box: ToolBox
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forge-'))
    setRoot(dir)
    box = new ToolBox(dir)
  })
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')

  it('applies an edit whose indentation the model got wrong, and fixes the indent', async () => {
    writeFileSync(join(dir, 'a.js'), 'function f() {\n    if (x) {\n        go()\n    }\n}\n')
    await box.run('read_file', { path: 'a.js' })
    const r = await box.run('edit_file', { path: 'a.js', old_text: 'if (x) {\n  go()\n}', new_text: 'if (y) {\n  stop()\n}' })
    expect(r).toMatch(/ignoring whitespace/)
    expect(read('a.js')).toBe('function f() {\n    if (y) {\n      stop()\n    }\n}\n')
  })

  it('refuses a loose match that is ambiguous', async () => {
    writeFileSync(join(dir, 'a.txt'), '  a\n    a\n')
    await box.run('read_file', { path: 'a.txt' })
    expect(await box.run('edit_file', { path: 'a.txt', old_text: 'a', new_text: 'b' })).toMatch(/more than once/)
  })

  it('reverts an edit that breaks syntax and tells the model', async () => {
    writeFileSync(join(dir, 'a.js'), 'const a = 1\n')
    await box.run('read_file', { path: 'a.js' })
    const r = await box.run('edit_file', { path: 'a.js', old_text: 'const a = 1', new_text: 'const a = (' })
    expect(r).toMatch(/syntax error.*NOT applied/s)
    expect(read('a.js')).toBe('const a = 1\n')
    // file is untouched, so the read is still valid and a corrected edit works without re-reading
    expect(await box.run('edit_file', { path: 'a.js', old_text: 'const a = 1', new_text: 'const a = 2' })).toMatch(/^edited/)
  })

  it('does not create a new file that is broken', async () => {
    expect(await box.run('edit_file', { path: 'new.json', old_text: '', new_text: '{"a":' })).toMatch(/NOT applied/)
    expect(existsSync(join(dir, 'new.json'))).toBe(false)
  })

  it('does not blame the edit when the file was already broken', async () => {
    writeFileSync(join(dir, 'a.js'), 'const a = (\nconst b = 1\n')
    await box.run('read_file', { path: 'a.js' })
    const r = await box.run('edit_file', { path: 'a.js', old_text: 'const b = 1', new_text: 'const b = 2' })
    expect(r).toMatch(/already had a syntax error/)
    expect(read('a.js')).toBe('const a = (\nconst b = 2\n')
  })

  it('runs aliased tool names', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hi')
    expect(await box.run('cat', { path: 'a.txt' })).toBe('hi')
  })
})
