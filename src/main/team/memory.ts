import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { AgentName } from './events'
import type { Decision, ErrorRecord } from './types'

// ---- retrieval: what a task needs from the project's history, without sending the history ----
const STOP = new Set('the and for are was with that this from have has had not but you your all can will its into than then them they out use used using any one two new add made make get got see via per'.split(' '))
export const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9_.\-/]{3,}/g) ?? []).filter((w) => !STOP.has(w))

// Small BM25-style ranking over a few hundred short entries. ponytail: replace with node:sqlite FTS5 (it works in Electron 45, not in the Node that runs the tests) if entries reach the thousands.
export function rank<T extends { text: string }>(docs: T[], query: string, k = 5): T[] {
  const q = [...new Set(tokens(query))]
  if (!q.length || !docs.length) return []
  const bags = docs.map((d) => tokens(d.text))
  const avg = bags.reduce((n, b) => n + b.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const b of bags) for (const w of new Set(b)) df.set(w, (df.get(w) ?? 0) + 1)
  const scored = docs.map((d, i) => {
    const b = bags[i]
    let s = 0
    for (const w of q) {
      const tf = b.filter((x) => x === w).length
      if (!tf) continue
      const idf = Math.log(1 + (docs.length - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5))
      s += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * b.length) / avg)))
    }
    return { d, s }
  })
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.d)
}

// A repeatable name for an error: the first line that looks like one, with numbers and paths flattened.
export function errorSignature(output: string): string {
  const line = output.split('\n').find((l) => /error|fail|cannot|not found|undefined|exception|assert/i.test(l)) ?? output.split('\n')[0] ?? ''
  return line.toLowerCase().replace(/\/[\w./-]+/g, '<path>').replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 120)
}

// ---- per-project memory that outlives a run: decisions, problems with the fix that worked, and which agent does which job well ----
export type RoleStats = Record<string, { ok: number; fail: number }> // "claude:build" -> counts
export type ProjectMemory = { decisions: Decision[]; errors: ErrorRecord[]; stats: RoleStats }
const CAP = 400

export class ProjectMemoryStore {
  private file: string
  constructor(dir: string, project: string) {
    this.file = join(dir, `memory-${createHash('sha1').update(project).digest('hex').slice(0, 12)}.json`)
  }
  load(): ProjectMemory {
    try {
      return { decisions: [], errors: [], stats: {}, ...JSON.parse(readFileSync(this.file, 'utf8')) }
    } catch {
      return { decisions: [], errors: [], stats: {} }
    }
  }
  update(fn: (m: ProjectMemory) => void) {
    const m = this.load()
    fn(m)
    m.decisions = m.decisions.slice(-CAP)
    m.errors = m.errors.slice(-CAP)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(m))
    renameSync(tmp, this.file)
  }
  recordOutcome(agent: AgentName, kind: string, ok: boolean) {
    this.update((m) => {
      const s = (m.stats[`${agent}:${kind}`] ??= { ok: 0, fail: 0 })
      if (ok) s.ok++
      else s.fail++
    })
  }
}

// Which agent to give a job when the plan does not say: the one with the better record on this project, else the default for the job.
export function routeAgent(kind: string, available: AgentName[], stats: RoleStats): AgentName {
  const fallback: AgentName = kind === 'research' ? 'claude' : 'codex'
  if (available.length === 1) return available[0]
  const rate = (a: AgentName) => {
    const s = stats[`${a}:${kind}`]
    return s && s.ok + s.fail >= 3 ? s.ok / (s.ok + s.fail) : null
  }
  const [c, x] = [rate('claude'), rate('codex')]
  if (c !== null && x !== null && Math.abs(c - x) >= 0.2) return c > x ? 'claude' : 'codex'
  return available.includes(fallback) ? fallback : available[0]
}
