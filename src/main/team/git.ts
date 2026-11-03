import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTHOR, git, snapshotTree } from '../checkpoint'
import type { Task } from './types'

// Isolation for parallel agents: one branch and one working folder (git worktree) per task, merged one at a time into a run branch.
// The user's own folder is not touched until the final approval.

// Never committed, whatever the agent does: real secrets and dependencies. Templates like .env.example are still shared.
const SECRET_FILES = ['.env', '.env.local', '.env.production', '.env.development', '.env.staging', '.env.test', '.env.*.local', '*.pem', 'id_rsa', 'id_ed25519', '.npmrc', '.pypirc']
const NOT_COMMITTED = [':(exclude)node_modules', ':(exclude)**/node_modules', ':(exclude).forge-team', ...SECRET_FILES.map((f) => `:(exclude,glob)**/${f}`)]

export async function head(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim()
  } catch {
    return null
  }
}

// A commit holding the project exactly as it is now (uncommitted and new files included, secrets and node_modules not), on top of HEAD.
export async function snapshotCommit(root: string): Promise<string> {
  if (!(await head(root))) await git(root, ['commit', '--allow-empty', '--no-verify', '-m', 'forge: initial commit'], AUTHOR)
  const tree = await snapshotTreeWithoutSecrets(root)
  const parent = (await head(root))!
  return (await git(root, ['commit-tree', tree, '-p', parent, '-m', 'forge: team run start'], AUTHOR)).trim()
}

export async function snapshotTreeWithoutSecrets(root: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-team-idx-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    await git(root, ['add', '-A', '--', '.', ...NOT_COMMITTED], env)
    return (await git(root, ['write-tree'], env)).trim()
  } catch {
    return snapshotTree(root)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function createRunBranch(root: string, branch: string, baseCommit: string, worktree: string) {
  mkdirSync(join(worktree, '..'), { recursive: true })
  await git(root, ['worktree', 'add', '-b', branch, worktree, baseCommit])
}

export async function addTaskWorktree(root: string, worktree: string, branch: string, from: string) {
  mkdirSync(join(worktree, '..'), { recursive: true })
  if (existsSync(worktree)) return
  const exists = await git(root, ['rev-parse', '--verify', `refs/heads/${branch}`]).then(() => true, () => false)
  await git(root, exists ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, from])
}

// Commits whatever the agent left in its worktree. Returns the commit, or null when nothing changed.
export async function commitAll(wt: string, message: string): Promise<string | null> {
  await git(wt, ['add', '-A', '--', '.', ...NOT_COMMITTED])
  if (!(await git(wt, ['diff', '--cached', '--name-only'])).trim()) return null // untracked secrets we refused to add do not count
  await git(wt, ['commit', '--no-verify', '-m', message], AUTHOR)
  return head(wt)
}

export type Changed = Task['changed']
export async function changedSince(wt: string, base: string, tip = 'HEAD'): Promise<Changed> {
  const [names, nums] = await Promise.all([git(wt, ['diff', '--name-status', '--no-renames', base, tip]), git(wt, ['diff', '--numstat', '--no-renames', base, tip])])
  const counts = new Map<string, [number, number]>()
  for (const l of nums.split('\n').filter(Boolean)) {
    const [a, r, ...p] = l.split('\t')
    counts.set(p.join('\t'), [a === '-' ? 0 : +a, r === '-' ? 0 : +r])
  }
  return names.split('\n').filter(Boolean).map((l) => {
    const [s, ...p] = l.split('\t')
    const path = p.join('\t')
    const [added, removed] = counts.get(path) ?? [0, 0]
    return { path, status: s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified', added, removed } as Changed[number]
  })
}

export async function diffText(wt: string, base: string, tip = 'HEAD', max = 40_000, path?: string): Promise<string> {
  const d = await git(wt, ['diff', '--no-renames', '--unified=3', base, tip, ...(path ? ['--', path] : [])])
  return d.length > max ? d.slice(0, max) + `\n[diff cut: ${d.length - max} more characters]` : d
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[] }
export async function mergeBranch(wt: string, branch: string, message: string): Promise<MergeResult> {
  try {
    await git(wt, ['merge', '--no-ff', '--no-verify', '-m', message, branch], AUTHOR)
    return { ok: true }
  } catch (e) {
    const conflicts = await conflictFiles(wt)
    if (conflicts.length) return { ok: false, conflicts }
    await abortMerge(wt)
    throw e
  }
}
export const conflictFiles = async (wt: string): Promise<string[]> => (await git(wt, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean)
export const abortMerge = (wt: string) => git(wt, ['merge', '--abort']).catch(() => '')

// After an agent edited the conflicted files: no markers left in any file, then stage and commit the merge.
export async function finishMerge(wt: string): Promise<{ ok: boolean; left: string[] }> {
  const marked = (await git(wt, ['grep', '-l', '-I', '-E', '^(<<<<<<<|>>>>>>>)( |$)', '--', '.']).catch(() => '')).split('\n').filter(Boolean)
  const stillConflicted = (await conflictFiles(wt)).filter((f) => marked.includes(f))
  const left = [...new Set([...marked, ...stillConflicted])]
  if (left.length) return { ok: false, left }
  await git(wt, ['add', '-A', '--', '.', ...NOT_COMMITTED])
  await git(wt, ['commit', '--no-verify', '--no-edit'], AUTHOR).catch(() => '')
  return { ok: true, left: [] }
}

export async function removeWorktree(root: string, wt: string, branch?: string) {
  await git(root, ['worktree', 'remove', '--force', wt]).catch(() => rmSync(wt, { recursive: true, force: true }))
  await git(root, ['worktree', 'prune']).catch(() => '')
  if (branch) await git(root, ['branch', '-D', branch]).catch(() => '')
}

export const pruneWorktrees = (root: string) => git(root, ['worktree', 'prune']).then(() => undefined, () => undefined)

// Puts the team's result into the user's folder as ordinary uncommitted changes (nothing is committed for them).
export async function applyResult(root: string, baseCommit: string, branch: string): Promise<{ ok: boolean; message: string }> {
  const patch = await git(root, ['diff', '--binary', '--no-renames', baseCommit, branch])
  if (!patch.trim()) return { ok: true, message: 'The team made no changes.' }
  const f = join(mkdtempSync(join(tmpdir(), 'forge-patch-')), 'result.patch')
  writeFileSync(f, patch)
  try {
    await git(root, ['apply', '--whitespace=nowarn', f])
    return { ok: true, message: 'Applied.' }
  } catch {
    try {
      await git(root, ['apply', '--3way', '--whitespace=nowarn', f])
      return { ok: true, message: 'Applied with a three-way merge because your files changed since the run started.' }
    } catch (e) {
      return { ok: false, message: `Could not apply cleanly: ${(e as Error).message.slice(0, 300)}. The result is still on branch ${branch}.` }
    }
  } finally {
    rmSync(join(f, '..'), { recursive: true, force: true })
  }
}
