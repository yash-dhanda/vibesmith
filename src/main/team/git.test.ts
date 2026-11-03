import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
})
