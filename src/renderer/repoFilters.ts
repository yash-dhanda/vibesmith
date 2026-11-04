import { repoRisk } from './repoRisk'
import type { OwnerMap } from './ownerFilter'

// The filters of the Top GitHub repos dialog and of "More suggestions" in Settings > Skills. Pure: the same rules for both lists.
export type RepoFilters = { verified: boolean; hideFake: boolean; hideForks: boolean; licensed: boolean; recent: boolean; minStars: number }
export const DIALOG_FILTERS: RepoFilters = { verified: true, hideFake: true, hideForks: true, licensed: false, recent: false, minStars: 0 }
export const SKILL_FILTERS: RepoFilters = { ...DIALOG_FILTERS, verified: false } // many good skill repos belong to individuals
export const MIN_STARS = [0, 100, 1000, 5000, 10_000, 50_000]
const YEAR_MS = 365 * 86_400_000

export type FilterItem = {
  fullName: string; description: string | null; topics: string[]; stars: number; sizeKb?: number; createdAt?: string | null; language?: string | null
  fork?: boolean; archived?: boolean; license?: string; pushedAt?: string | null
}

// A repository whose details are unknown (the trending page carries no push date or license) is not dropped for lacking them. The same goes for an owner
// still being checked: the owner switch only removes a repository whose owner was checked and is not a verified organisation.
export function applyRepoFilters<T extends FilterItem>(items: T[], f: RepoFilters, owners: OwnerMap, o: { now?: number; sizeOf?: (fullName: string) => number | undefined } = {}): T[] {
  const now = o.now ?? Date.now()
  return items.filter((x) => {
    if (x.stars < f.minStars) return false
    if (f.hideForks && (x.fork || x.archived)) return false
    const known = !!x.pushedAt
    if (f.recent && known && now - Date.parse(x.pushedAt!) > YEAR_MS) return false
    if (f.licensed && known && !x.license) return false
    if (f.verified) { const own = owners[x.fullName.split('/')[0].toLowerCase()]; if (own?.checked && !own.verified) return false }
    if (f.hideFake && repoRisk({ ...x, description: x.description ?? '', sizeKb: x.sizeKb ?? o.sizeOf?.(x.fullName) })?.hide) return false
    return true
  })
}

export function loadFilters(s: Pick<Storage, 'getItem'>, key: string, defaults: RepoFilters): RepoFilters {
  try {
    const v = JSON.parse(s.getItem(key) ?? 'null') ?? {}
    const out = { ...defaults }
    for (const k of Object.keys(defaults) as (keyof RepoFilters)[]) {
      if (typeof defaults[k] === 'boolean' && typeof v[k] === 'boolean') (out[k] as boolean) = v[k]
    }
    if (MIN_STARS.includes(v.minStars)) out.minStars = v.minStars
    return out
  } catch { return { ...defaults } }
}
export const saveFilters = (s: Pick<Storage, 'setItem'>, key: string, f: RepoFilters) => { try { s.setItem(key, JSON.stringify(f)) } catch {} }
