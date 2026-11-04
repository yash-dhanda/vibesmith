import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, join, resolve, sep } from 'node:path'

// Files the user hands to a crew: screenshots, photos, videos, documents. They are kept in Forge's data folder (not the project), and the
// agents are given their locations. A video becomes a few still frames, because the agents read pictures, not video.

export type TeamAttachment = { id: string; name: string; path: string; kind: 'image' | 'video' | 'file'; size: number; frames?: string[]; duration?: number; frameEvery?: number } // duration and frameEvery are in seconds

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic'])
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'])
export const MAX_FILES = 12
export const MAX_FILE = 200 * 1024 * 1024
export const MAX_TOTAL = 400 * 1024 * 1024
const MAX_FRAMES = 12
const STALE_MS = 24 * 3600_000

export const safeName = (n: string) => basename(String(n)).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-90) || 'file'
export const kindOf = (name: string): TeamAttachment['kind'] => (IMAGE.has(extname(name).toLowerCase()) ? 'image' : VIDEO.has(extname(name).toLowerCase()) ? 'video' : 'file')

const ffmpeg = (args: string[]) => new Promise<boolean>((res) => execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 90_000 }, (e) => res(!e)))

const duration = (video: string) => new Promise<number>((res) => execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { timeout: 30_000 }, (e, out) => res(e ? 0 : Number(out.toString().trim()) || 0)))

// Twelve stills spread over the whole video (a still every 2 seconds at most, and none closer than half a second apart), scaled down so they are cheap to read.
async function frames(video: string, dir: string, stem: string): Promise<{ frames: string[]; duration?: number; frameEvery?: number }> {
  const secs = await duration(video)
  const every = secs > 0 ? Math.min(30, Math.max(0.5, secs / MAX_FRAMES)) : 2
  const out = join(dir, `${stem}-frame-%02d.jpg`)
  if (!(await ffmpeg(['-i', video, '-vf', `fps=1/${every},scale='min(960,iw)':-2`, '-frames:v', String(MAX_FRAMES), out]))) return { frames: [] }
  return { frames: readdirSync(dir).filter((f) => f.startsWith(`${stem}-frame-`)).sort().map((f) => join(dir, f)), ...(secs > 0 ? { duration: Math.round(secs * 10) / 10, frameEvery: Math.round(every * 10) / 10 } : {}) }
}

export async function saveAttachments(root: string, files: { name: string; data: string }[]): Promise<TeamAttachment[]> {
  if (!Array.isArray(files) || !files.length) return []
  if (files.length > MAX_FILES) throw new Error(`Attach up to ${MAX_FILES} files at a time.`)
  const decoded = files.map((f) => ({ name: safeName(f?.name), buf: Buffer.from(String(f?.data ?? ''), 'base64') }))
  let total = 0
  for (const f of decoded) {
    if (f.buf.length > MAX_FILE) throw new Error(`${f.name} is too big (up to ${MAX_FILE / 1024 / 1024} MB).`)
    total += f.buf.length
  }
  if (total > MAX_TOTAL) throw new Error('Those files are too big together.')
  const dir = join(root, randomBytes(5).toString('hex'))
  mkdirSync(dir, { recursive: true })
  const out: TeamAttachment[] = []
  for (const [i, f] of decoded.entries()) out.push(await place(dir, i, f.name, f.buf.length, (path) => writeFileSync(path, f.buf)))
  return out
}

// Names, stores and (for a video) takes the stills of one file; `put` puts the bytes at the path it is given.
async function place(dir: string, i: number, name: string, size: number, put: (path: string) => void): Promise<TeamAttachment> {
  const file = `${String(i + 1).padStart(2, '0')}-${name}`
  const path = join(dir, file)
  put(path)
  const kind = kindOf(name)
  const att: TeamAttachment = { id: randomBytes(4).toString('hex'), name, path, kind, size }
  if (kind === 'video') Object.assign(att, await frames(path, dir, file.replace(/\.[^.]+$/, '')))
  return att
}

export type AttachPart = { uploadId: string; index: number; total: number; name: string; data: string }
const MAX_PART = 8 * 1024 * 1024
const MAX_PARTS = 40
const MAX_OPEN = 4
const IDLE_MS = 10 * 60_000

// One big file arriving in pieces (the phone cannot send 200 MB in one request). Pieces are appended to a temp file in the attachment
// folder; the last one turns it into an ordinary attachment. Any error, or ten idle minutes, deletes the temp file.
export class PartUploads {
  private open = new Map<string, { tmp: string; name: string; next: number; total: number; size: number; timer: NodeJS.Timeout }>()
  constructor(private root: string, private idleMs = IDLE_MS) {}

  private drop(id: string) {
    const u = this.open.get(id)
    if (!u) return
    clearTimeout(u.timer)
    this.open.delete(id)
    rmSync(u.tmp, { force: true })
  }

  async add(p: AttachPart): Promise<TeamAttachment | null> {
    const id = String(p?.uploadId ?? '')
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('bad upload id')
    const { index, total } = p
    if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS || !Number.isInteger(index) || index < 0 || index >= total) throw new Error('bad part number')
    let u = this.open.get(id)
    try {
      if (index === 0 ? !!u : !u || u.next !== index || u.total !== total) throw new Error('Upload parts arrived out of order. Attach the file again.')
      const buf = Buffer.from(String(p.data ?? ''), 'base64')
      if (buf.length > MAX_PART) throw new Error('That part of the file is too big.')
      if (!u) {
        if (this.open.size >= MAX_OPEN) throw new Error('Too many files are uploading at once. Try again in a moment.')
        mkdirSync(this.root, { recursive: true })
        u = { tmp: join(this.root, `.part-${id}`), name: safeName(p.name), next: 0, total, size: 0, timer: undefined as never }
        this.open.set(id, u)
        writeFileSync(u.tmp, '')
      }
      u.size += buf.length
      if (u.size > MAX_FILE) throw new Error(`${u.name} is too big (up to ${MAX_FILE / 1024 / 1024} MB).`)
      appendFileSync(u.tmp, buf)
      u.next++
      clearTimeout(u.timer)
      if (u.next < u.total) { u.timer = setTimeout(() => this.drop(id), this.idleMs); u.timer.unref(); return null }
      const dir = join(this.root, randomBytes(5).toString('hex'))
      mkdirSync(dir, { recursive: true })
      const done = u
      this.open.delete(id)
      try { return await place(dir, 0, done.name, done.size, (path) => renameSync(done.tmp, path)) } catch (e) { rmSync(dir, { recursive: true, force: true }); rmSync(done.tmp, { force: true }); throw e }
    } catch (e) {
      this.drop(id)
      throw e
    }
  }
}

// Only attachments that really are inside Forge's attachment folder are accepted back from the window.
export function cleanAttachments(root: string, list: unknown): TeamAttachment[] {
  if (!Array.isArray(list)) return []
  const base = resolve(root)
  const ok = (p: unknown): p is string => typeof p === 'string' && resolve(p).startsWith(base + sep)
  const out: TeamAttachment[] = []
  for (const a of list.slice(0, MAX_FILES)) {
    if (!a || !ok(a.path)) continue
    try { if (!statSync(a.path).isFile()) continue } catch { continue }
    out.push({ id: String(a.id ?? '').slice(0, 20), name: safeName(a.name), path: resolve(a.path), kind: kindOf(a.name), size: Number(a.size) || 0, frames: Array.isArray(a.frames) ? a.frames.filter(ok).slice(0, MAX_FRAMES) : undefined, duration: Number(a.duration) > 0 ? Number(a.duration) : undefined, frameEvery: Number(a.frameEvery) > 0 ? Number(a.frameEvery) : undefined })
  }
  return out
}

// What the agents are told about them.
export function attachmentsBlock(list: TeamAttachment[] | undefined): string {
  if (!list?.length) return ''
  const lines = list.map((a) => {
    if (a.kind === 'image') return `- ${a.name} (picture): ${a.path}`
    if (a.kind === 'video') return `- ${a.name} (video): ${a.path}${a.frames?.length ? `\n  still frames from it, in order, ${a.duration && a.frameEvery ? `about ${a.frameEvery} seconds apart, covering all ${a.duration} seconds of the video` : 'about two seconds apart'}:\n${a.frames.map((f) => `    ${f}`).join('\n')}` : '\n  (no frames could be made from it; ask the user to describe it)'}`
    return `- ${a.name} (file): ${a.path}`
  })
  return `ATTACHMENTS the user gave you (files on this computer, outside the project). Look at the pictures and video frames yourself (open them with your file reader or image viewer) before you plan or build anything they show; they are part of the request. Read the other files too. Copy a file into the project only if the work needs it there.\n${lines.join('\n')}`
}

// Pictures a vision-capable agent can be handed directly: the pictures themselves and the frames of each video.
export const imagePaths = (list: TeamAttachment[] | undefined, cap = 10): string[] =>
  (list ?? []).flatMap((a) => (a.kind === 'image' ? [a.path] : a.kind === 'video' ? (a.frames ?? []) : [])).slice(0, cap)

export const removeAttachmentDirs = (root: string, list: TeamAttachment[] | undefined) => {
  for (const d of new Set((list ?? []).map((a) => resolve(a.path, '..')))) if (d.startsWith(resolve(root) + sep)) rmSync(d, { recursive: true, force: true })
}

// Uploads are made as soon as a file is added, so one that was never used (the chip was removed, the run never started) stays on disk.
// Folders that no run refers to and that are older than a day are deleted.
export const sweepAttachments = (root: string, used: TeamAttachment[], now = Date.now()) => {
  const keep = new Set(used.map((a) => resolve(a.path, '..')))
  let names: string[] = []
  try { names = readdirSync(root) } catch { return }
  for (const n of names) {
    const d = join(root, n)
    try { if (!keep.has(resolve(d)) && now - statSync(d).mtimeMs > STALE_MS) rmSync(d, { recursive: true, force: true }) } catch {}
  }
}
