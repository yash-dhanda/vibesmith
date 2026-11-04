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

export class UsageStore {
  private file: string
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'usage.json')
  }

  private read(): Days {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }

  record(model: string, u: { input: number; output: number; genMs: number }, now = Date.now()) {
    const days = this.read()
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
    mkdirSync(dirname(tmp), { recursive: true })
    writeFileSync(tmp, JSON.stringify(days))
    renameSync(tmp, this.file)
  }

  summary(now = Date.now()): UsageSummary {
    const days = this.read()
    const out: UsageSummary = { allTime: { input: 0, output: 0, calls: 0 }, today: { input: 0, output: 0 }, last7: { input: 0, output: 0 }, byModel: [], byAgent: [], byDay: [] }
    const models = new Map<string, Bucket>()
    const agents = { claude: [0, 0, 0], codex: [0, 0, 0], local: [0, 0, 0] } // today, last 7 days, all time
    const agentOf = (m: string) => (m.startsWith('crew:') ? (m.slice(5) as keyof typeof agents) : m.startsWith('ollama:') ? 'local' : null)
    const today = dayKey(now)
    const week = new Set(Array.from({ length: 7 }, (_, i) => dayKey(now - i * 86_400_000)))
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
      const day = dayKey(now - i * 86_400_000)
      out.byDay.push({ day, tokens: Object.values(days[day] ?? {}).reduce((n, b) => n + b.input + b.output, 0) })
    }
    return out
  }
}
