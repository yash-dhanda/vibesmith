import { execFile } from 'node:child_process'

// Top GitHub repositories, for the "Top GitHub repos" browser. GitHub has no official "trending" API, so there are two honest lists:
//  - 'new' ("Newest hits"): the Search API, repositories created in the window (1 / 7 / 30 days), ranked by stars. 'all' is the most starred ever.
//  - 'trending': the HTML of github.com/trending (about 25 repos, with the stars each gained in the period). Nothing official promises that markup,
//    so a page that no longer parses is reported as an error instead of an empty list.

export type Period = 'day' | 'week' | 'month' | 'all'
export type Mode = 'new' | 'trending'
export type TopRepo = {
  fullName: string; url: string; description: string; stars: number; forks: number; language: string | null; topics: string[]
  createdAt: string | null; pushedAt: string | null; license?: string; starsToday?: number; sizeKb?: number; fork?: boolean; archived?: boolean // trending items have neither
}
// mode is the list actually returned: 'trending' for 'all' falls back to 'new'. note explains a list that is not what was asked for or is short.
export type TopResult = { items: TopRepo[]; period: Period; mode: Mode; note?: string; fetchedAt: number }
export type RepoSummary = { fullName: string; whatItDoes: string; topics: string[]; sizeKb?: number }

export type Deps = {
  fetchImpl?: typeof fetch
  run?: (cmd: string, args: string[]) => Promise<string> // the GitHub CLI; its own login is used, Forge never sees the token
  now?: () => number
  cache?: Map<string, { at: number; value: unknown }>
  retryMs?: number
  gapMs?: number // pause between the searches of skillSuggestions
  preferGh?: boolean // false: plain calls first, the CLI only after a rate limit (tests of the plain path)
}

const API = 'https://api.github.com'
const UA = 'Forge-desktop'
const TIMEOUT_MS = 10_000
const TOP_TTL = 10 * 60_000
const SUMMARY_TTL = 60 * 60_000
const DAYS = { day: 1, week: 7, month: 30 } as const
const SINCE = { day: 'daily', week: 'weekly', month: 'monthly' } as const
const NAME = /^[\w.-]+\/[\w.-]+$/
export const validRepoName = (n: string) => NAME.test(n) && n.split('/').every((s) => !/^\.+$/.test(s))
const UNREACHABLE = 'GitHub could not be reached. Check your connection and try again.'

export class GithubError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

const sharedCache = new Map<string, { at: number; value: unknown }>()
const defaultRun = (cmd: string, args: string[]) =>
  new Promise<string>((res, rej) => execFile(cmd, args, { timeout: 15_000, maxBuffer: 20_000_000 }, (e, out) => (e ? rej(e) : res(out.toString()))))

const resetText = (h: Headers, now: number) => {
  const reset = Number(h.get('x-ratelimit-reset'))
  if (!reset) return 'Try again in a few minutes.'
  const mins = Math.max(1, Math.ceil((reset * 1000 - now) / 60_000))
  return `The limit resets at ${new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (in about ${mins} min).`
}

// One request, one retry on a network error (this network sometimes breaks TLS for a moment). Never puts headers or tokens in a message.
async function request(url: string, accept: string, d: Deps): Promise<string> {
  const f = d.fetchImpl ?? fetch
  const now = d.now ?? Date.now
  let res: Response | null = null
  for (let i = 0; i < 2 && !res; i++) {
    try { res = await f(url, { headers: { Accept: accept, 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }) } catch {
      if (i === 0) await new Promise((r) => setTimeout(r, d.retryMs ?? 600))
    }
  }
  if (!res) throw new GithubError(UNREACHABLE)
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'))
    throw new GithubError(`GitHub is limiting how many requests Forge can make right now. ${resetText(res.headers, now())}`, res.status)
  if (res.status === 404) throw new GithubError('GitHub does not have that page.', 404)
  if (!res.ok) throw new GithubError(`GitHub answered with an error (${res.status}). Try again in a moment.`, res.status)
  return res.text()
}

// Same path through `gh api` when the plain call failed and the owner is logged in to the GitHub CLI. undefined means it did not help.
async function viaGh(path: string, d: Deps): Promise<unknown> {
  const run = d.run ?? defaultRun
  try {
    await run('gh', ['auth', 'status'])
    return JSON.parse(await run('gh', ['api', path, '-H', 'Accept: application/vnd.github+json']))
  } catch { return undefined }
}

// Logged in to the GitHub CLI? Then every call goes through it first: the plain anonymous quota is only 60 requests an hour, the owner's login has 5000.
// The answer is remembered for ten minutes (not when a test injects its own runner).
let ghState: { at: number; ok: boolean } | null = null
async function ghLoggedIn(d: Deps): Promise<boolean> {
  if (d.run) { try { await d.run('gh', ['auth', 'status']); return true } catch { return false } }
  const t = Date.now()
  if (ghState && t - ghState.at < 600_000) return ghState.ok
  let ok = false
  try { await defaultRun('gh', ['auth', 'status']); ok = true } catch { /* no gh, or not logged in */ }
  ghState = { at: t, ok }
  return ok
}

export async function getApi(path: string, d: Deps): Promise<unknown> {
  if (d.preferGh !== false && (await ghLoggedIn(d))) {
    try { return JSON.parse(await (d.run ?? defaultRun)('gh', ['api', path, '-H', 'Accept: application/vnd.github+json'])) } catch { /* a missing page, a hiccup: the plain call below decides */ }
  }
  try { return JSON.parse(await request(API + path, 'application/vnd.github+json', d)) } catch (e) {
    const status = (e as GithubError).status
    if (status && status !== 403 && status !== 429 && status < 500) throw e // a missing page stays missing with a login too
    const alt = await viaGh(path, d)
    if (alt !== undefined) return alt
    throw e instanceof GithubError ? e : new GithubError('GitHub sent an answer Forge could not read. Try again in a moment.')
  }
}

export async function cached<T>(key: string, ttl: number, refresh: boolean | undefined, d: Deps, load: () => Promise<T>): Promise<T> {
  const cache = d.cache ?? sharedCache
  const now = (d.now ?? Date.now)()
  const hit = cache.get(key)
  if (hit && !refresh && now - hit.at < ttl) return hit.value as T
  const value = await load()
  cache.set(key, { at: now, value })
  return value
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function mapApiRepo(r: Record<string, unknown>): TopRepo {
  const lic = str((r.license as { spdx_id?: unknown } | null)?.spdx_id)
  return {
    fullName: str(r.full_name), url: str(r.html_url), description: str(r.description), stars: num(r.stargazers_count), forks: num(r.forks_count),
    language: str(r.language) || null, topics: Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === 'string') : [],
    createdAt: str(r.created_at) || null, pushedAt: str(r.pushed_at) || null, ...(lic && lic !== 'NOASSERTION' ? { license: lic } : {}), sizeKb: num(r.size), fork: r.fork === true, archived: r.archived === true,
  }
}

async function newest(period: Period, d: Deps): Promise<TopRepo[]> {
  const q = period === 'all' ? 'stars:>1000' : `created:>${new Date((d.now ?? Date.now)() - DAYS[period] * 86_400_000).toISOString().slice(0, 10)}`
  const body = (await getApi(`/search/repositories?${new URLSearchParams({ q, sort: 'stars', order: 'desc', per_page: '100' })}`, d)) as { items?: unknown }
  if (!Array.isArray(body?.items)) throw new GithubError('GitHub sent an answer Forge could not read. Try again in a moment.')
  return body.items.map((r) => mapApiRepo(r as Record<string, unknown>)).filter((r) => NAME.test(r.fullName)).slice(0, 100)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, dec, hex, name) => (dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (ENTITIES[name.toLowerCase()] ?? m)))
const text = (html: string) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
const count = (s: string) => Number(s.replace(/[^\d]/g, '')) || 0

// Reads the article.Box-row blocks of github.com/trending.
export function parseTrending(html: string): TopRepo[] {
  const out: TopRepo[] = []
  for (const m of html.matchAll(/<article\b[^>]*\bBox-row\b[^>]*>[\s\S]*?<\/article>/g)) {
    const a = m[0]
    const fullName = /<h2[\s\S]*?<a\b[^>]*\bhref="\/([\w.-]+\/[\w.-]+)"/.exec(a)?.[1]
    if (!fullName) continue
    const link = (re: string) => new RegExp(`<a\\b[^>]*\\bhref="[^"]*/(?:${re})"[^>]*>([\\s\\S]*?)</a>`).exec(a)?.[1]
    const lang = /itemprop="programmingLanguage"[^>]*>([^<]*)</.exec(a)?.[1]
    const today = /([\d,]+)\s+stars?\s+(?:today|this week|this month)/i.exec(text(a))?.[1]
    out.push({
      fullName, url: `https://github.com/${fullName}`, description: text(/<p\b[^>]*>([\s\S]*?)<\/p>/.exec(a)?.[1] ?? ''),
      stars: count(text(link('stargazers') ?? '')), forks: count(text(link('forks|network/members') ?? '')), language: lang ? decode(lang).trim() || null : null,
      topics: [], createdAt: null, pushedAt: null, ...(today ? { starsToday: count(today) } : {}),
    })
  }
  return out
}

export async function topRepos(o: { period: Period; mode: Mode; refresh?: boolean }, d: Deps = {}): Promise<TopResult> {
  const { period, mode } = o
  if (!(period in DAYS) && period !== 'all') throw new Error('Unknown period.')
  if (mode !== 'new' && mode !== 'trending') throw new Error('Unknown list.')
  return cached(`top:${period}:${mode}`, TOP_TTL, o.refresh, d, async (): Promise<TopResult> => {
    const fetchedAt = (d.now ?? Date.now)()
    if (mode === 'new' || period === 'all') {
      return { items: await newest(period, d), period, mode: 'new', fetchedAt, ...(mode === 'trending' ? { note: 'GitHub has no trending list for all time, so this shows the most starred repositories ever.' } : {}) }
    }
    const items = parseTrending(await request(`https://github.com/trending?since=${SINCE[period]}`, 'text/html', d))
    if (!items.length) throw new GithubError('Forge could not read the GitHub trending page. Try Newest hits instead.')
    return { items, period, mode, fetchedAt, ...(items.length < 100 ? { note: `GitHub's trending page lists only ${items.length} repositories, so this list is shorter than 100.` } : {}) }
  })
}

// The first paragraph of a README that says something: no headings, badges, pictures, tables, lists or link markup.
export function firstParagraph(md: string, max = 400): string {
  const src = md.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?(```|$)/g, '\n\n').replace(/~~~[\s\S]*?(~~~|$)/g, '\n\n')
    .replace(/<(h[1-6]|svg|script|style|picture|summary)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n\n').replace(/<\/?(p|div|br|li|ul|ol|table|tr|td|th|details|center|blockquote|hr|img)\b[^>]*>/gi, '\n\n')
  for (const para of src.split(/\n\s*\n/)) {
    const lines = para.trim().split('\n')
    if (/^\s*(#|[-*+]\s|\d+[.)]\s|\||={3,}|-{3,}|\[[^\]]+\]:\s)/.test(lines[0]) || (lines[1] && /^(=+|-+)\s*$/.test(lines[1].trim()))) continue
    const clean = decode(para.replace(/^\s*>\s?/gm, '').replace(/!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]/g, '').replace(/\[([^\]]*)\]\([^)]*\)|\[([^\]]*)\]\[[^\]]*\]/g, '$1$2')
      .replace(/<[^>]*>/g, '').replace(/[`*_~]{1,3}/g, '')).replace(/\s+/g, ' ').trim()
    if ((clean.match(/\p{L}{2,}/gu) ?? []).length < 4) continue
    // a row of language links or badges ("EN • 中文 • 日本語 • ...", flags, pipes) is navigation, not a description
    if ((clean.match(/\s[•·|]\s/g) ?? []).length >= 3 || (clean.match(/\p{Regional_Indicator}/gu) ?? []).length >= 4) continue
    if (clean.length < 25 && !/[.!?]/.test(clean)) continue
    if (clean.length <= max) return clean
    const cut = clean.slice(0, max)
    const end = Math.max(...[...cut.matchAll(/[.!?](?=\s|$)/g)].map((x) => x.index!), -1)
    return end >= 40 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`
  }
  return ''
}

// One repository's own record: topics and size. Shared by the summary and the clone size question.
export type RepoMeta = {
  topics?: unknown; size?: unknown; stargazers_count?: unknown; description?: unknown; created_at?: unknown; pushed_at?: unknown; language?: unknown
  license?: { spdx_id?: unknown } | null; owner?: { type?: unknown }; archived?: unknown; fork?: unknown
}
export const repoMeta = (fullName: string, d: Deps) =>
  cached(`meta:${fullName.toLowerCase()}`, SUMMARY_TTL, false, d, () => getApi(`/repos/${fullName}`, d) as Promise<RepoMeta>)
const topicsOf = (meta: { topics?: unknown } | null) => (Array.isArray(meta?.topics) ? meta.topics.filter((t): t is string => typeof t === 'string') : [])

export async function repoSize(fullName: string, d: Deps = {}): Promise<number> {
  if (!validRepoName(fullName)) throw new Error('That is not a GitHub repository name.')
  return num((await repoMeta(fullName, d)).size)
}

export async function repoSummary(fullName: string, d: Deps = {}): Promise<RepoSummary> {
  if (!validRepoName(fullName)) throw new Error('That is not a GitHub repository name.')
  return cached(`summary:${fullName.toLowerCase()}`, SUMMARY_TTL, false, d, async () => {
    const [readme, meta] = await Promise.all([
      getApi(`/repos/${fullName}/readme`, d).catch((e) => { if ((e as GithubError).status === 404) return null; throw e }),
      repoMeta(fullName, d).catch(() => null), // topics and size are a bonus; the README is what was asked for
    ]) as [{ content?: unknown; encoding?: unknown } | null, { topics?: unknown; size?: unknown } | null]
    const md = readme && readme.encoding === 'base64' && typeof readme.content === 'string' ? Buffer.from(readme.content.replace(/\s/g, ''), 'base64').toString('utf8') : ''
    return { fullName, whatItDoes: firstParagraph(md), topics: topicsOf(meta), ...(meta && typeof meta.size === 'number' ? { sizeKb: meta.size } : {}) }
  })
}

// Skill-like repositories for Settings > Skills "More suggestions": one search per topic, one after another (the Search API allows 10 a minute
// without a login), stopping as soon as a round has enough. Page N+1 of every topic is read for round N, so each round is new repositories.
const SUGGEST_QUERIES = [...['claude-skills', 'agent-skills', 'claude-code-skills', 'codex-skills', 'ai-agent-skills', 'anthropic-skills', 'claude-code', 'agentic-coding', 'prompt-library'].map((t) => `topic:${t}`), 'SKILL.md in:readme']
export const SUGGESTIONS_PER_ROUND = 20
const MAX_AGE_MS = 548 * 86_400_000 // about 18 months

export type SkillSuggestion = Pick<TopRepo, 'fullName' | 'url' | 'description' | 'stars' | 'language' | 'topics' | 'pushedAt' | 'sizeKb' | 'license'>

export async function skillSuggestions(o: { round: number; exclude: string[] }, d: Deps = {}): Promise<SkillSuggestion[]> {
  const page = Math.max(0, Math.min(50, Math.floor(o.round) || 0)) + 1
  const skip = new Set(o.exclude.map((n) => n.toLowerCase()))
  const since = new Date((d.now ?? Date.now)() - MAX_AGE_MS)
  const found = new Map<string, TopRepo>()
  for (const [i, term] of SUGGEST_QUERIES.entries()) {
    if (i) await new Promise((r) => setTimeout(r, d.gapMs ?? 1200))
    let items: Record<string, unknown>[]
    try {
      const q = `${term} stars:>=5 pushed:>${since.toISOString().slice(0, 10)} archived:false`
      const body = await cached(`suggest:${q}:${page}`, TOP_TTL, false, d, () => getApi(`/search/repositories?${new URLSearchParams({ q, sort: 'stars', order: 'desc', per_page: '30', page: String(page) })}`, d)) as { items?: unknown }
      items = Array.isArray(body?.items) ? body.items as Record<string, unknown>[] : []
    } catch (e) {
      if (found.size) break // keep what was found
      const status = (e as GithubError).status
      throw status === 429 || status === 403 ? new GithubError('GitHub is limiting searches right now. Wait a minute and try again.', status) : e
    }
    for (const r of items) {
      const repo = mapApiRepo(r)
      if (!NAME.test(repo.fullName) || skip.has(repo.fullName.toLowerCase()) || r.archived === true || r.fork === true) continue
      if (repo.stars < 5 || !repo.pushedAt || Date.parse(repo.pushedAt) < since.getTime()) continue
      found.set(repo.fullName, repo)
    }
    if (found.size >= SUGGESTIONS_PER_ROUND) break
  }
  return [...found.values()].sort((a, b) => b.stars - a.stars).slice(0, SUGGESTIONS_PER_ROUND)
    .map(({ fullName, url, description, stars, language, topics, pushedAt, sizeKb, license }) => ({ fullName, url, description, stars, language, topics, pushedAt, sizeKb, ...(license ? { license } : {}) }))
}

// GitHub has no "verified repository", but organisations can be verified: GET /orgs/{owner} says so, and a personal account answers 404.
export type OwnerInfo = { type: 'org' | 'user'; verified: boolean }
export type OwnerResult = OwnerInfo & { checked: boolean }
export type OwnersChecked = { owners: Record<string, OwnerResult>; checked: number; total: number; stopped: 'rate' | 'error' | null }
const OWNER_TTL = 24 * 3_600_000
const OWNER_CONCURRENCY = 4
const validOwner = (o: string) => /^[\w.-]{1,39}$/.test(o) && !/^\.+$/.test(o)

export async function ownerInfo(owner: string, d: Deps = {}): Promise<OwnerInfo> {
  if (!validOwner(owner)) throw new Error('That is not a GitHub account name.')
  return cached(`owner:${owner.toLowerCase()}`, OWNER_TTL, false, d, async (): Promise<OwnerInfo> => {
    try { return { type: 'org', verified: ((await getApi(`/orgs/${owner}`, d)) as { is_verified?: unknown })?.is_verified === true } } catch (e) {
      if ((e as GithubError).status === 404) return { type: 'user', verified: false }
      throw e
    }
  })
}

// Runs fn over the items, four at a time. A rate limit or a network failure stops it cleanly: no new item starts and `stopped` says why.
async function eachLimited<T>(list: T[], fn: (x: T) => Promise<void>): Promise<'rate' | 'error' | null> {
  let next = 0
  let stopped: 'rate' | 'error' | null = null
  await Promise.all(Array.from({ length: Math.min(OWNER_CONCURRENCY, list.length) }, async () => {
    while (!stopped && next < list.length) {
      try { await fn(list[next++]) } catch (e) {
        const status = (e as GithubError).status
        stopped ??= status === 403 || status === 429 ? 'rate' : 'error'
      }
    }
  }))
  return stopped
}

// Owners not reached come back with checked: false.
export async function ownersVerified(owners: string[], d: Deps = {}): Promise<OwnersChecked> {
  const list = [...new Set(owners)]
  const out: Record<string, OwnerResult> = {}
  const stopped = await eachLimited(list, async (owner) => { out[owner] = { ...(await ownerInfo(owner, d)), checked: true } })
  for (const o of list) out[o] ??= { type: 'user', verified: false, checked: false }
  return { owners: out, checked: list.filter((o) => out[o].checked).length, total: list.length, stopped }
}

// Current star counts and descriptions for saved repositories (one cached lookup each, an hour).
export type StarsChecked = { stars: Record<string, { stars: number; description: string }>; checked: number; total: number; stopped: 'rate' | 'error' | null }
export async function refreshStars(names: string[], d: Deps = {}): Promise<StarsChecked> {
  const list = [...new Set(names)].filter(validRepoName)
  const stars: StarsChecked['stars'] = {}
  const stopped = await eachLimited(list, async (n) => { const m = await repoMeta(n, d); stars[n] = { stars: num(m.stargazers_count), description: str(m.description) } })
  return { stars, checked: Object.keys(stars).length, total: list.length, stopped }
}
