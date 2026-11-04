import { readFileSync } from 'node:fs'
import { atomicWrite } from './projectRules'
import { validRepoName } from './githubTop'

// Repositories the owner saved from the Top GitHub repos browser, in savedRepos.json in the app data folder.
export type SavedRepo = {
  fullName: string; url: string; description: string; stars: number; topics: string[]; language: string | null; savedAt: number; note: string
  starsNow?: number; refreshedAt?: number // the count when last looked up; `stars` stays what it was when saved
}
export type NewSaved = Pick<SavedRepo, 'fullName' | 'url' | 'description' | 'stars' | 'topics' | 'language'> & { note?: string }
export const MAX_SAVED = 500
const MAX_NOTE = 500

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export class SavedStore {
  constructor(private file: string) {}

  private load(): SavedRepo[] {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(v) ? v.filter((r): r is SavedRepo => !!r && typeof r.fullName === 'string' && validRepoName(r.fullName)) : []
    } catch { return [] }
  }
  private save(list: SavedRepo[]) { atomicWrite(this.file, JSON.stringify(list, null, 2)) }

  list(): SavedRepo[] { return this.load().sort((a, b) => b.savedAt - a.savedAt) }

  // Saving again updates the details and keeps the note and the date; a new one needs room.
  set(item: NewSaved, now = Date.now()): SavedRepo {
    if (!item || typeof item !== 'object' || !validRepoName(item.fullName)) throw new Error('That is not a GitHub repository name.')
    const list = this.load()
    const old = list.find((r) => r.fullName.toLowerCase() === item.fullName.toLowerCase())
    if (!old && list.length >= MAX_SAVED) throw new Error(`You can save up to ${MAX_SAVED} repositories. Remove one first.`)
    const next: SavedRepo = {
      fullName: item.fullName, url: `https://github.com/${item.fullName}`, description: text(item.description, 400), stars: Number.isFinite(item.stars) ? Math.max(0, Math.floor(item.stars)) : 0,
      topics: Array.isArray(item.topics) ? item.topics.filter((t) => typeof t === 'string').slice(0, 20).map((t) => t.slice(0, 50)) : [], language: text(item.language, 50) || null,
      savedAt: old?.savedAt ?? now, note: item.note !== undefined ? text(item.note, MAX_NOTE) : (old?.note ?? ''),
      ...(old?.starsNow !== undefined ? { starsNow: old.starsNow, refreshedAt: old.refreshedAt } : {}),
    }
    this.save([...list.filter((r) => r !== old), next])
    return next
  }

  remove(fullName: string) {
    this.save(this.load().filter((r) => r.fullName.toLowerCase() !== String(fullName).toLowerCase()))
  }

  // Current counts from a lookup; repositories saved or removed meanwhile are handled by matching on the name.
  updateStars(found: Record<string, { stars: number; description: string }>, now = Date.now()): SavedRepo[] {
    const list = this.load()
    for (const r of list) { const f = found[r.fullName]; if (f) { r.starsNow = f.stars; r.refreshedAt = now; if (f.description) r.description = text(f.description, 400) } }
    this.save(list)
    return list.sort((a, b) => b.savedAt - a.savedAt)
  }
}
