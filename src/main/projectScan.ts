import { readdir, stat } from 'node:fs/promises'
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

export async function scanProjects(root = homedir(), now = Date.now): Promise<ProjectHit[]> {
  const hits: ProjectHit[] = []
  const started = now()
  let seen = 0
  let level = [root]
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (seen++ > MAX_DIRS || now() - started > MAX_MS || hits.length >= MAX_HITS) return hits
      let entries: import('node:fs').Dirent[]
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
      const names = new Set(entries.map((e) => e.name))
      const markers = MARKERS.filter((m) => names.has(m))
      if (markers.length && dir !== root) {
        const mtime = await stat(dir).then((s) => s.mtimeMs).catch(() => 0)
        hits.push({ path: dir, name: basename(dir), markers, mtime })
        continue
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue
        if (SKIP.has(e.name) || (e.name.startsWith('.') && depth >= 0)) continue // hidden folders are tools' own data, not projects
        next.push(join(dir, e.name))
      }
    }
    level = next
  }
  return hits
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'fix', 'add', 'make', 'build', 'use', 'work', 'working', 'start', 'project', 'folder', 'app', 'please', 'can', 'you', 'let', 'want', 'need', 'new', 'update', 'change', 'bug', 'issue'])

// Best matches first. A word of the request that is the folder's name scores most; a part of the name or of the path scores less;
// recently changed folders win ties.
export function rankProjects(projects: ProjectHit[], query: string, limit = 6): ProjectHit[] {
  const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))]
  if (!words.length) return []
  const newest = Math.max(1, ...projects.map((p) => p.mtime))
  const scored = projects.map((p) => {
    const name = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const parts = p.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    const path = p.path.toLowerCase()
    let score = 0
    for (const w of words) {
      if (name === w) score += 12
      else if (name.includes(w) || (w.length >= 5 && w.includes(name) && name.length >= 4)) score += 8
      else if (parts.some((x) => x.startsWith(w) || w.startsWith(x) && x.length >= 4)) score += 5
      else if (path.includes('/' + w)) score += 2
    }
    return { p, score: score ? score + (p.mtime / newest) * 1.5 : 0 }
  })
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.p)
}
