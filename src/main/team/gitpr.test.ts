import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { branchFor, cleanRemote, commitMessageFor, commitRun, defaultRunner, gitState, openPr, prBodyFor, pushBranch, type Runner } from './gitpr'
import type { Run } from './types'

const made: string[] = []
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d }
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

// A working repo with one commit on main and a bare repository as origin.
function setup() {
  const bare = tmp('forge-gp-bare-')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  const dir = tmp('forge-gp-')
  sh(dir, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test User'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) sh(dir, 'config', k, v)
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  writeFileSync(join(dir, 'other.txt'), 'other\n')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', 'init')
  sh(dir, 'remote', 'add', 'origin', bare)
  sh(dir, 'push', '-q', '-u', 'origin', 'main')
  return { dir, bare }
}
const run = (project: string, files: string[], over: Partial<Run> = {}): Run =>
  ({
    id: 'run-abc123def456', project, goal: 'Add a dark mode toggle to the settings page', applied: true,
    tasks: [{ title: 'Add the toggle', status: 'done' }, { title: 'Skipped thing', status: 'failed' }, { title: 'Wire it to storage', status: 'done' }],
    final: { report: `Done. Changed ${project}/a.txt and see /etc/hosts for details.`, files: files.map((path) => ({ path, status: 'modified', added: 1, removed: 0 })), verifyOk: true, verifyOutput: '', reviewNotes: [] },
    ...over,
  }) as unknown as Run

describe('commit message', () => {
  it('keeps the first line short and lists done tasks without attribution', () => {
    const long = 'word '.repeat(40)
    const m = commitMessageFor({ goal: long, tasks: run('/x', []).tasks })
    expect(m.split('\n')[0].length).toBeLessThanOrEqual(72)
    expect(m).toContain('- Add the toggle')
    expect(m).toContain('- Wire it to storage')
    expect(m).not.toContain('Skipped thing')
    expect(m).not.toMatch(/co-authored|generated|claude/i)
  })
  it('names the branch from the goal and the run id', () => {
    expect(branchFor({ id: 'run-abc123def456', goal: 'Add a dark mode toggle!!' })).toBe('forge/add-a-dark-mode-toggle-def456')
  })
  it('shows only host/owner/repo for a remote', () => {
    expect(cleanRemote('https://user:tok3n@github.com/me/proj.git')).toBe('github.com/me/proj')
    expect(cleanRemote('git@github.com:me/proj.git')).toBe('github.com/me/proj')
    expect(cleanRemote('/home/yash/secret/place/proj.git')).toBe('place/proj')
  })
})

describe('commitRun', () => {
  it('branches off HEAD, not the default branch, and stages only the run files', async () => {
    const { dir } = setup()
    const head = sh(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'other.txt'), 'edited by hand\n') // not part of the run
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    writeFileSync(join(dir, '.env'), 'TOKEN=x\n')
    const r = await commitRun(dir, run(dir, ['a.txt', 'new.txt', '.env', 'missing.txt']))
    expect(r.ok).toBe(true)
    expect(r.branch).toBe('forge/add-a-dark-mode-toggle-to-the-settings-p-def456')
    expect(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(r.branch)
    expect(sh(dir, 'rev-parse', 'HEAD~1')).toBe(head)
    expect(sh(dir, 'rev-parse', 'main')).toBe(head)
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['a.txt', 'new.txt'])
    expect(sh(dir, 'status', '--porcelain')).toContain('M other.txt') // the hand edit is still uncommitted
    const body = sh(dir, 'log', '-1', '--format=%an <%ae>%n%B')
    expect(body).toContain('Test User <test@example.com>')
    expect(body).toContain('- Add the toggle')
    expect(body).not.toMatch(/co-authored|generated/i)
  })

  it('refuses when other changes are already staged, and leaves everything as it was', async () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    writeFileSync(join(dir, 'other.txt'), 'staged by someone\n')
    sh(dir, 'add', 'other.txt')
    const r = await commitRun(dir, run(dir, ['a.txt']))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/already staged \(other\.txt\)/)
    expect(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(sh(dir, 'branch', '--list', 'forge/*')).toBe('')
  })

  it('refuses when nothing changed, when the run is not landed, and when there are no commits', async () => {
    const { dir } = setup()
    expect((await commitRun(dir, run(dir, ['a.txt']))).message).toMatch(/Nothing to commit/)
    expect((await commitRun(dir, run(dir, ['a.txt'], { applied: false }))).message).toMatch(/Land the run first/)
    const empty = tmp('forge-gp-empty-')
    sh(empty, 'init', '-q')
    expect((await commitRun(empty, run(empty, ['a.txt']))).message).toMatch(/no commits yet/)
    const plain = tmp('forge-gp-plain-')
    expect((await commitRun(plain, run(plain, ['a.txt']))).message).toMatch(/not a git repository/)
  })

  it('puts things back when the commit fails', async () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho no >&2\nexit 1\n', { mode: 0o755 })
    const r = await commitRun(dir, run(dir, ['a.txt']))
    expect(r.ok).toBe(false)
    expect(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(sh(dir, 'branch', '--list', 'forge/*')).toBe('')
    expect(sh(dir, 'diff', '--cached', '--name-only')).toBe('')
  })
})

describe('push and state', () => {
  it('pushes the branch to a bare remote and reports the state', async () => {
    const { dir, bare } = setup()
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const c = await commitRun(dir, run(dir, ['a.txt']))
    const fake: Runner = (cmd, args, cwd) => (cmd === 'gh' ? Promise.resolve('') : defaultRunner(cmd, args, cwd))
    const before = await gitState(dir, fake)
    expect(before).toMatchObject({ isRepo: true, branch: c.branch, defaultBranch: 'main', dirty: false, ahead: 1, hasRemote: true, ghReady: true })
    expect(before.remoteUrl).not.toContain(tmpdir())
    const p = await pushBranch(dir, c.branch!)
    expect(p.ok).toBe(true)
    expect(sh(bare, 'branch', '--list', c.branch!)).toContain(c.branch)
    expect((await gitState(dir, fake)).ahead).toBe(0)
    expect((await gitState(dir, (cmd, a, cwd) => (cmd === 'gh' ? Promise.reject(new Error('x')) : defaultRunner(cmd, a, cwd)))).ghReady).toBe(false)
    expect((await gitState(tmp('forge-gp-none-'))).isRepo).toBe(false)
  })

  it('refuses protected and odd branch names and returns git’s message on failure', async () => {
    const { dir } = setup()
    for (const b of ['main', 'master', 'develop', 'release/1.2']) expect((await pushBranch(dir, b)).ok).toBe(false)
    expect((await pushBranch(dir, '--force')).ok).toBe(false)
    expect((await pushBranch(dir, 'forge/not-there')).message).toMatch(/src refspec|did not match|not-there/)
  })
})

describe('pull request', () => {
  it('sends the report without absolute paths and returns the URL', async () => {
    const { dir } = setup()
    const calls: string[][] = []
    const gh: Runner = async (cmd, args) => { calls.push([cmd, ...args]); return 'Creating pull request\nhttps://github.com/me/proj/pull/7\n' }
    const r = run(dir, ['a.txt'])
    const body = prBodyFor(r)
    const res = await openPr(dir, 'forge/x-abc123', 'Title here', body, gh)
    expect(res).toMatchObject({ ok: true, url: 'https://github.com/me/proj/pull/7' })
    const sent = calls[0]
    expect(sent.slice(0, 5)).toEqual(['gh', 'pr', 'create', '--head', 'forge/x-abc123'])
    const text = sent[sent.indexOf('--body') + 1]
    expect(text).toContain('a.txt')
    expect(text).toContain('hosts')
    expect(text).not.toContain(dir)
    expect(text).not.toContain('/etc')
    expect(text).toContain('The project check passed.')
    expect((await openPr(dir, 'main', 't', 'b', gh)).ok).toBe(false)
    expect((await openPr(dir, 'forge/y', 't', 'b', () => Promise.reject(new Error('gh: not logged in')))).message).toBe('gh: not logged in')
  })
})
