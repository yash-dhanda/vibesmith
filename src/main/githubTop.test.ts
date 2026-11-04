import { describe, expect, it, vi } from 'vitest'
import { firstParagraph, ownerInfo, ownersVerified, parseTrending, repoSize, repoSummary, skillSuggestions, topRepos, type Deps } from './githubTop'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const apiRepo = (n: number, extra: Record<string, unknown> = {}) => ({
  full_name: `o${n}/r${n}`, html_url: `https://github.com/o${n}/r${n}`, description: n % 2 ? null : `repo ${n}`, stargazers_count: 1000 - n, forks_count: n,
  language: n % 2 ? null : 'Go', topics: ['a', 'b'], created_at: '2026-11-04T00:00:00Z', pushed_at: '2026-11-05T00:00:00Z', license: { spdx_id: 'MIT' }, size: 1234, ...extra,
})
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init })
const mk = (handler: (url: string) => Response | Promise<Response>): { d: Deps; calls: string[] } => {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => { calls.push(String(url)); return handler(String(url)) }) as unknown as typeof fetch
  return { calls, d: { fetchImpl, now: () => NOW, cache: new Map(), retryMs: 0, run: async () => { throw new Error('no gh') } } }
}

const article = (name: string, desc: string | null, lang: string | null, stars: string, forks: string, today: string) => `
<article class="Box-row">
  <div class="float-right d-flex"><form><button>Star</button></form></div>
  <h2 class="h3 lh-condensed">
    <a href="/${name}" data-view-component="true" class="Link">
      <svg class="octicon" width="16" height="16"><path d="M2 2"/></svg>
      <span data-view-component="true" class="text-normal">${name.split('/')[0]} / </span>
      ${name.split('/')[1]}
    </a>
  </h2>
  ${desc === null ? '' : `<p class="col-9 color-fg-muted my-1 pr-4">\n      ${desc}\n    </p>`}
  <div class="f6 color-fg-muted mt-2">
    ${lang === null ? '' : `<span class="d-inline-block ml-0 mr-3"><span class="repo-language-color" style="background-color: #178600"></span><span itemprop="programmingLanguage">${lang}</span></span>`}
    <a href="/${name}/stargazers" class="Link Link--muted d-inline-block mr-3"><svg class="octicon"></svg>\n      ${stars}\n    </a>
    <a href="/${name}/forks" class="Link Link--muted d-inline-block mr-3"><svg class="octicon"></svg>\n      ${forks}\n    </a>
    <span class="d-inline-block mr-3">Built by <a href="/x"><img alt="@x" src="https://avatars.githubusercontent.com/u/1"></a></span>
    <span class="d-inline-block float-sm-right"><svg class="octicon"></svg> ${today}</span>
  </div>
</article>`
const TRENDING = `<html><body><div class="Box"><div>${[
  article('acme/rocket', 'Fast &amp; small <b>rocket</b> toolkit', 'TypeScript', '12,345', '1,234', '1,024 stars today'),
  article('dotnet/sharp-thing', null, 'C#', '900', '40', '35 stars today'),
  article('lone/wolf', 'It\\&#39;s a wolf', null, '77', '2', '5 stars today'),
].join('\n')}</div></div></body></html>`

describe('Newest hits', () => {
  it.each([['day', '2026-11-04'], ['week', '2026-10-29'], ['month', '2026-10-06']] as const)('searches repositories created in the last %s', async (period, date) => {
    const { d, calls } = mk(() => json({ items: [apiRepo(1)] }))
    await topRepos({ period, mode: 'new' }, d)
    const u = new URL(calls[0])
    expect(u.origin + u.pathname).toBe('https://api.github.com/search/repositories')
    expect(u.searchParams.get('q')).toBe(`created:>${date}`)
    expect(Object.fromEntries(['sort', 'order', 'per_page'].map((k) => [k, u.searchParams.get(k)]))).toEqual({ sort: 'stars', order: 'desc', per_page: '100' })
  })

  it('uses the most starred of all time for "all", even for trending, and says so', async () => {
    const { d, calls } = mk(() => json({ items: [apiRepo(1)] }))
    const r = await topRepos({ period: 'all', mode: 'trending' }, d)
    expect(new URL(calls[0]).searchParams.get('q')).toBe('stars:>1000')
    expect(r.mode).toBe('new')
    expect(r.note).toMatch(/all time/)
  })

  it('maps the fields', async () => {
    const { d } = mk(() => json({ items: [apiRepo(1), apiRepo(2, { license: { spdx_id: 'NOASSERTION' } })] }))
    const { items } = await topRepos({ period: 'day', mode: 'new' }, d)
    expect(items[0]).toEqual({ fullName: 'o1/r1', url: 'https://github.com/o1/r1', description: '', stars: 999, forks: 1, language: null, topics: ['a', 'b'], createdAt: '2026-11-04T00:00:00Z', pushedAt: '2026-11-05T00:00:00Z', license: 'MIT', sizeKb: 1234, fork: false, archived: false })
    expect(items[1]).toMatchObject({ description: 'repo 2', language: 'Go' })
    expect(items[1].license).toBeUndefined()
  })

  it('sends a User-Agent and the GitHub Accept header', async () => {
    const seen: Record<string, string>[] = []
    const { d } = mk(() => json({ items: [] }))
    d.fetchImpl = (async (_u: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return json({ items: [] }) }) as unknown as typeof fetch
    await topRepos({ period: 'day', mode: 'new' }, d)
    expect(seen[0]).toMatchObject({ 'User-Agent': 'Forge-desktop', Accept: 'application/vnd.github+json' })
  })

  it('caches for ten minutes and refresh bypasses the cache', async () => {
    let now = NOW
    const { d, calls } = mk(() => json({ items: [apiRepo(1)] }))
    d.now = () => now
    await topRepos({ period: 'day', mode: 'new' }, d)
    await topRepos({ period: 'day', mode: 'new' }, d)
    expect(calls).toHaveLength(1)
    await topRepos({ period: 'day', mode: 'new', refresh: true }, d)
    expect(calls).toHaveLength(2)
    now += 11 * 60_000
    await topRepos({ period: 'day', mode: 'new' }, d)
    expect(calls).toHaveLength(3)
    await topRepos({ period: 'week', mode: 'new' }, d)
    expect(calls).toHaveLength(4)
  })

  it('retries once after a network error, then gives a human message', async () => {
    let n = 0
    const { d } = mk(() => { if (n++ === 0) throw new TypeError('fetch failed'); return json({ items: [apiRepo(1)] }) })
    expect((await topRepos({ period: 'day', mode: 'new' }, d)).items).toHaveLength(1)
    const bad = mk(() => { throw new TypeError('fetch failed: secret-token-123') })
    const e = await topRepos({ period: 'day', mode: 'new' }, bad.d).catch((x: Error) => x)
    expect((e as Error).message).toBe('GitHub could not be reached. Check your connection and try again.')
    expect(bad.calls).toHaveLength(2)
  })

  it('explains a used-up rate limit with the reset time, without headers', async () => {
    const reset = String(Math.floor(NOW / 1000) + 600)
    const { d } = mk(() => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset, authorization: 'token abc' } }))
    const e = (await topRepos({ period: 'day', mode: 'new' }, d).catch((x: Error) => x)) as Error
    expect(e.message).toMatch(/limiting how many requests/)
    expect(e.message).toMatch(/resets at .* \(in about 10 min\)/)
    expect(e.message).not.toMatch(/token|abc/)
  })

  it('retries the same path with gh when the plain call fails and gh is logged in', async () => {
    const { d, calls } = mk(() => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
    const run = vi.fn(async (_c: string, a: string[]) => (a[0] === 'auth' ? 'Logged in' : JSON.stringify({ items: [apiRepo(1)] })))
    d.run = run
    d.preferGh = false
    const r = await topRepos({ period: 'day', mode: 'new' }, d)
    expect(r.items[0].fullName).toBe('o1/r1')
    expect(run.mock.calls[0]).toEqual(['gh', ['auth', 'status']])
    const path = run.mock.calls[1][1][1]
    expect(path).toBe(calls[0].replace('https://api.github.com', ''))
  })

  it('goes through gh first when it is logged in, without spending the anonymous quota', async () => {
    const { d, calls } = mk(() => new Response('', { status: 500 }))
    d.run = vi.fn(async (_c: string, a: string[]) => (a[0] === 'auth' ? 'Logged in' : JSON.stringify({ items: [apiRepo(1)] })))
    const r = await topRepos({ period: 'day', mode: 'new' }, d)
    expect(r.items[0].fullName).toBe('o1/r1')
    expect(calls).toHaveLength(0) // no plain request at all
  })

  it('keeps the original error when gh is missing or logged out', async () => {
    const { d } = mk(() => new Response('', { status: 429 }))
    d.run = async () => { throw new Error('gh: command not found') }
    expect(((await topRepos({ period: 'day', mode: 'new' }, d).catch((x: Error) => x)) as Error).message).toMatch(/limiting/)
  })
})

describe('Trending on GitHub', () => {
  it('parses the page', () => {
    const items = parseTrending(TRENDING)
    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({ fullName: 'acme/rocket', url: 'https://github.com/acme/rocket', description: 'Fast & small rocket toolkit', stars: 12345, forks: 1234, language: 'TypeScript', topics: [], createdAt: null, pushedAt: null, starsToday: 1024 })
    expect(items[1]).toMatchObject({ fullName: 'dotnet/sharp-thing', description: '', language: 'C#', stars: 900, forks: 40, starsToday: 35 })
    expect(items[2]).toMatchObject({ language: null, description: "It\\'s a wolf", starsToday: 5 })
  })

  it('also reads "this week" and "this month"', () => {
    expect(parseTrending(article('a/b', 'x', 'Go', '1', '1', '2,000 stars this week'))[0].starsToday).toBe(2000)
    expect(parseTrending(article('a/b', 'x', 'Go', '1', '1', '9 stars this month'))[0].starsToday).toBe(9)
  })

  it('requests the matching "since" and notes that the list is short', async () => {
    const { d, calls } = mk(() => new Response(TRENDING))
    const r = await topRepos({ period: 'week', mode: 'trending' }, d)
    expect(calls[0]).toBe('https://github.com/trending?since=weekly')
    expect(r).toMatchObject({ mode: 'trending', period: 'week' })
    expect(r.note).toMatch(/only 3 repositories/)
  })

  it('fails clearly when the page no longer parses', async () => {
    const { d } = mk(() => new Response('<html>changed</html>'))
    expect(((await topRepos({ period: 'day', mode: 'trending' }, d).catch((x: Error) => x)) as Error).message).toMatch(/Newest hits/)
  })

  it('rejects unknown periods and modes', async () => {
    await expect(topRepos({ period: 'year' as never, mode: 'new' }, mk(() => json({})).d)).rejects.toThrow()
    await expect(topRepos({ period: 'day', mode: 'x' as never }, mk(() => json({})).d)).rejects.toThrow()
  })
})

describe('README summary', () => {
  const README = `# Project

[![Build](https://img.shields.io/x.svg)](https://ci) ![Logo](logo.png)

<p align="center"><img src="a.png"></p>

<h1 align="center">Rocket</h1>

<p align="center">
  <a href="https://x.dev">Docs</a> | <a href="https://y.dev">Blog</a>
</p>

Rocket is a **fast**, [tiny](https://example.com) toolkit for building \`launch\` scripts. It has no dependencies. ${'More words follow here. '.repeat(30)}

## Install
`
  it('skips badges, html, headings and nav links and cuts at a sentence', () => {
    const p = firstParagraph(README)
    expect(p.startsWith('Rocket is a fast, tiny toolkit for building launch scripts. It has no dependencies.')).toBe(true)
    expect(p.length).toBeLessThanOrEqual(400)
    expect(p.endsWith('.')).toBe(true)
    expect(p).not.toMatch(/[<>\[\]`*]|http/)
  })
  it('handles html-only READMEs and finds nothing in an empty one', () => {
    expect(firstParagraph('<div align="center">\n<img src="x.png">\n<h1>Name</h1>\n<p>Name turns markdown notes into a searchable site.</p>\n</div>')).toBe('Name turns markdown notes into a searchable site.')
    expect(firstParagraph('# Title\n\n![x](y.png)\n')).toBe('')
  })

  it('loads the README and the topics, and validates the name', async () => {
    const b64 = Buffer.from('# T\n\nThis library does one useful thing very well for you.\n').toString('base64').replace(/(.{20})/g, '$1\n')
    const { d, calls } = mk((u) => (u.endsWith('/readme') ? json({ encoding: 'base64', content: b64 }) : json({ topics: ['cli', 'go'] })))
    const s = await repoSummary('acme/rocket', d)
    expect(s).toEqual({ fullName: 'acme/rocket', whatItDoes: 'This library does one useful thing very well for you.', topics: ['cli', 'go'] })
    await repoSummary('acme/rocket', d)
    expect(calls).toHaveLength(2) // cached for an hour
    for (const bad of ['acme', 'a/b/c', '../x', 'a/..', 'a b/c', 'a/b?x=1', '']) await expect(repoSummary(bad, d)).rejects.toThrow(/repository name/)
    expect(calls).toHaveLength(2)
  })

  it('treats a missing README as empty', async () => {
    const { d } = mk((u) => (u.endsWith('/readme') ? new Response('', { status: 404 }) : json({ topics: [] })))
    expect((await repoSummary('acme/none', d)).whatItDoes).toBe('')
  })
})

describe('repo size and skill suggestions', () => {
  it('reads a repository size in KB once an hour', async () => {
    const { d, calls } = mk(() => json({ size: 4096, topics: [] }))
    expect(await repoSize('acme/rocket', d)).toBe(4096)
    expect(await repoSize('acme/rocket', d)).toBe(4096)
    expect(calls).toEqual(['https://api.github.com/repos/acme/rocket'])
    await expect(repoSize('../x', d)).rejects.toThrow(/repository name/)
  })

  const sk = (n: number, extra: Record<string, unknown> = {}) => apiRepo(n, { stargazers_count: 100 - n, pushed_at: '2026-10-01T00:00:00Z', ...extra })
  const sugg = (handler: (u: URL) => Response) => { const m = mk((u) => handler(new URL(u))); m.d.gapMs = 0; return m }

  it('searches each topic in turn for page round+1 and stops once 20 are found', async () => {
    const { d, calls } = sugg((u) => json({ items: Array.from({ length: 30 }, (_, i) => sk(Number(u.searchParams.get('page')) * 100 + i, { stargazers_count: 500 - i })) }))
    const r = await skillSuggestions({ round: 2, exclude: [] }, d)
    expect(r).toHaveLength(20)
    expect(calls).toHaveLength(1) // the first topic already had 30
    const u = new URL(calls[0])
    expect(u.searchParams.get('q')).toMatch(/^topic:claude-skills stars:>=5 pushed:>2025-05-06 archived:false$/)
    expect(Object.fromEntries(['sort', 'order', 'per_page', 'page'].map((k) => [k, u.searchParams.get(k)]))).toEqual({ sort: 'stars', order: 'desc', per_page: '30', page: '3' })
    expect(Object.keys(r[0]).sort()).toEqual(['description', 'fullName', 'language', 'license', 'pushedAt', 'sizeKb', 'stars', 'topics', 'url'])
  })

  it('merges topics, dedupes, and drops excluded, archived, forked, tiny and stale repos', async () => {
    const items = [sk(1), sk(2), sk(3, { archived: true }), sk(4, { fork: true }), sk(5, { stargazers_count: 4 }), sk(6, { pushed_at: '2024-01-01T00:00:00Z' }), sk(7), sk(8)]
    const { d, calls } = sugg(() => json({ items }))
    const r = await skillSuggestions({ round: 0, exclude: ['O2/R2'] }, d)
    expect(r.map((x) => x.fullName)).toEqual(['o1/r1', 'o7/r7', 'o8/r8'])
    expect(r.map((x) => x.stars)).toEqual([...r.map((x) => x.stars)].sort((a, b) => b - a))
    expect(calls).toHaveLength(10) // fewer than 20 each time, so every topic and the README search ran
    expect(new URL(calls[9]).searchParams.get('q')).toMatch(/^SKILL\.md in:readme /)
  })

  it('caches each (topic, page) for ten minutes', async () => {
    const { d, calls } = sugg(() => json({ items: [sk(1)] }))
    await skillSuggestions({ round: 0, exclude: [] }, d)
    await skillSuggestions({ round: 0, exclude: ['o1/r1'] }, d)
    expect(calls).toHaveLength(10)
    await skillSuggestions({ round: 1, exclude: [] }, d)
    expect(calls).toHaveLength(20)
  })

  it('says to wait a minute on a rate limit, but keeps what it already found', async () => {
    let n = 0
    const { d } = sugg(() => (n++ < 2 ? json({ items: [sk(1)] }) : new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })))
    expect((await skillSuggestions({ round: 0, exclude: [] }, d)).map((x) => x.fullName)).toEqual(['o1/r1'])
    const limited = sugg(() => new Response('', { status: 429 }))
    await expect(skillSuggestions({ round: 0, exclude: [] }, limited.d)).rejects.toThrow(/Wait a minute and try again/)
  })

  it('skips a row of language links and flags before the real description', () => {
    const md = '# Tool\n\n🇨🇳 中文 • 🇹🇼 繁體中文 • 🇯🇵 日本語 • 🇵🇹 Português • 🇰🇷 한국어\n\nEN | FR | DE | ES | IT\n\nA command line tool that converts markdown files into slide decks.\n'
    expect(firstParagraph(md)).toBe('A command line tool that converts markdown files into slide decks.')
  })
})

describe('verified owners', () => {
  const orgs: Record<string, unknown> = { acme: { is_verified: true }, loose: { is_verified: false }, plain: { is_verified: undefined } }
  const owners = (extra?: (u: string) => Response | undefined) => mk((u) => {
    const name = u.split('/orgs/')[1]
    return extra?.(name) ?? (name in orgs ? json(orgs[name]) : new Response('{"message":"Not Found"}', { status: 404 }))
  })

  it('reads verified orgs, unverified orgs and users (404)', async () => {
    const { d, calls } = owners()
    expect(await ownerInfo('acme', d)).toEqual({ type: 'org', verified: true })
    expect(await ownerInfo('loose', d)).toEqual({ type: 'org', verified: false })
    expect(await ownerInfo('plain', d)).toEqual({ type: 'org', verified: false })
    expect(await ownerInfo('someone', d)).toEqual({ type: 'user', verified: false })
    expect(calls[0]).toBe('https://api.github.com/orgs/acme')
    await expect(ownerInfo('../x', d)).rejects.toThrow(/account name/)
  })

  it('caches an owner for 24 hours, users included', async () => {
    let now = NOW
    const { d, calls } = owners()
    d.now = () => now
    await ownerInfo('acme', d); await ownerInfo('someone', d); await ownerInfo('acme', d); await ownerInfo('someone', d)
    expect(calls).toHaveLength(2)
    now += 25 * 3_600_000
    await ownerInfo('acme', d)
    expect(calls).toHaveLength(3)
  })

  it('checks a batch with at most four requests in flight and counts them', async () => {
    let live = 0, peak = 0
    const m = mk(() => json({ is_verified: true }))
    m.d.fetchImpl = (async (u: string) => { m.calls.push(u); live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return json({ is_verified: true }) }) as unknown as typeof fetch
    const names = Array.from({ length: 10 }, (_, i) => `org${i}`)
    const r = await ownersVerified([...names, 'org0'], m.d)
    expect(peak).toBe(4)
    expect(r).toMatchObject({ checked: 10, total: 10, stopped: null })
    expect(Object.values(r.owners).every((o) => o.checked && o.verified && o.type === 'org')).toBe(true)
  })

  it('stops cleanly at a rate limit and says how many owners were reached', async () => {
    let n = 0
    const { d, calls } = owners(() => (n++ < 2 ? json({ is_verified: true }) : new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })))
    const names = Array.from({ length: 12 }, (_, i) => `o${i}`)
    const r = await ownersVerified(names, d)
    expect(r.stopped).toBe('rate')
    expect(r.total).toBe(12)
    expect(r.checked).toBe(2)
    expect(Object.values(r.owners).filter((o) => !o.checked)).toHaveLength(10)
    expect(calls.length).toBeLessThanOrEqual(2 + 4) // the workers already running finish; no new ones start
  })

  it('uses gh for owners when the plain call is limited and gh is logged in', async () => {
    const { d } = owners(() => new Response('', { status: 429 }))
    d.run = async (_c, a) => (a[0] === 'auth' ? 'ok' : JSON.stringify({ is_verified: true }))
    expect(await ownersVerified(['acme'], d)).toMatchObject({ checked: 1, stopped: null, owners: { acme: { verified: true } } })
  })
})
