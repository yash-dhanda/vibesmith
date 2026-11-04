import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

// Finds the project folders on this computer so a request like "fix the riftvault login" can be matched to ~/code/riftvault.
// A folder counts as a project when it holds one of the usual marker files; the walk does not go inside a project.

export type ProjectHit = { path: string; name: string; markers: string[]; mtime: number }

const MARKERS = ['.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'pubspec.yaml', 'CMakeLists.txt', 'deno.json', 'mix.exs', 'Package.swift']
const SKIP = new Set(['node_modules', 'target', 'dist', 'build', 'out', '.next', '__pycache__', 'venv', '.venv', 'vendor', 'snap', 'Steam', 'steamapps', 'Trash', 'proc', 'sys', 'lost+found', 'Applications', 'Library'])
const MAX_DEPTH = 5
const MAX_DIRS = 60_000
const MAX_MS = 9_000
const MAX_HITS = 500

const running = new Map<string, Promise<ProjectHit[]>>()
const TIMEOUT = Symbol('timeout')

// A scan already running for this folder is shared, so repeated calls do not pile up walks of the same disk.
export function scanProjects(root = homedir(), now = Date.now, maxMs = MAX_MS): Promise<ProjectHit[]> {
  const have = running.get(root)
  if (have) return have
  const p = walk(root, now, maxMs).finally(() => running.delete(root))
  running.set(root, p)
  return p
}

async function walk(root: string, now: () => number, maxMs: number): Promise<ProjectHit[]> {
  const hits: ProjectHit[] = []
  const started = now()
  // A folder on a dead network mount can leave readdir waiting for ever, so every call is raced against the time that is left.
  const within = <T>(p: Promise<T>): Promise<T | typeof TIMEOUT> => {
    let timer: NodeJS.Timeout
    const late = new Promise<typeof TIMEOUT>((r) => { timer = setTimeout(() => r(TIMEOUT), Math.max(0, maxMs - (now() - started))) })
    return Promise.race([p, late]).finally(() => clearTimeout(timer))
  }
  let seen = 0
  const rootReal = await within(realpath(root)).catch(() => root)
  if (rootReal === TIMEOUT) return hits
  const visited = new Set<string>([rootReal])
  let level = [{ path: root, real: rootReal }]
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next: typeof level = []
    for (const { path: dir, real } of level) {
      if (seen++ > MAX_DIRS || now() - started > maxMs || hits.length >= MAX_HITS) return hits
      let entries: import('node:fs').Dirent[]
      try {
        const r = await within(readdir(dir, { withFileTypes: true }))
        if (r === TIMEOUT) return hits
        entries = r
      } catch { continue }
      const names = new Set(entries.map((e) => e.name))
      const markers = MARKERS.filter((m) => names.has(m))
      if (markers.length && dir !== root) {
        const mtime = await within(stat(dir).then((s) => s.mtimeMs).catch(() => 0))
        if (mtime === TIMEOUT) return hits
        hits.push({ path: dir, name: basename(dir), markers, mtime })
        continue
      }
      for (const e of entries) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue // hidden folders are tools' own data, not projects
        const path = join(dir, e.name)
        let target = join(real, e.name)
        if (e.isSymbolicLink()) { // followed (~/code may be a link to another disk); the real path stops loops and double counting
          try {
            const r = await within(realpath(path).then(async (t) => ((await stat(t)).isDirectory() ? t : null)))
            if (r === TIMEOUT) return hits
            if (!r) continue
            target = r
          } catch { continue }
        } else if (!e.isDirectory()) continue
        if (visited.has(target)) continue
        visited.add(target)
        next.push({ path, real: target })
      }
    }
    level = next
  }
  return hits
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'fix', 'add', 'make', 'build', 'use', 'work', 'working', 'start', 'project', 'folder', 'app', 'please', 'can', 'you', 'let', 'want', 'need', 'new', 'update', 'change', 'bug', 'issue', 'some', 'back', 'them', 'form', 'port', 'word', 'page', 'site', 'have', 'will'])

// Best matches first. A word of the request that is the folder's name scores most; a whole part of the name (riftvault in riftvault-old) or the start of a part scores less; a folder on the path scores least;
// recently changed folders win ties.
export function rankProjects(projects: ProjectHit[], query: string, limit = 6): ProjectHit[] {
  // A stop word still counts when it is the folder's whole name ("open the site project" finds ~/code/site).
  const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))]
  if (!words.length) return []
  const newest = Math.max(1, ...projects.map((p) => p.mtime))
  const scored = projects.map((p) => {
    const name = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const parts = p.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) // ManhwaManiacs: manhwa, maniacs
    const path = p.path.toLowerCase()
    let score = 0
    for (const w of words) {
      if (name === w) score += 12
      else if (STOP.has(w)) continue
      else if (parts.includes(w)) score += 8
      else if (w.length >= 4 && parts.some((x) => x.startsWith(w))) score += 5
      else if (path.includes('/' + w)) score += 2
    }
    return { p, score: score ? score + (p.mtime / newest) * 1.5 : 0 }
  })
  const ranked = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  const top = ranked[0]?.score ?? 0
  return ranked.filter((x) => x.score >= Math.max(5, top * 0.5)).slice(0, limit).map((x) => x.p) // only the matches that are close to the best one
}
