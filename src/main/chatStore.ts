import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from './agent/loop'
import type { Message } from './agent/provider'
import type { Checkpoint } from './checkpoint'

// One JSON file per chat plus a small index, so the sidebar never has to read every conversation.
export type AttachmentInfo = { id: string; name: string; kind: 'image' | 'text'; size: number }
export type TranscriptItem = { type: 'user'; text: string; attachments?: AttachmentInfo[] } | AgentEvent
export type Chat = {
  id: string
  title: string
  project: string | null
  createdAt: number
  updatedAt: number
  pinned?: boolean
  transcript: TranscriptItem[] // what the UI replays
  messages: Message[] // what the model sees when the chat continues
  checkpoints: Record<string, Checkpoint> // so Undo still works after a restart
}
export type ChatSummary = Pick<Chat, 'id' | 'title' | 'project' | 'updatedAt' | 'pinned'>
export type ChatStatus = 'idle' | 'running' | 'waiting' // waiting = stopped on a question for the user
export type ChatListItem = ChatSummary & { status: ChatStatus }

export const titleFrom = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 48 ? t.slice(0, 47).trimEnd() + '…' : t || 'New chat'
}

// Streaming stores one event per token. Merge consecutive text so a long chat is not megabytes of fragments.
export function compact(items: TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  for (const it of items) {
    const last = out.at(-1)
    if (it.type === 'delta' && last?.type === 'delta') out[out.length - 1] = { type: 'delta', text: last.text + it.text }
    else out.push(it)
  }
  return out
}

export const SAFE_ID = /^[\w-]+$/

export type SearchHit = ChatSummary & { snippets: { where: 'title' | 'user' | 'assistant'; text: string }[] }

// About 120 characters around the first matching word, with ellipses where it was cut.
export function snippet(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  const found = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0)
  const from = Math.max(0, (found.length ? Math.min(...found) : 0) - 40)
  return (from > 0 ? '…' : '') + flat.slice(from, from + 120) + (from + 120 < flat.length ? '…' : '')
}

export class ChatStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private file = (id: string) => {
    if (!SAFE_ID.test(id)) throw new Error('bad chat id') // ids come from the renderer: never let one escape the folder
    return join(this.dir, `${id}.json`)
  }
  private index = () => join(this.dir, 'index.json')

  private writeAtomic(path: string, data: unknown) {
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, path) // a crash mid-write cannot leave a half-written chat
  }

  private readIndex(): ChatSummary[] {
    try {
      return JSON.parse(readFileSync(this.index(), 'utf8'))
    } catch {
      return []
    }
  }

  // The screen picks the id of a new chat up front, so live events can be matched to it before the first save.
  create(project: string | null, id: string = randomUUID()): Chat {
    if (!SAFE_ID.test(id)) throw new Error('bad chat id')
    const now = Date.now()
    return { id, title: 'New chat', project, createdAt: now, updatedAt: now, transcript: [], messages: [], checkpoints: {} }
  }

  // `touch: false` saves without moving the chat to the top of the list (pinning is not activity).
  save(chat: Chat, touch = true) {
    if (touch) chat.updatedAt = Date.now()
    chat.transcript = compact(chat.transcript)
    this.writeAtomic(this.file(chat.id), chat)
    const rest = this.readIndex().filter((s) => s.id !== chat.id)
    this.writeAtomic(this.index(), [{ id: chat.id, title: chat.title, project: chat.project, updatedAt: chat.updatedAt, ...(chat.pinned ? { pinned: true } : {}) }, ...rest])
  }

  load(id: string): Chat | null {
    try {
      return JSON.parse(readFileSync(this.file(id), 'utf8'))
    } catch {
      return null
    }
  }

  list(): ChatSummary[] {
    return this.readIndex().sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // Every word of the query must appear, in the title, the user's messages or the assistant's replies. Newest chats first.
  search(query: string, limit = 30): SearchHit[] {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 6)
    if (!words.length) return []
    const hits: SearchHit[] = []
    for (const s of this.list()) {
      if (hits.length >= limit) break
      const chat = this.load(s.id)
      if (!chat) continue
      const parts: { where: SearchHit['snippets'][number]['where']; text: string }[] = [{ where: 'title', text: chat.title }]
      let reply = ''
      for (const t of chat.transcript) {
        if (t.type === 'delta') reply += t.text
        else {
          if (reply) parts.push({ where: 'assistant', text: reply }), (reply = '')
          if (t.type === 'user') parts.push({ where: 'user', text: t.text })
        }
      }
      if (reply) parts.push({ where: 'assistant', text: reply })
      const all = parts.map((p) => p.text.toLowerCase()).join('\n')
      if (!words.every((w) => all.includes(w))) continue
      const snippets = parts
        .filter((p) => words.some((w) => p.text.toLowerCase().includes(w)))
        .slice(0, 3)
        .map((p) => ({ where: p.where, text: snippet(p.text, words) }))
      hits.push({ ...s, snippets })
    }
    return hits
  }

  delete(id: string) {
    rmSync(this.file(id), { force: true })
    this.writeAtomic(this.index(), this.readIndex().filter((s) => s.id !== id))
  }
}
