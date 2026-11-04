import { createCheckpoint, git, revert, SECRET_PATH, snapshotTree, treeChanges, type Change } from './checkpoint'

// The restore points browser: Solo runs, Crew landings and edit-and-resend all keep a snapshot commit under refs/forge/<ms>.
// Everything here compares a point with the project as it is now: "added" means created since the point, "deleted" means gone since.

export type RestorePoint = { id: string; at: number; label: string; filesChanged: number; additions: number; deletions: number }

const MAX_POINTS = 200
const MAX_DIFF = 1_500_000
const ID = /^\d{1,16}$/ // ids are Date.now(); this also keeps a renderer-supplied id out of the ref name
const BEFORE_RESTORE = 'forge checkpoint: before restoring '

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

const treeOf = (project: string, id: string): Promise<string> => {
  if (!ID.test(id)) throw new Error('That restore point does not exist.')
  return git(project, ['rev-parse', '--verify', '--quiet', `refs/forge/${id}^{tree}`]).then((t) => t.trim(), () => { throw new Error('That restore point no longer exists.') })
}

// `names` maps a point id to what made it, when the caller knows (a chat title, a run goal); otherwise the label is a guess from the ref.
export async function listRestorePoints(project: string, names: Record<string, string> = {}): Promise<RestorePoint[]> {
  let refs: string
  let landings: string
  try {
    ;[refs, landings] = await Promise.all([
      git(project, ['for-each-ref', '--format=%(refname:strip=2)%09%(tree)%09%(committerdate:unix)%09%(contents:subject)', 'refs/forge/']),
      git(project, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/forge-paths/']),
    ])
  } catch {
    return [] // not a repository
  }
  const landed = new Set(landings.split('\n').filter(Boolean))
  const points = refs.split('\n').filter(Boolean).flatMap((line) => {
    const [id, tree, secs, ...rest] = line.split('\t')
    if (!ID.test(id)) return []
    const subject = rest.join('\t')
    const label = names[id] ?? (subject.startsWith(BEFORE_RESTORE) ? 'Before a restore' : landed.has(id) ? 'Crew landing' : 'Solo run')
    return [{ id, tree, at: Number(id) > 1e12 ? Number(id) : Number(secs) * 1000, label }]
  }).sort((a, b) => b.at - a.at).slice(0, MAX_POINTS)

  const now = await snapshotTree(project).catch(() => null)
  return pool(points, 6, async ({ tree, ...p }) => {
    let filesChanged = 0, additions = 0, deletions = 0
    if (now && now !== tree) {
      const nums = await git(project, ['diff-tree', '-r', '--numstat', '--relative', '--no-renames', tree, now]).catch(() => '')
      for (const l of nums.split('\n').filter(Boolean)) {
        const [a, d] = l.split('\t')
        filesChanged++
        additions += a === '-' ? 0 : +a || 0
        deletions += d === '-' ? 0 : +d || 0
      }
    }
    return { ...p, filesChanged, additions, deletions }
  })
}

// The files that differ from the point, and the unified diff of what changed since (point on the left, now on the right).
// Secret files are listed but their contents never leave this function.
export async function restoreDiff(project: string, id: string): Promise<{ files: Change[]; diff: string; truncated: boolean }> {
  const tree = await treeOf(project, id)
  const now = await snapshotTree(project)
  const files = await treeChanges(project, tree, now)
  if (!files.length) return { files, diff: '', truncated: false }
  const raw = await git(project, ['diff-tree', '-p', '-r', '--unified=3', '--relative', '--no-renames', tree, now])
  const diff = raw.split(/^(?=diff --git )/m).map((section) => {
    const path = /^diff --git a\/(.+) b\//.exec(section)?.[1] ?? ''
    return path && SECRET_PATH.test(path) ? `diff --git a/${path} b/${path}\nBinary files differ\n` : section
  }).join('')
  if (diff.length <= MAX_DIFF) return { files, diff, truncated: false }
  const cut = diff.lastIndexOf('\ndiff --git ', MAX_DIFF)
  return { files, diff: diff.slice(0, cut > 0 ? cut + 1 : MAX_DIFF), truncated: true }
}

// Puts the chosen files back as they were at the point. Without `files` that is every file that was edited or deleted since;
// files created since are removed only when they are named. A new restore point of the current state is taken first, so this can be undone.
export async function restoreTo(project: string, id: string, opts: { files?: string[] } = {}): Promise<{ restored: string[]; checkpoint: string | null }> {
  const tree = await treeOf(project, id)
  const pick = opts.files ? new Set(opts.files) : null
  const choose = (list: Change[]) => list.filter((c) => (pick ? pick.has(c.path) : c.status !== 'added'))
  // Only paths git reports as different can be touched, so a path from the renderer cannot reach outside the project.
  if (!choose(await treeChanges(project, tree, await snapshotTree(project))).length) return { restored: [], checkpoint: null }
  const before = await createCheckpoint(project, BEFORE_RESTORE + id)
  const chosen = choose(await treeChanges(project, tree, before.tree))
  const restored = await revert(project, { id, tree, emptyDirs: before.emptyDirs }, chosen)
  return { restored, checkpoint: before.id }
}
