import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { changesSince, createCheckpoint, diffOf, fileAt, initRepo, isRepo, restorePaths, treeChanges, undoFile, undoTo } from './checkpoint'

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
  it('takes a checkpoint when .gitignore already lists node_modules, and still leaves it out', async () => {
    w('.gitignore', 'ignored.txt\nnode_modules\n')
    w('new.txt', 'fresh\n')
    const c = await createCheckpoint(dir)
    const files = git('ls-tree', '-r', '--name-only', c.tree)
    expect(files).toContain('new.txt')
    expect(files).not.toContain('node_modules')
  })

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

  it('fileAt and diffOf show how a file was and what changed', async () => {
    const cp = await createCheckpoint(dir)
    w('edit.txt', 'one\nTWO\n')
    w('fresh.txt', 'new')
    expect(await fileAt(dir, cp, 'edit.txt')).toBe('one\ntwo\n')
    expect(await fileAt(dir, cp, 'fresh.txt')).toBeNull()
    expect(await fileAt(dir, cp, '../etc/passwd')).toBeNull()
    const d = await diffOf(dir, cp, 'edit.txt')
    expect(d).toContain('-two')
    expect(d).toContain('+TWO')
    expect(await diffOf(dir, cp, '../x')).toBe('')
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

  it('undo touches only the files the run changed, not what the user did afterwards', async () => {
    const cp = await createCheckpoint(dir)
    w('edit.txt', 'agent\n')
    expect((await changesSince(dir, cp)).map((c) => c.path)).toEqual(['edit.txt'])
    w('mine.md', 'written by hand\n')
    w('keep.txt', 'edited by hand\n')
    expect(await undoTo(dir, cp)).toEqual(['edit.txt'])
    expect(r('edit.txt')).toBe('one\ntwo\n')
    expect(r('mine.md')).toBe('written by hand\n')
    expect(r('keep.txt')).toBe('edited by hand\n')
  })

  it('still reads English git messages under another locale', async () => {
    w('.gitignore', 'node_modules\n')
    const old = { LANGUAGE: process.env.LANGUAGE, LANG: process.env.LANG }
    process.env.LANGUAGE = 'de'
    process.env.LANG = 'de_DE.UTF-8'
    try {
      expect((await createCheckpoint(dir)).tree).toBeTruthy()
    } finally {
      for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    }
  })

  it('puts back an ignored .env the run rewrote', async () => {
    w('.gitignore', 'ignored.txt\n.env\n')
    w('.env', 'KEY=real\n')
    const cp = await createCheckpoint(dir)
    w('.env', 'KEY=your-key-here\n')
    w('edit.txt', 'x\n')
    expect((await changesSince(dir, cp)).map((c) => c.path).sort()).toEqual(['.env', 'edit.txt'])
    await undoTo(dir, cp)
    expect(r('.env')).toBe('KEY=real\n')
  })

  it('undoes a run that swapped a folder for a file, and a file for a folder', async () => {
    w('foo/bar.txt', 'in a folder\n')
    w('flat', 'a file\n')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x')
    const cp = await createCheckpoint(dir)
    rmSync(join(dir, 'foo'), { recursive: true })
    w('foo', 'now a file\n')
    rmSync(join(dir, 'flat'))
    w('flat/inner.txt', 'now a folder\n')
    await undoTo(dir, cp)
    expect(r('foo/bar.txt')).toBe('in a folder\n')
    expect(r('flat')).toBe('a file\n')
  })

  it('a failing git does not crash on a large input', async () => {
    const caught: Error[] = []
    const on = (e: Error) => caught.push(e)
    process.on('uncaughtException', on)
    for (let i = 0; i < 3; i++) await restorePaths(dir, '0'.repeat(40), Array.from({ length: 50_000 }, (_, n) => `dir/file-${n}.txt`)).catch(() => {})
    await new Promise((res) => setTimeout(res, 50))
    process.off('uncaughtException', on)
    expect(caught).toEqual([])
  })

  it('handles file names with quotes and backslashes', async () => {
    w('say "hi".txt', 'a\n')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x')
    const cp = await createCheckpoint(dir)
    w('say "hi".txt', 'b\n')
    w('plain.txt', 'p\n')
    w('back\\slash.txt', 'c\n')
    expect((await changesSince(dir, cp)).map((c) => c.path).sort()).toEqual(['back\\slash.txt', 'plain.txt', 'say "hi".txt'])
    await undoTo(dir, cp)
    expect(r('say "hi".txt')).toBe('a\n')
    expect(existsSync(join(dir, 'plain.txt')) || existsSync(join(dir, 'back\\slash.txt'))).toBe(false)
  })

  it('undo of a very large run does not overflow the command line, and restores before deleting', async () => {
    for (let i = 0; i < 20_000; i++) w(`big/${'d'.repeat(150)}-${i}.txt`, '')
    w('big/note.txt', 'n\n')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x')
    const cp = await createCheckpoint(dir)
    rmSync(join(dir, 'big'), { recursive: true })
    w('agent-added.txt', 'a')
    await undoTo(dir, cp)
    expect(r('big/note.txt')).toBe('n\n')
    expect(existsSync(join(dir, 'agent-added.txt'))).toBe(false)
  }, 60_000)

  it('keeps empty folders that existed before the run', async () => {
    mkdirSync(join(dir, 'uploads'))
    mkdirSync(join(dir, 'logs/2026'), { recursive: true })
    const cp = await createCheckpoint(dir)
    w('uploads/a.txt', 'a')
    w('logs/2026/b.txt', 'b')
    w('fresh/dir/c.txt', 'c')
    await undoTo(dir, cp)
    expect(existsSync(join(dir, 'uploads'))).toBe(true)
    expect(existsSync(join(dir, 'logs/2026'))).toBe(true)
    expect(existsSync(join(dir, 'fresh'))).toBe(false)
  })

  it('treats a name starting with two dots as an ordinary file', async () => {
    const cp = await createCheckpoint(dir)
    w('..notes.txt', 'n\n')
    expect(await fileAt(dir, cp, '..notes.txt')).toBeNull()
    await undoTo(dir, cp)
    expect(existsSync(join(dir, '..notes.txt'))).toBe(false)
    w('..kept.txt', 'k\n')
    const cp2 = await createCheckpoint(dir)
    w('..kept.txt', 'changed\n')
    expect(await fileAt(dir, cp2, '..kept.txt')).toBe('k\n')
    expect(await diffOf(dir, cp2, '..kept.txt')).toContain('+changed')
  })

  it('snapshots the working files, not a stale or staged index', async () => {
    git('add', 'edit.txt')
    w('edit.txt', 'later\n')
    git('add', 'gone.txt')
    rmSync(join(dir, 'gone.txt'))
    const cp = await createCheckpoint(dir)
    expect(git('show', `${cp.tree}:edit.txt`)).toBe('later\n')
    expect(git('ls-tree', '-r', '--name-only', cp.tree)).not.toContain('gone.txt')
  })

  it('undoes a directory turned into a file, and a file turned into a directory', async () => {
    w('d2f/inner.txt', 'in\n')
    w('f2d', 'was a file\n')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x')
    const cp = await createCheckpoint(dir)
    rmSync(join(dir, 'd2f'), { recursive: true })
    w('d2f', 'now a file\n')
    rmSync(join(dir, 'f2d'))
    w('f2d/inner.txt', 'now a folder\n')
    await undoTo(dir, cp)
    expect(r('d2f/inner.txt')).toBe('in\n')
    expect(r('f2d')).toBe('was a file\n')
  })

  it('does not crash when git exits before reading a large path list', async () => {
    const errors: unknown[] = []
    const on = (e: unknown) => errors.push(e)
    process.on('uncaughtException', on)
    try {
      const paths = Array.from({ length: 50_000 }, (_, i) => `${'p'.repeat(100)}${i}`)
      await expect(restorePaths(dir, '0'.repeat(40), paths)).rejects.toThrow()
      await new Promise((res) => setTimeout(res, 50))
    } finally {
      process.off('uncaughtException', on)
    }
    expect(errors).toEqual([])
  })

  it('keeps the contents of secrets out of the text that describes a run', async () => {
    w('.gitignore', 'ignored.txt\n.env\n')
    w('.env', 'KEY=real\n')
    const cp = await createCheckpoint(dir)
    w('.env', 'KEY=other\n')
    expect((await changesSince(dir, cp)).map((c) => c.path)).toEqual(['.env'])
    expect(await diffOf(dir, cp, '.env')).toBe('')
  })

  it('treeChanges compares any two checkpoints, and a checkpoint can carry its own message', async () => {
    const a = await createCheckpoint(dir)
    w('edit.txt', 'one\nTWO\n')
    const b = await createCheckpoint(dir, 'custom message')
    expect(await treeChanges(dir, a.tree, b.tree)).toEqual([{ path: 'edit.txt', status: 'modified', added: 1, removed: 1 }])
    expect(git('log', '-1', '--format=%s', `refs/forge/${b.id}`).trim()).toBe('custom message')
  })
})
