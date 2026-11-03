import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { changesSince, createCheckpoint, initRepo, isRepo, undoFile, undoTo } from './checkpoint'

let dir: string
const w = (f: string, t: string) => {
  mkdirSync(join(dir, f, '..'), { recursive: true })
  writeFileSync(join(dir, f), t)
}
const r = (f: string) => readFileSync(join(dir, f), 'utf8')
const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-git-'))
  await initRepo(dir)
  w('.gitignore', 'ignored.txt\n')
  w('keep.txt', 'keep\n')
  w('edit.txt', 'one\ntwo\n')
  w('gone.txt', 'bye\n')
  w('untracked.txt', 'never committed\n')
  w('ignored.txt', 'secret\n')
  w('node_modules/x/index.js', 'big')
})

describe('checkpoint', () => {
  it('detects a repo, and a plain folder', async () => {
    expect(await isRepo(dir)).toBe(true)
    expect(await isRepo(mkdtempSync(join(tmpdir(), 'forge-plain-')))).toBe(false)
  })

  it('reports no changes when nothing changed', async () => {
    const cp = await createCheckpoint(dir)
    expect(await changesSince(dir, cp)).toEqual([])
  })

  it('summarises added, modified and deleted files with line counts', async () => {
    const cp = await createCheckpoint(dir)
    w('edit.txt', 'one\nTWO\nthree\n')
    rmSync(join(dir, 'gone.txt'))
    w('src/new.js', 'a\nb\n')
    const list = await changesSince(dir, cp)
    expect(list.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'edit.txt', status: 'modified', added: 2, removed: 1 },
      { path: 'gone.txt', status: 'deleted', added: 0, removed: 1 },
      { path: 'src/new.js', status: 'added', added: 2, removed: 0 },
    ])
  })

  it('undoFile puts back one file and leaves the rest of the run alone', async () => {
    const cp = await createCheckpoint(dir)
    w('edit.txt', 'changed\n')
    w('new.js', 'x')
    const left = await undoFile(dir, cp, 'edit.txt')
    expect(r('edit.txt')).toBe('one\ntwo\n')
    expect(r('new.js')).toBe('x')
    expect(left.map((c) => c.path)).toEqual(['new.js'])
    await undoFile(dir, cp, 'new.js')
    expect(existsSync(join(dir, 'new.js'))).toBe(false)
  })

  it('undo restores everything, removes created files and empty dirs, keeps untracked and ignored files', async () => {
    const cp = await createCheckpoint(dir)
    w('edit.txt', 'changed\n')
    w('untracked.txt', 'agent touched this\n')
    rmSync(join(dir, 'gone.txt'))
    w('deep/er/new.js', 'x')
    w('ignored.txt', 'agent touched ignored\n')
    const touched = await undoTo(dir, cp)
    expect(touched.sort()).toEqual(['deep/er/new.js', 'edit.txt', 'gone.txt', 'untracked.txt'])
    expect(r('edit.txt')).toBe('one\ntwo\n')
    expect(r('gone.txt')).toBe('bye\n')
    expect(r('untracked.txt')).toBe('never committed\n') // untracked files are snapshotted too
    expect(existsSync(join(dir, 'deep'))).toBe(false)
    expect(r('ignored.txt')).toBe('agent touched ignored\n') // ignored files are outside the snapshot
    expect(await changesSince(dir, cp)).toEqual([])
  })

  it('leaves the user index, branches and stash alone', async () => {
    git('add', 'keep.txt')
    const before = git('status', '--porcelain') + git('branch', '-a') + git('stash', 'list')
    const cp = await createCheckpoint(dir)
    w('edit.txt', 'x\n')
    await undoTo(dir, cp)
    expect(git('status', '--porcelain') + git('branch', '-a') + git('stash', 'list')).toBe(before)
    expect(git('for-each-ref', 'refs/forge')).toContain(`refs/forge/${cp.id}`)
  })

  it('works in a subfolder of a bigger repo and ignores files outside it', async () => {
    mkdirSync(join(dir, 'app'))
    w('app/a.txt', 'a\n')
    w('outside.txt', 'o\n')
    const app = join(dir, 'app')
    const cp = await createCheckpoint(app)
    w('app/a.txt', 'changed\n')
    w('outside.txt', 'changed too\n')
    expect((await changesSince(app, cp)).map((c) => c.path)).toEqual(['a.txt'])
    await undoTo(app, cp)
    expect(r('app/a.txt')).toBe('a\n')
    expect(r('outside.txt')).toBe('changed too\n')
  })

  it('handles file names with spaces and unicode', async () => {
    const cp = await createCheckpoint(dir)
    w('my file é.txt', 'hi\n')
    expect((await changesSince(dir, cp)).map((c) => c.path)).toEqual(['my file é.txt'])
    await undoTo(dir, cp)
    expect(existsSync(join(dir, 'my file é.txt'))).toBe(false)
  })
})
