import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, join, resolve, sep } from 'node:path'

// Files the user hands to a crew: screenshots, photos, videos, documents. They are kept in Forge's data folder (not the project), and the
// agents are given their locations. A video becomes a few still frames, because the agents read pictures, not video.

export type TeamAttachment = { id: string; name: string; path: string; kind: 'image' | 'video' | 'file'; size: number; frames?: string[] }

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic'])
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'])
export const MAX_FILES = 12
export const MAX_FILE = 200 * 1024 * 1024
export const MAX_TOTAL = 400 * 1024 * 1024
const MAX_FRAMES = 12

export const safeName = (n: string) => basename(String(n)).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-90) || 'file'
export const kindOf = (name: string): TeamAttachment['kind'] => (IMAGE.has(extname(name).toLowerCase()) ? 'image' : VIDEO.has(extname(name).toLowerCase()) ? 'video' : 'file')

const ffmpeg = (args: string[]) => new Promise<boolean>((res) => execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 90_000 }, (e) => res(!e)))

// One still every couple of seconds (more often for a short clip), at most 12, scaled down so they are cheap to read.
async function frames(video: string, dir: string, stem: string): Promise<string[]> {
  const out = join(dir, `${stem}-frame-%02d.jpg`)
  if (!(await ffmpeg(['-i', video, '-vf', "fps=1/2,scale='min(960,iw)':-2", '-frames:v', String(MAX_FRAMES), out]))) return []
  return readdirSync(dir).filter((f) => f.startsWith(`${stem}-frame-`)).sort().map((f) => join(dir, f))
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
  for (const [i, f] of decoded.entries()) {
    const name = `${String(i + 1).padStart(2, '0')}-${f.name}`
    const path = join(dir, name)
    writeFileSync(path, f.buf)
    const kind = kindOf(f.name)
    const att: TeamAttachment = { id: randomBytes(4).toString('hex'), name: f.name, path, kind, size: f.buf.length }
    if (kind === 'video') att.frames = await frames(path, dir, name.replace(/\.[^.]+$/, ''))
    out.push(att)
  }
  return out
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
    out.push({ id: String(a.id ?? '').slice(0, 20), name: safeName(a.name), path: resolve(a.path), kind: kindOf(a.name), size: Number(a.size) || 0, frames: Array.isArray(a.frames) ? a.frames.filter(ok).slice(0, MAX_FRAMES) : undefined })
  }
  return out
}

// What the agents are told about them.
export function attachmentsBlock(list: TeamAttachment[] | undefined): string {
  if (!list?.length) return ''
  const lines = list.map((a) => {
    if (a.kind === 'image') return `- ${a.name} (picture): ${a.path}`
    if (a.kind === 'video') return `- ${a.name} (video): ${a.path}${a.frames?.length ? `\n  still frames from it, in order, about two seconds apart:\n${a.frames.map((f) => `    ${f}`).join('\n')}` : '\n  (no frames could be made from it; ask the user to describe it)'}`
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
