import { mkdirSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAll, AUTHOR, git, inTempIndex, restorePaths, savePaths, SECRET_PATH, undoTo, withTempIndex } from '../checkpoint'
import { HISTORY_DIR } from './history'
import type { Task } from './types'

// Isolation for parallel agents: one branch and one working folder (git worktree) per task, merged one at a time into a run branch.
// The user's own folder is not touched until the final approval.

// Never committed, whatever the agent does: dependencies and Forge's own notes. Secrets (SECRET_PATH) are taken out of the index afterwards,
// because a pathspec cannot say "all .env.* except .env.example".
const NOT_COMMITTED = [':(exclude)node_modules', ':(exclude)**/node_modules', ':(exclude).forge-team', `:(exclude)${HISTORY_DIR}`]

// Puts every staged secret back to what HEAD has (or removes it when HEAD has none), so a tracked .env is neither deleted nor changed by a snapshot.
async function dropSecrets(root: string, env?: Record<string, string>): Promise<void> {
  const staged = (await git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames'], env)).split('\0').filter((p) => SECRET_PATH.test(p))
  if (staged.length) await git(root, ['reset', '-q', ...((await head(root)) ? ['HEAD'] : []), '--', ...staged.map((p) => `:(top,literal)${p}`)], env)
}

export async function head(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim()
  } catch {
    return null
  }
}

// A commit holding the project exactly as it is now (uncommitted and new files included, secrets and node_modules not), on top of HEAD.
// With no commit yet the snapshot has no parent: nothing is committed on the user's branch.
export async function snapshotCommit(root: string): Promise<string> {
  const tree = await snapshotTreeWithoutSecrets(root)
  const parent = await head(root)
  return (await git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'forge: team run start'], AUTHOR)).trim()
}

export const snapshotTreeWithoutSecrets = (root: string): Promise<string> =>
  inTempIndex(root, async (env) => {
    await addAll(root, NOT_COMMITTED, env)
    await dropSecrets(root, env)
    return (await git(root, ['write-tree'], env)).trim()
  })

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
  await addAll(wt, NOT_COMMITTED)
  await dropSecrets(wt)
  if (!(await git(wt, ['diff', '--cached', '--name-only'])).trim()) return null // untracked secrets we refused to add do not count
  await git(wt, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', message], AUTHOR)
  return head(wt)
}

export type Changed = Task['changed']
export async function changedSince(wt: string, base: string, tip = 'HEAD'): Promise<Changed> {
  const [names, nums] = await Promise.all([git(wt, ['diff', '-z', '--name-status', '--no-renames', base, tip]), git(wt, ['diff', '-z', '--numstat', '--no-renames', base, tip])])
  const counts = new Map<string, [number, number]>()
  for (const l of nums.split('\0').filter(Boolean)) {
    const [a, r, ...p] = l.split('\t')
    counts.set(p.join('\t'), [a === '-' ? 0 : +a, r === '-' ? 0 : +r])
  }
  const t = names.split('\0').filter(Boolean)
  const out: Changed = []
  for (let i = 0; i + 1 < t.length; i += 2) {
    const [added, removed] = counts.get(t[i + 1]) ?? [0, 0]
    out.push({ path: t[i + 1], status: t[i] === 'A' ? 'added' : t[i] === 'D' ? 'deleted' : 'modified', added, removed })
  }
  return out
}

export async function diffText(wt: string, base: string, tip = 'HEAD', max = 40_000, path?: string): Promise<string> {
  const d = await git(wt, ['diff', '--no-renames', '--unified=3', base, tip, ...(path ? ['--', path] : [])])
  return d.length > max ? d.slice(0, max) + `\n[diff cut: ${d.length - max} more characters]` : d
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[] }
export async function mergeBranch(wt: string, branch: string, message: string): Promise<MergeResult> {
  try {
    await git(wt, ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-verify', '-m', message, branch], AUTHOR)
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
  await addAll(wt, NOT_COMMITTED)
  await dropSecrets(wt)
  const failed = await git(wt, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--no-edit'], AUTHOR).then(() => '', (e: Error) => e.message)
  // The merge only counts once it is committed: a half-finished one is thrown away before the next task is merged.
  if (await git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false)) return { ok: false, left: [`the merge commit (${failed.slice(0, 200) || 'git left the merge open'})`] }
  return { ok: true, left: [] }
}

export async function removeWorktree(root: string, wt: string, branch?: string) {
  await git(root, ['worktree', 'remove', '--force', wt]).catch(() => rmSync(wt, { recursive: true, force: true }))
  await git(root, ['worktree', 'prune']).catch(() => '')
  if (branch) await git(root, ['branch', '-D', branch]).catch(() => '')
}

export const pruneWorktrees = (root: string) => git(root, ['worktree', 'prune']).then(() => undefined, () => undefined)

// Three-way apply for when the files changed since the run started. It runs in a throwaway index and the folder is written only when it is clean,
// so a conflict leaves no markers behind, and the user's own index is never touched.
async function applyThreeWay(root: string, patch: string): Promise<void> {
  await withTempIndex(root, async (env) => {
    await addAll(root, [':(exclude)node_modules', ':(exclude)**/node_modules'], env)
    const before = (await git(root, ['write-tree'], env)).trim()
    await git(root, ['apply', '--3way', '--cached', '--whitespace=nowarn', patch], env)
    const after = (await git(root, ['write-tree'], env)).trim()
    const t = (await git(root, ['diff-tree', '-r', '-z', '--no-renames', '--relative', '--name-status', before, after])).split('\0').filter(Boolean)
    const gone: string[] = []
    const write: string[] = []
    for (let i = 0; i + 1 < t.length; i += 2) (t[i] === 'D' ? gone : write).push(t[i + 1])
    try {
      for (const p of gone) rmSync(join(root, p), { force: true })
      if (write.length) await restorePaths(root, after, write)
    } catch (e) {
      await undoTo(root, { id: '', tree: before, paths: [...gone, ...write] }).catch(() => [])
      throw e
    }
  })
}

// Puts the team's result into the user's folder as ordinary uncommitted changes (nothing is committed or staged for them).
// With the id of the checkpoint taken just before, Undo of that checkpoint is limited to the files written here.
// `only` (project-relative paths) limits the apply to those files; ponytail: paths go on the command line, which is fine for hundreds of files.
export async function applyResult(root: string, baseCommit: string, branch: string, checkpointId?: string, only?: string[]): Promise<{ ok: boolean; message: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-patch-'))
  const f = join(dir, 'result.patch')
  const lit = only ? ['--literal-pathspecs'] : []
  const spec = only ? ['--', ...only] : []
  try {
    await git(root, [...lit, 'diff', '--binary', '--no-renames', `--output=${f}`, baseCommit, branch, ...spec]) // to a file: a big binary does not fit in git()'s buffer
    if (!statSync(f).size) return { ok: true, message: 'The team made no changes.' }
    const paths = (await git(root, [...lit, 'diff', '--name-only', '-z', '--no-renames', '--relative', baseCommit, branch, ...spec])).split('\0').filter(Boolean)
    let message = 'Applied.'
    try {
      await git(root, ['apply', '--whitespace=nowarn', f])
    } catch {
      try {
        await applyThreeWay(root, f)
        message = 'Applied with a three-way merge because your files changed since the run started.'
      } catch (e) {
        const why = (e as Error).message.split('\n').map((l) => l.trim()).filter((l) => l && !/ cleanly\.?$/.test(l)).join(' ') // git lists every file it applied fine first: only the lines that name a problem matter
        return { ok: false, message: `Could not apply cleanly: ${why.slice(0, 300)}. Nothing in your folder was changed. The result is still on branch ${branch}.` }
      }
    }
    if (checkpointId) await savePaths(root, checkpointId, paths).catch(() => undefined)
    return { ok: true, message }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
