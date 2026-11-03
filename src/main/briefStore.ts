import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// What a project is, in the user's words: a name, a short description and a list of priorities.
// Kept in the app's data folder (not in the project), keyed by the project's folder, so the user's repo stays clean.

export type Priority = { id: string; text: string; included: boolean }
export type Brief = { name: string; description: string; priorities: Priority[]; revision: number }
export type BriefEdit = { name?: unknown; description?: unknown; priorities?: unknown; revision?: unknown }

const MAX_PRIORITIES = 20
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export class BriefStore {
  constructor(private file: string) {}

  private all(): Record<string, Brief> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }

  get(root: string): Brief {
    return this.all()[root] ?? { name: basename(root), description: '', priorities: [], revision: 0 }
  }

  // A stale revision is refused and the current brief comes back, so two windows cannot overwrite each other unseen.
  set(root: string, edit: BriefEdit): { brief: Brief; conflict: boolean } {
    const cur = this.get(root)
    if (edit.revision !== cur.revision) return { brief: cur, conflict: true }
    const known = new Map(cur.priorities.map((p) => [p.id, p]))
    const priorities: Priority[] = []
    if (Array.isArray(edit.priorities))
      for (const raw of edit.priorities.slice(0, MAX_PRIORITIES)) {
        const r = (raw ?? {}) as Partial<Priority>
        const t = text(r.text, 120)
        if (!t) continue
        const id = typeof r.id === 'string' && known.has(r.id) && !priorities.some((p) => p.id === r.id) ? r.id : randomUUID().slice(0, 8)
        priorities.push({ id, text: t, included: r.included !== false })
      }
    const next: Brief = {
      // a field left out keeps its value; an empty name goes back to the folder's name
      name: edit.name === undefined ? cur.name : text(edit.name, 60) || basename(root),
      description: edit.description === undefined ? cur.description : text(edit.description, 400),
      priorities: Array.isArray(edit.priorities) ? priorities : cur.priorities,
      revision: cur.revision + 1,
    }
    const all = this.all()
    all[root] = next
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(all, null, 2))
    renameSync(tmp, this.file) // a crash mid-write cannot corrupt every project's brief
    return { brief: next, conflict: false }
  }
}
