import { execFile } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'

// Undo without touching the user's index, branches or stash: a run is snapshotted as a tree built in a throwaway index,
// stored as a commit under refs/forge/. Untracked files are included, .gitignore is respected.

export const AUTHOR = { GIT_AUTHOR_NAME: 'Forge', GIT_AUTHOR_EMAIL: 'forge@localhost', GIT_COMMITTER_NAME: 'Forge', GIT_COMMITTER_EMAIL: 'forge@localhost' }

// git's messages are matched in a few places, so they are always English (LC_ALL wins over LANGUAGE only when LANGUAGE is cleared too).
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: { ...process.env, LC_ALL: 'C', LANGUAGE: '', ...env }, maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(out),
    )
    // git may exit before it has read a large input; the failed write then shows up as git's own error, not as an uncaught EPIPE.
    child.stdin?.on('error', () => {})
    if (input !== undefined) child.stdin?.end(input)
  })
}

// Files that usually hold secrets (same list as the agent policy in team/policy.ts).
export const SECRET_PATH = new RegExp(String.raw`(?:^|/)(?:\.env(?:\.(?!example|sample|template)[\w.]+)?|\.ssh|\.aws|\.gnupg|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519|ecdsa)|[\w.-]+\.(?:pem|key|p12|pfx)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))(?:/|$)`, 'i')

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

// Adds everything except the given paths. When .gitignore already ignores a path named in an exclude, git adds the rest and then exits with an
// error about it ("The following paths are ignored..."); that is not a failure here, so it is let through.
export async function addAll(root: string, exclude: string[], env?: Record<string, string>): Promise<void> {
  try {
    await git(root, ['add', '-A', '--', '.', ...exclude], env)
  } catch (e) {
    if (!/ignored by one of your \.gitignore/i.test((e as Error).message)) throw e
  }
}

// A throwaway index. It starts as a copy of the real one, so git's stat cache saves rehashing the whole project on every snapshot.
export async function withTempIndex<T>(root: string, fn: (env: Record<string, string>) => Promise<T>, seed = true): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-idx-'))
  const file = join(dir, 'index')
  try {
    if (seed) {
      try {
        copyFileSync(resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim()), file)
      } catch {} // no index yet
    }
    return await fn({ GIT_INDEX_FILE: file })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Same, falling back to an empty index when the copy is unusable (a split index points at files next to the original).
export const inTempIndex = <T>(root: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> => withTempIndex(root, fn).catch(() => withTempIndex(root, fn, false))

export const snapshotTree = (root: string): Promise<string> =>
  inTempIndex(root, async (env) => {
    // node_modules is excluded even without a .gitignore: snapshotting it would take minutes
    await addAll(root, [':(exclude)node_modules', ':(exclude)**/node_modules'], env)
    // .gitignore keeps .env and friends out of `add -A`, but a run can rewrite them and they cannot be recreated: take them too.
    // --directory keeps ignored folders (node_modules, dist) collapsed, so this does not walk them.
    const ignored = (await git(root, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'])).split('\0').filter((p) => p && !p.endsWith('/') && SECRET_PATH.test(p))
    if (ignored.length) await git(root, ['--literal-pathspecs', 'add', '-f', '--', ...ignored], env)
    return (await git(root, ['write-tree'], env)).trim()
  })

// Folders that exist now but hold no files; git does not record them, so Undo must not remove them later.
function emptyDirs(root: string): string[] {
  const out: string[] = []
  let seen = 0
  const walk = (rel: string) => {
    if (seen++ > 20_000) return // ponytail: very large trees are not walked to the end; the folders past this point may be removed by Undo
    let ents
    try {
      ents = readdirSync(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    if (!ents.length && rel) out.push(rel)
    for (const e of ents) if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') walk(rel ? `${rel}/${e.name}` : e.name)
  }
  walk('')
  return out
}

// `paths` is what the run changed: set by the first changesSince after the run, so Undo leaves everything else alone.
// A landing from the team is looked up by id instead (see savePaths).
export type Checkpoint = { id: string; tree: string; paths?: string[]; emptyDirs?: string[] }

export async function createCheckpoint(root: string, message = 'forge checkpoint'): Promise<Checkpoint> {
  const tree = await snapshotTree(root)
  const commit = (await git(root, ['commit-tree', tree, '-m', message], AUTHOR)).trim()
  const id = `${Date.now()}`
  await git(root, ['update-ref', `refs/forge/${id}`, commit])
  const dirs = emptyDirs(root)
  return dirs.length ? { id, tree, emptyDirs: dirs } : { id, tree }
}

// The files a team landing wrote, kept next to the checkpoint taken just before it, so that Undo of the landing touches only those.
export async function savePaths(root: string, id: string, paths: string[]): Promise<void> {
  const blob = (await git(root, ['hash-object', '-w', '--stdin'], {}, JSON.stringify(paths))).trim()
  await git(root, ['update-ref', `refs/forge-paths/${id}`, blob])
}
const savedPaths = (root: string, id: string): Promise<string[] | undefined> =>
  git(root, ['cat-file', 'blob', `refs/forge-paths/${id}`]).then((t) => JSON.parse(t) as string[], () => undefined)

// Puts files back from a tree, without a command line that grows with the number of files.
export const restorePaths = (root: string, tree: string, paths: string[]) =>
  git(root, ['--literal-pathspecs', 'restore', `--source=${tree}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {}, paths.map((p) => p + '\0').join(''))

export type Change = { path: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number }

// What differs between two trees, relative to the project folder.
export async function treeChanges(root: string, from: string, to: string): Promise<Change[]> {
  const base = ['diff-tree', '-r', '-z', '--relative', '--no-renames']
  const [names, nums] = await Promise.all([git(root, [...base, '--name-status', from, to]), git(root, [...base, '--numstat', from, to])])
  const counts = new Map<string, [number, number]>()
  for (const entry of nums.split('\0').filter(Boolean)) {
    const [a, r, ...p] = entry.split('\t')
    counts.set(p.join('\t'), [a === '-' ? 0 : +a, r === '-' ? 0 : +r]) // '-' = binary
  }
  const t = names.split('\0').filter(Boolean)
  const all: Change[] = []
  for (let i = 0; i + 1 < t.length; i += 2) {
    const [added, removed] = counts.get(t[i + 1]) ?? [0, 0]
    all.push({ path: t[i + 1], status: t[i] === 'A' ? 'added' : t[i] === 'D' ? 'deleted' : 'modified', added, removed })
  }
  return all
}

// What the run changed, relative to the project folder.
export async function changesSince(root: string, cp: Checkpoint): Promise<Change[]> {
  const now = await snapshotTree(root)
  const scope = cp.paths ?? (await savedPaths(root, cp.id))
  if (now === cp.tree) {
    cp.paths ??= scope ?? []
    return []
  }
  const all = await treeChanges(root, cp.tree, now)
  if (!scope) {
    cp.paths = all.map((c) => c.path)
    return all
  }
  cp.paths ??= scope
  const mine = new Set(scope)
  return all.filter((c) => mine.has(c.path))
}

// Puts every file the run changed back: removes files the run created, restores modified and deleted ones.
// ponytail: edits the user made by hand during the run to those same files are undone too. Snapshot per file if that bites.
export async function undoTo(root: string, cp: Checkpoint): Promise<string[]> {
  return revert(root, cp, await changesSince(root, cp))
}

// Puts back one file only. Returns what is still changed, so the UI can refresh its list.
export async function undoFile(root: string, cp: Checkpoint, path: string): Promise<Change[]> {
  const list = await changesSince(root, cp)
  await revert(root, cp, list.filter((c) => c.path === path))
  return changesSince(root, cp)
}

// A path that leaves the project folder (not one that merely starts with two dots).
const escapes = (p: string) => {
  const n = normalize(p)
  return n === '..' || n.startsWith('..' + sep)
}

export async function revert(root: string, cp: Checkpoint, list: Change[]): Promise<string[]> {
  const back = list.filter((c) => c.status !== 'added' && !escapes(c.path)).map((c) => c.path)
  if (back.length) await restorePaths(root, cp.tree, back)
  const kept = new Set(cp.emptyDirs)
  for (const c of list.filter((c) => c.status === 'added')) {
    const p = normalize(c.path)
    if (escapes(p)) continue
    try {
      rmSync(join(root, p), { force: true })
    } catch (e) {
      // the restore above already swapped this entry for a directory (or a file), so there is nothing of the run's left to remove
      if (!['EISDIR', 'ERR_FS_EISDIR', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
      continue
    }
    // drop directories the run created and left empty
    for (let d = dirname(join(root, p)); d.length > root.length; d = dirname(d)) {
      if (kept.has(relative(root, d).split(sep).join('/'))) break
      try {
        rmdirSync(d) // throws if not empty, which ends the walk
      } catch {
        break
      }
    }
  }
  return list.map((c) => c.path)
}

// A file as it was when the checkpoint was taken, or null if it did not exist then. Paths are relative to the project folder.
// A file too big for git()'s buffer comes back as '' (it did exist).
export async function fileAt(root: string, cp: Checkpoint, path: string): Promise<string | null> {
  if (escapes(path)) return null
  try {
    return await git(root, ['show', `${cp.tree}:./${path}`])
  } catch {
    return git(root, ['cat-file', '-e', `${cp.tree}:./${path}`]).then(() => '', () => null)
  }
}

// The run's diff for one file, for describing it. Empty when nothing differs, and for secrets (this text goes to the model).
export async function diffOf(root: string, cp: Checkpoint, path: string, unified = 1): Promise<string> {
  if (escapes(path) || SECRET_PATH.test(path)) return ''
  const now = await snapshotTree(root)
  return git(root, ['diff-tree', '-p', `--unified=${unified}`, '--relative', '--no-renames', cp.tree, now, '--', path]).catch(() => '')
}
