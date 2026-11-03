import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { setRoot } from '../project'
import { ToolBox } from './tools'

let dir: string
let box: ToolBox

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-'))
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(dir, 'dup.txt'), 'x\nx\n')
  mkdirSync(join(dir, 'sub'))
  setRoot(dir)
  box = new ToolBox()
})

describe('ToolBox', () => {
  it('lists and reads', async () => {
    expect(await box.run('list_dir', { path: '.' })).toBe('sub/\na.txt\ndup.txt')
    expect(await box.run('read_file', { path: 'a.txt' })).toBe('one\ntwo\nthree\n')
  })

  it('searches by regex, skips node_modules and binary files', async () => {
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules/x.js'), 'two')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([116, 119, 111, 0, 1]))
    writeFileSync(join(dir, 'sub/b.txt'), 'nothing\ntwo again\n')
    expect(await box.run('search', { pattern: 'tw[o]' })).toBe('a.txt:2: two\nsub/b.txt:2: two again')
    expect(await box.run('search', { pattern: 'zzz' })).toBe('no matches')
    expect(await box.run('search', { pattern: '(' })).toMatch(/invalid regular expression/)
  })

  it('runs commands in the project folder', async () => {
    expect(await box.run('run_command', { command: 'ls' })).toMatch(/a\.txt/)
    expect(await box.run('run_command', { command: 'sudo ls' })).toMatch(/blocked/)
  })

  it('rejects unknown tools and bad args without throwing', async () => {
    expect(await box.run('rm_rf', {})).toMatch(/unknown tool/)
    expect(await box.run('read_file', {})).toMatch(/needs string argument "path"/)
    expect(await box.run('read_file', null)).toMatch(/needs string argument/)
  })

  it('edits after reading, exact match once', async () => {
    await box.run('read_file', { path: 'a.txt' })
    expect(await box.run('edit_file', { path: 'a.txt', old_text: 'two', new_text: '2' })).toMatch(/^edited/)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n2\nthree\n')
  })

  it('refuses edit before read', async () => {
    expect(await box.run('edit_file', { path: 'a.txt', old_text: 'two', new_text: '2' })).toMatch(/read a\.txt first/)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  })

  it('refuses edit when the file changed since the read', async () => {
    await box.run('read_file', { path: 'a.txt' })
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    expect(await box.run('edit_file', { path: 'a.txt', old_text: 'changed', new_text: 'x' })).toMatch(/read a\.txt first/)
  })

  it('fails on no match and on multiple matches', async () => {
    await box.run('read_file', { path: 'a.txt' })
    await box.run('read_file', { path: 'dup.txt' })
    expect(await box.run('edit_file', { path: 'a.txt', old_text: 'nope', new_text: 'x' })).toMatch(/not found/)
    expect(await box.run('edit_file', { path: 'dup.txt', old_text: 'x', new_text: 'y' })).toMatch(/more than once/)
  })

  it('creates a new file only with empty old_text', async () => {
    expect(await box.run('edit_file', { path: 'new.txt', old_text: 'a', new_text: 'b' })).toMatch(/does not exist/)
    expect(await box.run('edit_file', { path: 'sub/new.txt', old_text: '', new_text: 'hi' })).toMatch(/^created/)
    expect(readFileSync(join(dir, 'sub/new.txt'), 'utf8')).toBe('hi')
  })

  it('jails paths: dotdot, absolute, symlink, new file outside', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'forge-out-'))
    writeFileSync(join(outside, 'secret.txt'), 's')
    symlinkSync(outside, join(dir, 'link'))
    expect(await box.run('read_file', { path: '../../../../../../etc/passwd' })).toMatch(/outside project/)
    expect(await box.run('read_file', { path: join(outside, 'secret.txt') })).toMatch(/outside project/)
    expect(await box.run('read_file', { path: 'link/secret.txt' })).toMatch(/outside project/)
    expect(await box.run('edit_file', { path: '../x.txt', old_text: '', new_text: 'x' })).toMatch(/outside project/)
  })
})
