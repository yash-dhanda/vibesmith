import { basename } from 'node:path'
import type { Chat, ChatSummary } from './chatStore'
import type { RunSummary } from './team/service'
import type { Run } from './team/types'

// One search over Solo chats, Crew runs and each project's history file. Every word must appear (case does not matter);
// a word in the title or goal counts ten times a word in the body, and newer wins a tie.
// Texts are flattened once and kept per item until its updatedAt changes, so a keystroke does not re-read any chat.

export type SearchKind = 'chat' | 'run' | 'history'
export type SearchHit = { kind: SearchKind; id: string; title: string; project: string | null; at: number; snippet: { text: string; ranges: [number, number][] } }
export type SearchDeps = {
  listChats(): ChatSummary[]
  loadChat(id: string): Chat | null
  listRuns(): RunSummary[]
  getRun(id: string): Run | null
  historyStamp(project: string): number // 0 when the project has no history; changes whenever the file does
  readHistory(project: string): string
}
export type SearchOpts = { limit?: number; maxChats?: number; maxRuns?: number; charsPerItem?: number; historyChars?: number; linesPerProject?: number }

const DEFAULTS = { limit: 40, maxChats: 500, maxRuns: 300, charsPerItem: 80_000, historyChars: 200_000, linesPerProject: 5 }
const TITLE_WEIGHT = 10
const WINDOW = 140

type Entry = { stamp: number; title: string; body: string }
const cache = new Map<string, Entry>()
export const clearSearchCache = () => cache.clear()

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const lower = (s: string) => s.toLowerCase()

export const queryWords = (q: string) => [...new Set(lower(q).split(/\s+/).filter(Boolean))].slice(0, 6)

// A snippet of about 140 characters around the first match (ellipses where it was cut) and the ranges of every word inside it.
export function snippetOf(text: string, words: string[]): SearchHit['snippet'] {
  const t = flat(text)
  const low = lower(t)
  const found = words.map((w) => low.indexOf(w)).filter((i) => i >= 0)
  const from = Math.max(0, (found.length ? Math.min(...found) : 0) - 40)
  const to = Math.min(t.length, from + WINDOW)
  const pre = from > 0 ? '…' : ''
  const ranges: [number, number][] = []
  for (const w of words) for (let i = low.indexOf(w, from); i >= 0 && i + w.length <= to; i = low.indexOf(w, i + w.length)) ranges.push([pre.length + i - from, pre.length + i - from + w.length])
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) merged.at(-1) && r[0] <= merged.at(-1)![1] ? (merged.at(-1)![1] = Math.max(merged.at(-1)![1], r[1])) : merged.push([...r])
  return { text: pre + t.slice(from, to) + (to < t.length ? '…' : ''), ranges: merged }
}

// All words present across title and body, else null. Title hits weigh more; the whole query in the title earns a bonus.
function score(title: string, body: string, words: string[], q: string): number | null {
  const lt = lower(title)
  const lb = lower(body)
  let s = 0
  for (const w of words) {
    if (lt.includes(w)) s += TITLE_WEIGHT
    else if (lb.includes(w)) s += 1
    else return null
  }
  return s + (lt.includes(q) ? TITLE_WEIGHT / 2 : 0)
}

function cached(key: string, stamp: number, make: () => Omit<Entry, 'stamp'>): Entry {
  const hit = cache.get(key)
  if (hit && hit.stamp === stamp) return hit
  const e = { stamp, ...make() }
  cache.set(key, e)
  return e
}

const chatBody = (c: Chat, cap: number) => {
  const parts: string[] = []
  let n = 0
  // Only what was said: the user's messages and the assistant's text. Tool calls and their output are skipped.
  for (const it of c.transcript) {
    const t = it.type === 'user' ? it.text : it.type === 'delta' ? it.text : ''
    if (!t) continue
    parts.push(t)
    if ((n += t.length) >= cap) break
  }
  return flat(parts.join('\n')).slice(0, cap)
}

const runBody = (r: Run, cap: number) =>
  flat([...r.tasks.flatMap((t) => [t.title, t.goal, t.summary]), ...r.messages.map((m) => m.body), ...r.decisions.map((d) => d.text), r.final?.report ?? ''].join('\n')).slice(0, cap)

export function searchAll(query: string, deps: SearchDeps, opts: SearchOpts = {}): SearchHit[] {
  const o = { ...DEFAULTS, ...opts }
  const q = lower(flat(query))
  const words = queryWords(query)
  if (q.length < 2 || !words.length) return []
  const found: { s: number; hit: SearchHit }[] = []
  const seen = new Set<string>()
  const projects = new Set<string>()
  const add = (s: number | null, hit: SearchHit) => s !== null && found.push({ s, hit })
  // The body shows where the words were found; a hit only in the title shows the title.
  const pick = (title: string, body: string) => {
    const lb = lower(body)
    return snippetOf(words.some((w) => lb.includes(w)) ? body : title, words)
  }

  for (const c of deps.listChats().slice(0, o.maxChats)) {
    const key = `chat:${c.id}`
    seen.add(key)
    if (c.project) projects.add(c.project)
    // The summary's updatedAt is the cache key: the chat file is read again only after it was saved.
    const e = cached(key, c.updatedAt, () => {
      const chat = deps.loadChat(c.id)
      return { title: chat?.title ?? c.title, body: chat ? chatBody(chat, o.charsPerItem) : '' }
    })
    add(score(e.title, e.body, words, q), { kind: 'chat', id: c.id, title: e.title || c.title, project: c.project, at: c.updatedAt, snippet: pick(e.title, e.body) })
  }

  for (const r of deps.listRuns().slice(0, o.maxRuns)) {
    const key = `run:${r.id}`
    seen.add(key)
    projects.add(r.project)
    const e = cached(key, r.updatedAt, () => {
      const run = deps.getRun(r.id)
      return { title: r.goal, body: run ? runBody(run, o.charsPerItem) : '' }
    })
    add(score(e.title, e.body, words, q), { kind: 'run', id: r.id, title: r.goal, project: r.project, at: r.updatedAt, snippet: pick(e.title, e.body) })
  }

  for (const project of projects) {
    const stamp = deps.historyStamp(project)
    const key = `history:${project}`
    if (!stamp) continue
    seen.add(key)
    // The newest part of the file: it only grows, and the newest lines are the ones people look for.
    const e = cached(key, stamp, () => ({ title: basename(project), body: deps.readHistory(project).slice(-o.historyChars) }))
    let n = 0
    const lines = e.body.split('\n')
    for (let i = lines.length - 1; i >= 0 && n < o.linesPerProject; i--) {
      const when = lines[i].match(/^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d) ([+-]\d\d:\d\d)\] ?/)
      const text = lines[i].slice(when?.[0].length ?? 0)
      const s = score('', text, words, q)
      if (s === null) continue
      n++
      add(s, { kind: 'history', id: project, title: e.title, project, at: (when && Date.parse(`${when[1]}T${when[2]}:00${when[3]}`)) || stamp, snippet: snippetOf(text, words) })
    }
  }

  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k) // chats, runs and projects that are gone
  return found.sort((a, b) => b.s - a.s || b.hit.at - a.hit.at).slice(0, o.limit).map((f) => f.hit)
}
