import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Run, RunEvent } from './types'

// One folder per run: run.json (state, rewritten atomically) and events.jsonl (everything the screen showed, so a restart can replay it).
const SAFE = /^[\w-]+$/
const MAX_EVENT_LINES = 20_000

export class TeamStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }
  private runDir = (id: string) => {
    if (!SAFE.test(id)) throw new Error('bad run id')
    return join(this.dir, id)
  }

  save(run: Run) {
    const d = this.runDir(run.id)
    mkdirSync(d, { recursive: true })
    run.updatedAt = Date.now()
    const tmp = join(d, 'run.json.tmp')
    writeFileSync(tmp, JSON.stringify(run))
    renameSync(tmp, join(d, 'run.json')) // a crash mid-write cannot leave a half-written run
  }

  load(id: string): Run | null {
    try {
      return JSON.parse(readFileSync(join(this.runDir(id), 'run.json'), 'utf8'))
    } catch {
      return null
    }
  }

  list(): Run[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => SAFE.test(f))
      .map((f) => this.load(f))
      .filter((r): r is Run => !!r)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  appendEvent(id: string, ev: RunEvent) {
    try {
      appendFileSync(join(this.runDir(id), 'events.jsonl'), JSON.stringify({ t: Date.now(), ev }) + '\n')
    } catch {}
  }

  // The last `limit` events, oldest first. Long runs are trimmed on read so the file cannot grow without bound.
  events(id: string, limit = 2000): { t: number; ev: RunEvent }[] {
    try {
      const lines = readFileSync(join(this.runDir(id), 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      if (lines.length > MAX_EVENT_LINES) writeFileSync(join(this.runDir(id), 'events.jsonl'), lines.slice(-MAX_EVENT_LINES / 2).join('\n') + '\n')
      return lines.slice(-limit).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }

  delete(id: string) {
    rmSync(this.runDir(id), { recursive: true, force: true })
  }
}
