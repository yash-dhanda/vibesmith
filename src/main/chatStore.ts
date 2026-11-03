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
  transcript: TranscriptItem[] // what the UI replays
  messages: Message[] // what the model sees when the chat continues
  checkpoints: Record<string, Checkpoint> // so Undo still works after a restart
}
export type ChatSummary = Pick<Chat, 'id' | 'title' | 'project' | 'updatedAt'>
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

  save(chat: Chat) {
    chat.updatedAt = Date.now()
    chat.transcript = compact(chat.transcript)
    this.writeAtomic(this.file(chat.id), chat)
    const rest = this.readIndex().filter((s) => s.id !== chat.id)
    this.writeAtomic(this.index(), [{ id: chat.id, title: chat.title, project: chat.project, updatedAt: chat.updatedAt }, ...rest])
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

  delete(id: string) {
    rmSync(this.file(id), { force: true })
    this.writeAtomic(this.index(), this.readIndex().filter((s) => s.id !== id))
  }
}
