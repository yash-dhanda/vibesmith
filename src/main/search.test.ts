import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat, ChatSummary } from './chatStore'
import { clearSearchCache, queryWords, searchAll, snippetOf, type SearchDeps } from './search'
import type { RunSummary } from './team/service'
import type { Run } from './team/types'

const chat = (id: string, title: string, said: string[], updatedAt: number, extra: Chat['transcript'] = []): Chat =>
  ({ id, title, project: '/p/one', createdAt: 1, updatedAt, pinned: false, transcript: [...said.map((text) => ({ type: 'user', text })), ...extra], messages: [], checkpoints: {} }) as unknown as Chat
const summary = (c: Chat): ChatSummary => ({ id: c.id, title: c.title, project: c.project, updatedAt: c.updatedAt })
const runRec = (id: string, goal: string, updatedAt: number, over: Partial<Run> = {}): Run =>
  ({ id, goal, project: '/p/one', updatedAt, tasks: [{ title: 'Write the parser', goal: 'parse things', summary: 'done' }], messages: [{ body: 'handoff about the cache layer' }], decisions: [{ text: 'use sqlite' }], final: { report: 'All good' }, ...over }) as unknown as Run
const sumRun = (r: Run): RunSummary => ({ id: r.id, goal: r.goal, project: r.project, updatedAt: r.updatedAt }) as RunSummary

function deps(chats: Chat[], runs: Run[], history = ''): SearchDeps & { loadChat: ReturnType<typeof vi.fn>; readHistory: ReturnType<typeof vi.fn> } {
  return {
    listChats: () => chats.map(summary),
    loadChat: vi.fn((id: string) => chats.find((c) => c.id === id) ?? null),
    listRuns: () => runs.map(sumRun),
    getRun: (id) => runs.find((r) => r.id === id) ?? null,
    historyStamp: () => (history ? 7 : 0),
    readHistory: vi.fn(() => history),
  }
}
beforeEach(clearSearchCache)

describe('searchAll', () => {
  it('needs every word, in any order, ignoring case', () => {
    const d = deps([chat('a', 'Login bug', ['The Session cookie expires early'], 10), chat('b', 'Other', ['session only'], 20)], [])
    expect(searchAll('COOKIE session', d).map((h) => h.id)).toEqual(['a'])
    expect(searchAll('session cookie nothing', d)).toEqual([])
    expect(searchAll('a', d)).toEqual([])
  })

  it('ranks title and goal hits above body hits, then newest first', () => {
    const d = deps(
      [chat('body-new', 'Chat one', ['we talked about invoices'], 300), chat('title-old', 'Invoices', ['x'], 100), chat('body-old', 'Chat two', ['invoices too'], 200)],
      [runRec('r1', 'Build invoices page', 150, { messages: [], tasks: [], decisions: [], final: undefined })],
    )
    expect(searchAll('invoices', d).map((h) => h.id)).toEqual(['r1', 'title-old', 'body-new', 'body-old'])
  })

  it('searches runs by task titles, messages, decisions and the report, and history by line', () => {
    const d = deps([], [runRec('r1', 'Goal', 5, { final: { report: 'shipped the zebra feature' } as Run['final'] })], '[2026-11-05 10:22 +00:00] Run r1 is done\n[2026-11-05 11:00 +00:00] Forge to all (decision): use sqlite\nWHAT HAPPENED')
    expect(searchAll('parser', d).map((h) => h.kind)).toEqual(['run'])
    expect(searchAll('cache layer', d)[0].id).toBe('r1')
    expect(searchAll('zebra', d)[0].kind).toBe('run')
    const h = searchAll('sqlite', d)
    expect(h.map((x) => x.kind).sort()).toEqual(['history', 'run'])
    const line = h.find((x) => x.kind === 'history')!
    expect(line.at).toBe(Date.parse('2026-11-05T11:00:00+00:00'))
    expect(line.snippet.text).toContain('use sqlite')
    expect(line.snippet.text).not.toContain('2026-11-05')
  })

  it('skips tool output in chats', () => {
    const c = chat('a', 'T', ['hello'], 1, [{ type: 'tool_result', output: 'secretneedle' } as never, { type: 'delta', text: 'the assistant says pineapple' } as never])
    const d = deps([c], [])
    expect(searchAll('secretneedle', d)).toEqual([])
    expect(searchAll('pineapple', d)).toHaveLength(1)
  })

  it('returns at most 40 hits and honors the character cap', () => {
    const many = Array.from({ length: 60 }, (_, i) => chat(`c${i}`, `Chat ${i}`, ['needle'], i))
    expect(searchAll('needle', deps(many, [])).length).toBe(40)
    const big = chat('big', 'Big', ['x'.repeat(500) + ' farneedle'], 1)
    expect(searchAll('farneedle', deps([big], []), { charsPerItem: 100 })).toEqual([])
    clearSearchCache()
    expect(searchAll('farneedle', deps([big], []))).toHaveLength(1)
  })

  it('reads a chat once until it is saved again', () => {
    const c = chat('a', 'Plan', ['alpha beta'], 10)
    const d = deps([c], [])
    searchAll('alpha', d)
    searchAll('beta', d)
    searchAll('alph', d)
    expect(d.loadChat).toHaveBeenCalledTimes(1)
    c.transcript.push({ type: 'user', text: 'gamma arrives' })
    expect(searchAll('gamma', d)).toEqual([]) // same updatedAt: still the cached text
    c.updatedAt = 11
    expect(searchAll('gamma', d)).toHaveLength(1)
    expect(d.loadChat).toHaveBeenCalledTimes(2)
  })

  it('forgets chats that were deleted and re-reads history only when its stamp changes', () => {
    const a = chat('a', 'Plan', ['alpha'], 10)
    const list = [a]
    const d = { ...deps(list, [runRec('r', 'g', 1)], 'line alpha'), listChats: () => list.map(summary) }
    searchAll('alpha', d)
    searchAll('alpha', d)
    expect(d.readHistory).toHaveBeenCalledTimes(1)
    list.length = 0
    expect(searchAll('alpha', d).map((h) => h.kind)).toEqual(['history'])
    list.push(a)
    searchAll('alpha', d)
    expect(d.loadChat).toHaveBeenCalledTimes(2)
  })
})

describe('snippetOf', () => {
  it('centres on the first match, marks cut ends and ranges every word', () => {
    const text = 'lorem ipsum '.repeat(30) + 'The Quick brown fox jumps over the lazy dog ' + 'dolor sit '.repeat(30)
    const s = snippetOf(text, queryWords('quick lazy'))
    expect(s.text.length).toBeLessThanOrEqual(142)
    expect(s.text.startsWith('…') && s.text.endsWith('…')).toBe(true)
    expect(s.ranges.map(([a, b]) => s.text.slice(a, b))).toEqual(['Quick', 'lazy'])
  })
  it('does not add ellipses to short text and merges overlapping words', () => {
    const s = snippetOf('hello  world', ['hello', 'hell', 'world'])
    expect(s.text).toBe('hello world')
    expect(s.ranges).toEqual([[0, 5], [6, 11]])
  })
})
