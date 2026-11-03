import { execFile } from 'node:child_process'
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'

// Undo without touching the user's index, branches or stash: a run is snapshotted as a tree built in a throwaway index,
// stored as a commit under refs/forge/. Untracked files are included, .gitignore is respected.

export const AUTHOR = { GIT_AUTHOR_NAME: 'Forge', GIT_AUTHOR_EMAIL: 'forge@localhost', GIT_COMMITTER_NAME: 'Forge', GIT_COMMITTER_EMAIL: 'forge@localhost' }

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(out),
    )
  })
}

export async function hasGit(): Promise<boolean> {
  try {
    await git(process.cwd(), ['--version'])
    return true
  } catch {
    return false
  }
}

export async function isRepo(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--show-toplevel'])
    return true
  } catch {
    return false
  }
}

export const initRepo = (root: string) => git(root, ['init']).then(() => undefined)

export async function snapshotTree(root: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-idx-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    // node_modules is excluded even without a .gitignore: snapshotting it would take minutes
    await git(root, ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude)**/node_modules'], env)
    return (await git(root, ['write-tree'], env)).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export type Checkpoint = { id: string; tree: string }

export async function createCheckpoint(root: string): Promise<Checkpoint> {
  const tree = await snapshotTree(root)
  const commit = (await git(root, ['commit-tree', tree, '-m', 'forge checkpoint'], AUTHOR)).trim()
  const id = `${Date.now()}`
  await git(root, ['update-ref', `refs/forge/${id}`, commit])
  return { id, tree }
}

export type Change = { path: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number }

// What the run changed, relative to the project folder.
export async function changesSince(root: string, cp: Checkpoint): Promise<Change[]> {
  const now = await snapshotTree(root)
  if (now === cp.tree) return []
  const base = ['diff-tree', '-r', '--relative', '--no-renames']
  const [names, nums] = await Promise.all([git(root, [...base, '--name-status', cp.tree, now]), git(root, [...base, '--numstat', cp.tree, now])])
  const counts = new Map<string, [number, number]>()
  for (const line of nums.split('\n').filter(Boolean)) {
    const [a, r, ...p] = line.split('\t')
    counts.set(p.join('\t'), [a === '-' ? 0 : +a, r === '-' ? 0 : +r]) // '-' = binary
  }
  return names
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [s, ...p] = line.split('\t')
      const path = p.join('\t')
      const [added, removed] = counts.get(path) ?? [0, 0]
      return { path, status: s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified', added, removed } as Change
    })
}

// Puts every changed file back: removes files the run created, restores modified and deleted ones.
// ponytail: edits the user made by hand during the run are undone too. Snapshot per file if that bites.
export async function undoTo(root: string, cp: Checkpoint): Promise<string[]> {
  return revert(root, cp, await changesSince(root, cp))
}

// Puts back one file only. Returns what is still changed, so the UI can refresh its list.
export async function undoFile(root: string, cp: Checkpoint, path: string): Promise<Change[]> {
  const list = await changesSince(root, cp)
  await revert(root, cp, list.filter((c) => c.path === path))
  return changesSince(root, cp)
}

async function revert(root: string, cp: Checkpoint, list: Change[]): Promise<string[]> {
  for (const c of list.filter((c) => c.status === 'added')) {
    const p = normalize(c.path)
    if (p.startsWith('..')) continue
    rmSync(join(root, p), { force: true })
    // drop directories the run created and left empty
    for (let d = dirname(join(root, p)); d.length > root.length; d = dirname(d)) {
      try {
        rmdirSync(d) // throws if not empty, which ends the walk
      } catch {
        break
      }
    }
  }
  const restore = list.filter((c) => c.status !== 'added').map((c) => c.path)
  if (restore.length) await git(root, ['restore', `--source=${cp.tree}`, '--worktree', '--', ...restore])
  return list.map((c) => c.path)
}

// A file as it was when the checkpoint was taken, or null if it did not exist then. Paths are relative to the project folder.
export async function fileAt(root: string, cp: Checkpoint, path: string): Promise<string | null> {
  if (normalize(path).startsWith('..')) return null
  try {
    return await git(root, ['show', `${cp.tree}:./${path}`])
  } catch {
    return null
  }
}

// The run's diff for one file, for describing it. Empty when nothing differs.
export async function diffOf(root: string, cp: Checkpoint, path: string, unified = 1): Promise<string> {
  if (normalize(path).startsWith('..')) return ''
  const now = await snapshotTree(root)
  return git(root, ['diff-tree', '-p', `--unified=${unified}`, '--relative', '--no-renames', cp.tree, now, '--', path]).catch(() => '')
}
