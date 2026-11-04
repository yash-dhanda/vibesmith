import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Lifetime token ledger: per day, per model. Tiny on purpose (a few numbers per model per day), so it is rewritten whole.
type Bucket = { input: number; output: number; calls: number; genMs: number; genTokens: number }
type Days = Record<string, Record<string, Bucket>>

export type UsageSummary = {
  allTime: { input: number; output: number; calls: number }
  today: { input: number; output: number }
  last7: { input: number; output: number }
  byModel: { model: string; input: number; output: number; calls: number; avgTps: number }[]
  byAgent: { agent: 'claude' | 'codex' | 'local'; today: number; last7: number; allTime: number }[] // Crew (crew:<agent>) plus Solo chats on local models (ollama:*)
  byDay: { day: string; tokens: number }[] // the last 14 days, oldest first, zero-filled
}

const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Keeps only well-formed days and buckets, so a hand-edited or half-written file cannot break the summary.
const clean = (raw: Record<string, unknown>): Days => {
  const keys: (keyof Bucket)[] = ['input', 'output', 'calls', 'genMs', 'genTokens']
  const days: Days = {}
  for (const [day, perModel] of Object.entries(raw)) {
    if (!perModel || typeof perModel !== 'object') continue
    const models: Record<string, Bucket> = {}
    for (const [model, b] of Object.entries(perModel)) if (b && typeof b === 'object' && keys.every((k) => Number.isFinite((b as Bucket)[k]))) models[model] = b as Bucket
    days[day] = models
  }
  return days
}

// The calendar day `i` days before `now`. Stepping whole calendar days (at noon) stays right across a daylight-saving change.
const daysBack = (now: number, i: number) => {
  const d = new Date(now)
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime())
}

export class UsageStore {
  private file: string
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'usage.json')
  }

  // null means "could not read it": the caller must not write over what may still be good history.
  private read(): Days | null {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null
    }
    try {
      const raw = JSON.parse(text) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return clean(raw as Record<string, unknown>)
    } catch {
      /* fall through: not JSON */
    }
    try {
      renameSync(this.file, `${this.file}.bad-${Date.now()}`) // keep the damaged file for rescue, start a new ledger
    } catch {}
    return {}
  }

  record(model: string, u: { input: number; output: number; genMs: number }, now = Date.now()) {
    const days = this.read()
    if (!days) return
    const b = ((days[dayKey(now)] ??= {})[model] ??= { input: 0, output: 0, calls: 0, genMs: 0, genTokens: 0 })
    b.input += u.input
    b.output += u.output
    b.calls += 1
    if (u.genMs > 0) {
      // only calls with a real generation time count towards tokens per second
      b.genMs += u.genMs
      b.genTokens += u.output
    }
    const tmp = this.file + '.tmp'
    try {
      mkdirSync(dirname(tmp), { recursive: true })
      writeFileSync(tmp, JSON.stringify(days))
      renameSync(tmp, this.file)
    } catch {} // the ledger is bookkeeping: a failed write skips this call
  }

  summary(now = Date.now()): UsageSummary {
    const days = this.read() ?? {}
    const out: UsageSummary = { allTime: { input: 0, output: 0, calls: 0 }, today: { input: 0, output: 0 }, last7: { input: 0, output: 0 }, byModel: [], byAgent: [], byDay: [] }
    const models = new Map<string, Bucket>()
    const agents = { claude: [0, 0, 0], codex: [0, 0, 0], local: [0, 0, 0] } // today, last 7 days, all time
    const agentOf = (m: string) => (m.startsWith('crew:') ? (m.slice(5) as keyof typeof agents) : m.startsWith('ollama:') ? 'local' : null)
    const today = dayKey(now)
    const week = new Set(Array.from({ length: 7 }, (_, i) => daysBack(now, i)))
    for (const [day, perModel] of Object.entries(days)) {
      let dayTokens = 0
      for (const [model, b] of Object.entries(perModel)) {
        out.allTime.input += b.input
        out.allTime.output += b.output
        out.allTime.calls += b.calls
        if (day === today) (out.today.input += b.input), (out.today.output += b.output)
        if (week.has(day)) (out.last7.input += b.input), (out.last7.output += b.output)
        dayTokens += b.input + b.output
        const ag = agentOf(model)
        if (ag && agents[ag]) {
          const n = b.input + b.output
          if (day === today) agents[ag][0] += n
          if (week.has(day)) agents[ag][1] += n
          agents[ag][2] += n
        }
        const m = models.get(model) ?? { input: 0, output: 0, calls: 0, genMs: 0, genTokens: 0 }
        for (const k of Object.keys(m) as (keyof Bucket)[]) m[k] += b[k]
        models.set(model, m)
      }
      days[day] = perModel
      void dayTokens
    }
    out.byModel = [...models].map(([model, b]) => ({ model, input: b.input, output: b.output, calls: b.calls, avgTps: b.genMs > 0 ? b.genTokens / (b.genMs / 1000) : 0 })).sort((a, b) => b.input + b.output - (a.input + a.output))
    out.byAgent = (Object.keys(agents) as (keyof typeof agents)[]).map((agent) => ({ agent, today: agents[agent][0], last7: agents[agent][1], allTime: agents[agent][2] }))
    for (let i = 13; i >= 0; i--) {
      const day = daysBack(now, i)
      out.byDay.push({ day, tokens: Object.values(days[day] ?? {}).reduce((n, b) => n + b.input + b.output, 0) })
    }
    return out
  }
}
