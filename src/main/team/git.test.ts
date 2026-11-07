import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCheckpoint, undoTo } from '../checkpoint'
import { addTaskWorktree, applyResult, changedSince, commitAll, createRunBranch, finishMerge, head, mergeBranch, removeWorktree, snapshotCommit } from './git'

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'forge-g-'))
  sh(d, 'init', '-q')
  writeFileSync(join(d, 'a.txt'), 'one\n')
  sh(d, 'add', '-A')
  sh(d, 'commit', '-q', '-m', 'init')
  return d
}

describe('team git', () => {
  it('snapshots uncommitted work but never secrets, and isolates tasks in worktrees', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'one\ndirty\n')
    writeFileSync(join(root, 'new.txt'), 'new\n')
    writeFileSync(join(root, '.env'), 'TOKEN=real\n')
    writeFileSync(join(root, '.env.example'), 'TOKEN=\n')
    const base = await snapshotCommit(root)
    expect(sh(root, 'show', `${base}:a.txt`)).toContain('dirty')
    expect(sh(root, 'ls-tree', '-r', '--name-only', base)).not.toMatch(/^\.env$/m)
    expect(sh(root, 'ls-tree', '-r', '--name-only', base)).toContain('.env.example')

    const wtDir = mkdtempSync(join(tmpdir(), 'forge-wt-'))
    const integ = join(wtDir, 'integration')
    await createRunBranch(root, 'forge/r1', base, integ)
    const w1 = join(wtDir, 't1'), w2 = join(wtDir, 't2')
    await addTaskWorktree(root, w1, 'forge/r1-t1', 'forge/r1')
    await addTaskWorktree(root, w2, 'forge/r1-t2', 'forge/r1')
    writeFileSync(join(w1, 'one.txt'), '1\n')
    writeFileSync(join(w2, 'two.txt'), '2\n')
    writeFileSync(join(w2, '.env'), 'SECRET=1\n')
    expect(await commitAll(w1, 'task 1')).toBeTruthy()
    expect(await commitAll(w2, 'task 2')).toBeTruthy()
    expect(await commitAll(w2, 'nothing more')).toBeNull()
    expect(sh(w2, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toMatch(/^\.env$/m)
    expect(await changedSince(w1, 'forge/r1')).toEqual([{ path: 'one.txt', status: 'added', added: 1, removed: 0 }])

    expect(await mergeBranch(integ, 'forge/r1-t1', 'merge t1')).toEqual({ ok: true })
    expect(await mergeBranch(integ, 'forge/r1-t2', 'merge t2')).toEqual({ ok: true })
    expect(existsSync(join(integ, 'one.txt')) && existsSync(join(integ, 'two.txt'))).toBe(true)
    expect(existsSync(join(root, 'one.txt'))).toBe(false) // the user's folder is untouched

    const r = await applyResult(root, base, 'forge/r1')
    expect(r.ok).toBe(true)
    expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('1\n')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\ndirty\n')
    await removeWorktree(root, w1, 'forge/r1-t1')
    expect(existsSync(w1)).toBe(false)
  })

  it('reports conflicts, and finishMerge refuses while markers remain', async () => {
    const root = repo()
    const base = await snapshotCommit(root)
    const wtDir = mkdtempSync(join(tmpdir(), 'forge-wt-'))
    const integ = join(wtDir, 'integration')
    await createRunBranch(root, 'forge/r2', base, integ)
    const w1 = join(wtDir, 't1'), w2 = join(wtDir, 't2')
    await addTaskWorktree(root, w1, 'forge/r2-t1', 'forge/r2')
    await addTaskWorktree(root, w2, 'forge/r2-t2', 'forge/r2')
    writeFileSync(join(w1, 'a.txt'), 'from one\n')
    writeFileSync(join(w2, 'a.txt'), 'from two\n')
    await commitAll(w1, 't1')
    await commitAll(w2, 't2')
    expect(await mergeBranch(integ, 'forge/r2-t1', 'm1')).toEqual({ ok: true })
    const m = await mergeBranch(integ, 'forge/r2-t2', 'm2')
    expect(m).toEqual({ ok: false, conflicts: ['a.txt'] })
    expect((await finishMerge(integ)).ok).toBe(false)
    writeFileSync(join(integ, 'a.txt'), 'from one and two\n')
    expect((await finishMerge(integ)).ok).toBe(true)
    expect(readFileSync(join(integ, 'a.txt'), 'utf8')).toBe('from one and two\n')
    expect(await head(integ)).toBeTruthy()
    mkdirSync(join(root, 'x'), { recursive: true })
  })

  const setup = async (name: string) => {
    const root = repo()
    const base = await snapshotCommit(root)
    const wtDir = mkdtempSync(join(tmpdir(), 'forge-wt-'))
    const integ = join(wtDir, 'integration')
    await createRunBranch(root, `forge/${name}`, base, integ)
    return { root, base, integ, wtDir, branch: `forge/${name}` }
  }

  it('a conflicting landing changes nothing in the folder or the index', async () => {
    const { root, base, integ, branch } = await setup('c1')
    writeFileSync(join(integ, 'a.txt'), 'crew\n')
    writeFileSync(join(integ, 'crew-new.txt'), 'n\n')
    await commitAll(integ, 'crew')
    writeFileSync(join(root, 'a.txt'), 'mine\n')
    sh(root, 'commit', '-qam', 'mine')
    const r = await applyResult(root, base, branch)
    expect(r.ok).toBe(false)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('mine\n')
    expect(existsSync(join(root, 'crew-new.txt'))).toBe(false)
    expect(sh(root, 'status', '--porcelain')).toBe('')
  })

  it('a clean three-way landing is not staged, and its Undo only touches the landed files', async () => {
    const { root, base, integ, branch } = await setup('c2')
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    sh(root, 'commit', '-qam', 'more lines')
    const base2 = await snapshotCommit(root)
    await createRunBranch(root, 'forge/c2b', base2, join(integ, '..', 'integ2'))
    const integ2 = join(integ, '..', 'integ2')
    writeFileSync(join(integ2, 'a.txt'), 'ONE\ntwo\nthree\n')
    writeFileSync(join(integ2, 'crew-new.txt'), 'n\n')
    await commitAll(integ2, 'crew')
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nTHREE\n')
    sh(root, 'commit', '-qam', 'mine')
    const cp = await createCheckpoint(root)
    const r = await applyResult(root, base2, 'forge/c2b', cp.id)
    expect(r.message).toContain('three-way')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('ONE\ntwo\nTHREE\n')
    expect(sh(root, 'diff', '--cached', '--name-only')).toBe('')
    writeFileSync(join(root, 'mine.md'), 'hand\n')
    await undoTo(root, { id: cp.id, tree: sh(root, 'rev-parse', `refs/forge/${cp.id}^{tree}`).trim() })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\nTHREE\n')
    expect(existsSync(join(root, 'crew-new.txt'))).toBe(false)
    expect(readFileSync(join(root, 'mine.md'), 'utf8')).toBe('hand\n')
    expect(sh(root, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('a snapshot never deletes tracked secrets from the branch, and leaves out untracked ones', async () => {
    const root = repo()
    writeFileSync(join(root, '.env'), 'A=1\n')
    writeFileSync(join(root, '.npmrc'), 'token=1\n')
    sh(root, 'add', '-A')
    sh(root, 'commit', '-qm', 'tracked secrets')
    writeFileSync(join(root, '.env'), 'A=2\n')
    for (const f of ['.env.prod', '.env.backup', 'server.key', 'cert.p12', 'credentials.json', 'secrets.yaml', 'id_ecdsa', '.netrc']) writeFileSync(join(root, f), 's\n')
    mkdirSync(join(root, '.aws'))
    writeFileSync(join(root, '.aws/credentials'), 's\n')
    writeFileSync(join(root, '.env.example'), 'A=\n')
    sh(root, 'add', '.env.prod') // even a staged one
    const base = await snapshotCommit(root)
    expect(sh(root, 'diff', '--name-status', 'HEAD', base)).toBe('A\t.env.example\n')
    const files = sh(root, 'ls-tree', '-r', '--name-only', base)
    for (const f of ['.env.prod', '.env.backup', 'server.key', 'cert.p12', 'credentials.json', 'secrets.yaml', 'id_ecdsa', '.netrc', '.aws/credentials']) expect(files).not.toContain(f)
    expect(files).toContain('.env.example')
    expect(sh(root, 'show', `${base}:.env`)).toBe('A=1\n')
  })

  it('on a repo with no commits it commits nothing on the user branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-g-'))
    sh(root, 'init', '-q')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    writeFileSync(join(root, '.env'), 'S=1\n')
    sh(root, 'add', '-A')
    const base = await snapshotCommit(root)
    expect(await head(root)).toBeNull()
    expect(sh(root, 'ls-tree', '-r', '--name-only', base).trim()).toBe('a.txt')
  })

  it('does not put the .forge history folder into a snapshot', async () => {
    const root = repo()
    mkdirSync(join(root, '.forge'))
    writeFileSync(join(root, '.forge/what-happened.txt'), 'h\n')
    expect(sh(root, 'ls-tree', '-r', '--name-only', await snapshotCommit(root))).not.toContain('.forge')
  })

  it('finishMerge reports a merge commit that did not happen', async () => {
    const { root, base, integ, wtDir } = await setup('m1')
    const w1 = join(wtDir, 't1'), w2 = join(wtDir, 't2')
    await addTaskWorktree(root, w1, 'forge/m1-t1', 'forge/m1')
    await addTaskWorktree(root, w2, 'forge/m1-t2', 'forge/m1')
    writeFileSync(join(w1, 'a.txt'), 'from one\n')
    writeFileSync(join(w2, 'a.txt'), 'from two\n')
    await commitAll(w1, 't1')
    await commitAll(w2, 't2')
    await mergeBranch(integ, 'forge/m1-t1', 'm1')
    expect((await mergeBranch(integ, 'forge/m1-t2', 'm2')).ok).toBe(false)
    writeFileSync(join(integ, 'a.txt'), 'both\n')
    const hooks = join(resolve(integ, sh(integ, 'rev-parse', '--git-common-dir').trim()), 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'prepare-commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const fin = await finishMerge(integ)
    expect(fin.ok).toBe(false)
    expect(base).toBeTruthy()
  })

  it('internal commits ignore commit.gpgsign', async () => {
    const { root, wtDir } = await setup('g1')
    sh(root, 'config', 'commit.gpgsign', 'true')
    sh(root, 'config', 'gpg.program', '/bin/false')
    const w1 = join(wtDir, 't1')
    await addTaskWorktree(root, w1, 'forge/g1-t1', 'forge/g1')
    writeFileSync(join(w1, 'x.txt'), 'x\n')
    expect(await commitAll(w1, 'x')).toBeTruthy()
  })

  it('applies a result with a large binary', async () => {
    const { root, base, integ, branch } = await setup('b1')
    writeFileSync(join(integ, 'big.bin'), randomBytes(56 * 1024 * 1024))
    await commitAll(integ, 'big')
    expect((await applyResult(root, base, branch)).ok).toBe(true)
    expect(existsSync(join(root, 'big.bin'))).toBe(true)
  }, 60_000)

  it('applies only the files it is given, literally', async () => {
    const { root, base, integ, branch } = await setup('o1')
    writeFileSync(join(integ, 'a.txt'), 'changed\n')
    writeFileSync(join(integ, 'new.txt'), 'new\n')
    writeFileSync(join(integ, '*.txt'), 'star\n') // a name that is a glob must not match the others
    await commitAll(integ, 'work')
    expect((await applyResult(root, base, branch, undefined, ['*.txt'])).ok).toBe(true)
    expect(readFileSync(join(root, '*.txt'), 'utf8')).toBe('star\n')
    expect(existsSync(join(root, 'new.txt'))).toBe(false)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n')
    expect((await applyResult(root, base, branch, undefined, ['new.txt', 'a.txt'])).ok).toBe(true)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('changed\n')
  })
  it('landing again skips what the project already has: deleted files, equal files, and applies only the new ones', async () => {
    const { root, base, integ, branch } = await setup('again1')
    rmSync(join(integ, 'a.txt'))
    writeFileSync(join(integ, 'new.txt'), 'new\n')
    await commitAll(integ, 'work')
    expect((await applyResult(root, base, branch)).ok).toBe(true)
    const again = await applyResult(root, base, branch) // a second landing of the same result, or of a result the folder already matches
    expect(again.ok).toBe(true)
    expect(again.message).toMatch(/already/)
    writeFileSync(join(integ, 'later.txt'), 'later\n') // the run went on after the first landing
    await commitAll(integ, 'more work')
    expect((await applyResult(root, base, branch)).ok).toBe(true)
    expect(readFileSync(join(root, 'later.txt'), 'utf8')).toBe('later\n')
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })
})
