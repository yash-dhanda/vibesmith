import type { OwnerResult } from '../main/githubTop'

// "Verified owners only": GitHub verifies organisations, not repositories. The owners of the visible list are looked up in the background, eight at a
// time, and the list re-filters as answers arrive. Answers are shared by every list in the window.
export type OwnerMap = Record<string, OwnerResult>
export type OwnerProgress = { checked: number; total: number; stop: 'rate' | 'error' | null; done: boolean }
export const ownerMap: OwnerMap = {}
export const ownerOf = (fullName: string) => fullName.split('/')[0].toLowerCase()
const BATCH = 8

export const isVerified = (fullName: string, owners: OwnerMap = ownerMap) => owners[ownerOf(fullName)]?.verified === true
export const verifiedCount = (items: { fullName: string }[], owners: OwnerMap = ownerMap) => items.filter((x) => isVerified(x.fullName, owners)).length
// Owners not answered yet, in list order and without repeats.
export const ownersToCheck = (items: { fullName: string }[], owners: OwnerMap = ownerMap) =>
  [...new Set(items.map((x) => ownerOf(x.fullName)))].filter((o) => !owners[o]?.checked)

export function ownerStatus(p: OwnerProgress | null): string {
  if (!p || p.checked >= p.total) return ''
  if (p.stop === 'rate') return `Checked ${p.checked} of ${p.total} owners. Sign in with the GitHub CLI (gh auth login) to check all of them.`
  if (p.stop === 'error') return `Checked ${p.checked} of ${p.total} owners. GitHub could not be reached for the rest.`
  return p.done ? '' : `Checking owners: ${p.checked} of ${p.total}`
}

// Looks up the owners of these repositories, top of the list first. Returns without error whatever happens; the progress says what was reached.
export async function checkOwners(items: { fullName: string }[], onProgress: (p: OwnerProgress) => void, cancelled: () => boolean = () => false) {
  const total = new Set(items.map((x) => ownerOf(x.fullName))).size
  const todo = ownersToCheck(items)
  let checked = total - todo.length
  onProgress({ checked, total, stop: null, done: !todo.length })
  for (let i = 0; i < todo.length; i += BATCH) {
    if (cancelled()) return
    let stop: OwnerProgress['stop'] = null
    try {
      const r = await window.forge.githubOwners(todo.slice(i, i + BATCH))
      for (const [o, v] of Object.entries(r.owners)) if (v.checked) ownerMap[o.toLowerCase()] = v
      checked += r.checked
      stop = r.stopped
    } catch { stop = 'error' }
    if (cancelled()) return
    onProgress({ checked, total, stop, done: stop !== null || i + BATCH >= todo.length })
    if (stop) return
  }
}
