// New GitHub repositories that gain many stars in a day are often fake: copies of "free full version / unlocker / installer / cracked" lures,
// star-botted, with almost no code. Forge only downloads files and never runs them, but the owner may be tempted to, and an agent reading such a
// repository can be fed instructions by it. This marks them so they can be hidden or confirmed.
const LURE = /\b(crack(ed|s)?|keygen|serial key|license key|unlocker?|activat(ed|ion|or)|full version|free download|pre-?activated|nulled|bypass|loader|executor|cheat(s)?|hack(s|er)?|modded?|premium unlocked|ready to run|all features unlocked|installer|setup)\b/i
const YEAR = /\b20(2[4-9])\b/

export type RepoLike = { fullName: string; description: string | null; topics: string[]; stars: number; sizeKb?: number; createdAt?: string | null; language?: string | null }

// Returns {hide, reason} when the repository looks suspicious, else null. Only the fake-download pattern is hidden by default; a burst of stars on a tiny repo
// just gets a note, because plenty of honest new repositories are small.
export function repoRisk(r: RepoLike): { hide: boolean; reason: string } | null {
  const text = `${r.fullName} ${r.description ?? ''} ${r.topics.join(' ')}`
  const lure = LURE.test(text)
  const tiny = r.sizeKb !== undefined && r.sizeKb <= 80
  if (lure && (tiny || YEAR.test(text) || r.stars >= 100)) return { hide: true, reason: 'Looks like a fake download page: the name or description promises a ready-to-run or unlocked program, and there is almost no code.' }
  if (tiny && r.stars >= 200 && r.createdAt && Date.now() - Date.parse(r.createdAt) < 3 * 86_400_000 && !r.language) return { hide: false, reason: 'Many stars in a day with almost no code: sometimes star-botted. Look at the code before trusting it.' }
  return null
}
