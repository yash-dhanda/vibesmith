import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { SECRET_PATH } from '../checkpoint'
import { redact } from './redact'
import type { Run } from './types'

// Branch, commit, push and pull request for a landed run. Every step is a button the user presses; nothing here runs by itself.
// All commands go through an injectable runner, so tests use real throwaway repositories and a fake `gh`.

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<string> // rejects with the tool's own message
export const defaultRunner: Runner = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANGUAGE: '', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (err, out, stderr) =>
      err ? reject(new Error(stderr.trim() || out.trim() || err.message)) : resolve(out),
    )
  })

export type GitResult = { ok: boolean; message: string; branch?: string; url?: string }
export type GitState = { isRepo: boolean; branch: string | null; defaultBranch: string | null; dirty: boolean; ahead: number; hasRemote: boolean; remoteUrl: string | null; ghReady: boolean }

const ok = async (p: Promise<unknown>) => p.then(() => true, () => false)
const out = (p: Promise<string>) => p.then((s) => s.trim(), () => '')
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const why = (e: unknown) => oneLine(String((e as Error).message ?? e)).slice(0, 400)

// The first line is the goal (72 characters at most, cut at a word), the body lists what was done.
export function commitMessageFor(run: Pick<Run, 'goal' | 'tasks'>): string {
  const goal = oneLine(redact(run.goal)) || 'Changes from a Forge run'
  let title = goal
  if (title.length > 72) {
    const cut = title.slice(0, 71)
    title = (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s,;:.-]+$/, '') + '…'
  }
  const done = run.tasks.filter((t) => t.status === 'done').map((t) => `- ${oneLine(redact(t.title)).slice(0, 120)}`)
  return done.length ? `${title}\n\n${done.join('\n')}\n` : `${title}\n`
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
export const branchFor = (run: Pick<Run, 'id' | 'goal'>) => `forge/${slug(run.goal) || 'run'}-${run.id.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}`
export const isProtected = (b: string) => /^(main|master|develop|release\/.*)$/.test(b)

// host/owner/repo only: no scheme, no user name, no token, whatever form the remote is written in.
export function cleanRemote(url: string): string {
  const u = url.trim().replace(/\.git\/?$/, '')
  const m = u.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i) ?? u.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/)
  if (m && !/^[A-Za-z]$/.test(m[1])) return `${m[1]}/${m[2]}`
  return u.split(/[\\/]/).slice(-2).join('/') // a local path: only its last two names
}

export async function gitState(project: string, run: Runner = defaultRunner): Promise<GitState> {
  const g = (...a: string[]) => out(run('git', a, project))
  const none: GitState = { isRepo: false, branch: null, defaultBranch: null, dirty: false, ahead: 0, hasRemote: false, remoteUrl: null, ghReady: false }
  if (!(await ok(run('git', ['rev-parse', '--git-dir'], project)))) return none
  const [branch, originHead, dirty, remote, ahead, gh] = await Promise.all([
    g('symbolic-ref', '--short', '-q', 'HEAD'),
    g('symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'),
    g('status', '--porcelain'),
    g('remote', 'get-url', 'origin'),
    g('rev-list', '--count', 'HEAD', '--not', '--remotes'), // commits no remote has yet
    ok(run('gh', ['--version'], project)).then((v) => v && ok(run('gh', ['auth', 'status'], project))),
  ])
  let defaultBranch = originHead.replace(/^origin\//, '') || null
  if (!defaultBranch) for (const b of ['main', 'master']) if (await ok(run('git', ['rev-parse', '--verify', '-q', `refs/heads/${b}`], project))) { defaultBranch = b; break }
  return { isRepo: true, branch: branch || null, defaultBranch, dirty: !!dirty, ahead: Number(ahead) || 0, hasRemote: !!remote, remoteUrl: remote ? cleanRemote(remote) : null, ghReady: gh }
}

// A new branch from the current HEAD holding exactly the files the run changed. Never the default branch, never other people's staged work.
export async function commitRun(project: string, runRec: Run, run: Runner = defaultRunner): Promise<GitResult> {
  const fail = (message: string): GitResult => ({ ok: false, message })
  if (!runRec.applied) return fail('Land the run first, then commit it.')
  const g = (...a: string[]) => run('git', a, project)
  if (!(await ok(g('rev-parse', '--git-dir')))) return fail('This project is not a git repository.')
  if (!(await ok(g('rev-parse', '--verify', '-q', 'HEAD')))) return fail('This repository has no commits yet. Make a first commit yourself, then commit the run.')
  const prefix = (await out(g('rev-parse', '--show-prefix'))).replace(/\\/g, '/')
  const wanted = [...new Set(runRec.final?.files.map((f) => prefix + f.path.replace(/\\/g, '/')) ?? [])]
    .filter((p) => !p.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(p) && !SECRET_PATH.test(p))
  const spec = (ps: string[]) => ps.map((p) => `:(top,literal)${p}`)
  const changed = new Set<string>()
  if (wanted.length) for (const rec of (await g('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', ...spec(wanted))).split('\0')) if (rec.length > 3) changed.add(rec.slice(3))
  const staged = (await g('diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean)
  const stray = staged.filter((p) => !wanted.includes(p))
  if (stray.length) return fail(`Other changes are already staged (${stray.slice(0, 3).join(', ')}${stray.length > 3 ? ` and ${stray.length - 3} more` : ''}). Commit or unstage them first so they are not swept in.`)
  const stage = wanted.filter((p) => changed.has(p) || staged.includes(p))
  if (!stage.length) return fail('Nothing to commit: the run’s files match the last commit.')

  const was = await out(g('symbolic-ref', '--short', '-q', 'HEAD'))
  const branch = branchFor(runRec)
  try {
    await g('checkout', '-q', '-b', branch)
  } catch (e) {
    return fail(`Could not create the branch ${branch}: ${why(e)}`)
  }
  try {
    await g('add', '-A', '--', ...spec(stage))
    await g('commit', '-q', '-m', commitMessageFor(runRec)) // the repository's own user and hooks apply; no trailers added
  } catch (e) {
    // Put things back as they were: the old branch, nothing staged, no half-made branch.
    await g('reset', '-q', '--', ...spec(stage)).catch(() => {})
    await g('checkout', '-q', was || '--detach').catch(() => {})
    await g('branch', '-D', branch).catch(() => {})
    return fail(`The commit failed: ${why(e)}`)
  }
  return { ok: true, branch, message: `Committed ${stage.length} file${stage.length === 1 ? '' : 's'} on ${branch}.` }
}

export async function pushBranch(project: string, branch: string, run: Runner = defaultRunner): Promise<GitResult> {
  if (!/^[\w][\w./-]{0,200}$/.test(branch) || branch.includes('..')) return { ok: false, message: 'That is not a branch name Forge will push.' }
  if (isProtected(branch)) return { ok: false, message: `Forge does not push ${branch}. Commit to a branch of its own first.` }
  try {
    await run('git', ['push', '-u', 'origin', branch], project) // never --force
    return { ok: true, branch, message: `Pushed ${branch} to origin.` }
  } catch (e) {
    return { ok: false, branch, message: why(e) }
  }
}

// Paths on this computer mean nothing to a reviewer (and say who the user is): inside the project they become relative, anywhere else only the name stays.
export function withoutPaths(text: string, project: string): string {
  const root = project.replace(/\\/g, '/').replace(/\/+$/, '')
  return text.replace(/(?<![\w/.:~-])(?:[A-Za-z]:[\\/]|\/)[^\s"'`)\]>]+/g, (m) => {
    const p = m.replace(/\\/g, '/')
    return p.startsWith(root + '/') ? p.slice(root.length + 1) : basename(p.replace(/[.,;:]+$/, ''))
  })
}

export const prBodyFor = (run: Pick<Run, 'final' | 'project'>) => {
  const f = run.final
  const check = f?.verifyOk === true ? 'The project check passed.' : f?.verifyOk === false ? 'The project check failed.' : ''
  return withoutPaths([redact(f?.report ?? ''), check].filter(Boolean).join('\n\n') || 'Changes from a Forge run.', run.project)
}

export async function openPr(project: string, branch: string, title: string, body: string, run: Runner = defaultRunner): Promise<GitResult> {
  if (isProtected(branch)) return { ok: false, message: `Forge does not open a pull request from ${branch}.` }
  try {
    const text = await run('gh', ['pr', 'create', '--head', branch, '--title', oneLine(title).slice(0, 200), '--body', withoutPaths(body, project)], project)
    const url = text.match(/https?:\/\/\S+/g)?.at(-1)
    return url ? { ok: true, branch, url, message: 'Pull request opened.' } : { ok: false, branch, message: oneLine(text) || 'GitHub did not say where the pull request is.' }
  } catch (e) {
    return { ok: false, branch, message: why(e) }
  }
}
