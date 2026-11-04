import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'

// The project dashboard: every folder Forge knows about (Solo chats, Crew runs, the cached folder scan) with its activity and git state.

export type GitInfo = { branch: string | null; dirty: number; ahead: number }
export type ProjectOverview = {
  path: string
  name: string
  lastActivity: number
  chats: number
  runs: { total: number; active: number; needsYou: number; lastStatus: string | null }
  git: GitInfo | null
  exists: boolean
}
export type OverviewDeps = {
  chats: () => { project: string | null; updatedAt: number }[]
  runs: () => { project: string; status: string; updatedAt: number; pendingApprovals: number }[]
  scanned?: () => { path: string; mtime: number }[]
  exists?: (path: string) => boolean
  gitInfo?: (path: string) => Promise<GitInfo | null>
}

// Same list as the Crew service: these runs have not finished.
const ACTIVE = ['planning', 'running', 'paused', 'verifying', 'awaiting_approval', 'interrupted']
const SCAN_ONLY = 20 // folders found only by the scan are mostly idle; the newest few are enough for a dashboard
const norm = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)

// One `git status` with a short timeout; a folder that is not a repository, or a slow one, gives null.
export function gitInfo(path: string, timeout = 1500): Promise<GitInfo | null> {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', 'status', '--porcelain=v2', '-b'], { cwd: path, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => {
      if (err) return resolve(null)
      let branch: string | null = null, ahead = 0, dirty = 0
      for (const line of out.split('\n')) {
        if (line.startsWith('# branch.head ')) branch = line.slice(14) === '(detached)' ? null : line.slice(14)
        else if (line.startsWith('# branch.ab ')) ahead = Number(/\+(\d+)/.exec(line)?.[1] ?? 0)
        else if (line && !line.startsWith('#')) dirty++
      }
      resolve({ branch, dirty, ahead })
    })
  })
}

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

export async function projectOverview(deps: OverviewDeps): Promise<ProjectOverview[]> {
  const exists = deps.exists ?? existsSync
  const git = deps.gitInfo ?? gitInfo
  const by = new Map<string, ProjectOverview>()
  const get = (raw: string) => {
    const path = norm(raw)
    let p = by.get(path)
    if (!p) by.set(path, (p = { path, name: basename(path) || path, lastActivity: 0, chats: 0, runs: { total: 0, active: 0, needsYou: 0, lastStatus: null }, git: null, exists: true }))
    return p
  }
  for (const c of deps.chats()) {
    if (!c.project) continue
    const p = get(c.project)
    p.chats++
    p.lastActivity = Math.max(p.lastActivity, c.updatedAt)
  }
  const lastRun = new Map<string, number>()
  for (const r of deps.runs()) {
    if (!r.project) continue
    const p = get(r.project)
    const live = ACTIVE.includes(r.status)
    p.runs.total++
    if (live) p.runs.active++
    if (live && (r.status === 'awaiting_approval' || r.pendingApprovals > 0)) p.runs.needsYou++
    if (r.updatedAt >= (lastRun.get(p.path) ?? 0)) lastRun.set(p.path, r.updatedAt), (p.runs.lastStatus = r.status)
    p.lastActivity = Math.max(p.lastActivity, r.updatedAt)
  }
  const scanOnly = (deps.scanned?.() ?? []).filter((h) => !by.has(norm(h.path))).sort((a, b) => b.mtime - a.mtime).slice(0, SCAN_ONLY)
  for (const h of scanOnly) get(h.path).lastActivity = h.mtime
  const all = [...by.values()]
  for (const p of all) p.exists = exists(p.path)
  await pool(all.filter((p) => p.exists), 4, async (p) => { p.git = await git(p.path).catch(() => null) })
  // needs you first, then running, then the most recent; folders that are gone sink to the end
  return all.sort((a, b) => Number(b.exists) - Number(a.exists) || Math.sign(b.runs.needsYou) - Math.sign(a.runs.needsYou) || Math.sign(b.runs.active) - Math.sign(a.runs.active) || b.lastActivity - a.lastActivity)
}

let cache: { at: number; value: Promise<ProjectOverview[]> } | null = null
export function cachedOverview(deps: OverviewDeps, fresh = false, ttl = 15_000, now = Date.now): Promise<ProjectOverview[]> {
  if (!fresh && cache && now() - cache.at < ttl) return cache.value
  const value = projectOverview(deps)
  cache = { at: now(), value }
  value.catch(() => { if (cache?.value === value) cache = null })
  return value
}
export const resetOverviewCache = () => (cache = null)
