import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SAFE_ID } from './chatStore'

// Pictures and text files the user attaches to a message. They live in the app's data folder, one folder per chat,
// so the user's project stays clean. Pictures go to vision models; text files are pasted into the message.

export type Attachment = { id: string; name: string; kind: 'image' | 'text'; size: number; mime: string }
export const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
export const MAX_FILES_PER_MESSAGE = 8
export const MAX_IMAGE = 15 * 1024 * 1024
export const MAX_TEXT = 1024 * 1024
export const INLINE_TEXT_CHARS = 40_000

const safeName = (n: string) => basename(n).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file'
const isText = (b: Uint8Array) => {
  if (b.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b)
    return true
  } catch {
    return false
  }
}

export class AttachmentStore {
  constructor(private dir: string) {}

  private chatDir = (chatId: string) => {
    if (!SAFE_ID.test(chatId)) throw new Error('bad chat id')
    return join(this.dir, chatId)
  }
  private file = (chatId: string, a: Pick<Attachment, 'id' | 'name'>) => join(this.chatDir(chatId), `${a.id}-${a.name}`)

  // Rejects with a message fit to show the user. Nothing is stored when any file is refused.
  add(chatId: string, files: { name: string; data: Uint8Array }[]): Attachment[] {
    if (!files.length) return []
    if (files.length > MAX_FILES_PER_MESSAGE) throw new Error(`Attach up to ${MAX_FILES_PER_MESSAGE} files at a time.`)
    const out: { att: Attachment; data: Uint8Array }[] = []
    for (const f of files) {
      const name = safeName(String(f?.name ?? ''))
      const data = f?.data instanceof Uint8Array ? f.data : new Uint8Array(0)
      const mime = IMAGE_MIME[extname(name).slice(1).toLowerCase()]
      if (mime) {
        if (data.length > MAX_IMAGE) throw new Error(`${name} is too big (pictures up to 15 MB).`)
        out.push({ att: { id: randomUUID().slice(0, 10), name, kind: 'image', size: data.length, mime }, data })
      } else if (isText(data)) {
        if (data.length > MAX_TEXT) throw new Error(`${name} is too big (text files up to 1 MB).`)
        out.push({ att: { id: randomUUID().slice(0, 10), name, kind: 'text', size: data.length, mime: 'text/plain' }, data })
      } else throw new Error(`${name} is not a picture or a text file. Forge can read pictures (png, jpg, gif, webp) and text or code files.`)
    }
    mkdirSync(this.chatDir(chatId), { recursive: true })
    for (const { att, data } of out) writeFileSync(this.file(chatId, att), data)
    return out.map((o) => o.att)
  }

  // Looks an attachment up by id (the id is all the renderer holds). Returns null for an unknown id.
  find(chatId: string, id: string): (Attachment & { path: string }) | null {
    if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return null
    try {
      const f = readdirSync(this.chatDir(chatId)).find((n) => n.startsWith(id + '-'))
      if (!f) return null
      const name = f.slice(id.length + 1)
      const path = join(this.chatDir(chatId), f)
      const bytes = readFileSync(path)
      const mime = IMAGE_MIME[extname(name).slice(1).toLowerCase()]
      return { id, name, kind: mime ? 'image' : 'text', size: bytes.length, mime: mime ?? 'text/plain', path }
    } catch {
      return null
    }
  }

  text(a: { path: string }): { text: string; cut: boolean } {
    const t = readFileSync(a.path, 'utf8')
    return { text: t.slice(0, INLINE_TEXT_CHARS), cut: t.length > INLINE_TEXT_CHARS }
  }

  dataUrl(a: { path: string; mime: string }): string {
    return `data:${a.mime};base64,${readFileSync(a.path).toString('base64')}`
  }

  removeChat(chatId: string) {
    rmSync(this.chatDir(chatId), { recursive: true, force: true })
  }
}

// How a text file is shown to the model inside the user's message.
export function inlineText(name: string, text: string, cut: boolean): string {
  return `\n\n[Attached file: ${name}]\n\`\`\`\n${text}${cut ? '\n[cut: the file is longer]' : ''}\n\`\`\``
}
