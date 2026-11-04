import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { extname, join } from 'node:path'
import { kindOf, safeName, type TeamAttachment } from './team/attach'
import { atomicWrite, ensureForgeDir, FORGE_DIR, isLink } from './projectRules'

// The project's reference library: screenshots, documents and links the user keeps for design work, in .forge/references/ (hidden from git
// like the rest of .forge). Files are plain files in the folder; notes and links live in links.json, the one switch in settings.json.
// The folder is not trusted: it may be a link, and entries that are links are ignored.

export type Reference = { id: string; kind: 'image' | 'file' | 'link'; name: string; size?: number; url?: string; path?: string; note: string; addedAt: number }
export type NewReference = { name?: string; data?: string; url?: string; note?: string }
// A link with a dir is a cloned GitHub repository kept as plain files in repos/<dir> (see githubClone.ts).
type Meta = { links: { id: string; url: string; note: string; addedAt: number; dir?: string }[]; notes: Record<string, string> }

export const MAX_REF_BYTES = 25 * 1024 * 1024
export const MAX_REFS = 100
const MAX_NOTE = 500
const RESERVED = new Set(['links.json', 'settings.json'])
const DIR = 'references'
const REPO_DIR = /^[\w.-]+__[\w.-]+$/

const folder = (project: string) => { const d = join(project, FORGE_DIR, DIR); return isLink(join(project, FORGE_DIR)) || isLink(d) ? null : d }
const note = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : '')

function readJson(file: string): Record<string, unknown> {
  try { if (!isLink(file)) { const v = JSON.parse(readFileSync(file, 'utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v } } catch {}
  return {}
}
function readMeta(dir: string): Meta {
  const raw = readJson(join(dir, 'links.json'))
  const links = Array.isArray(raw.links) ? raw.links.filter((l) => l && typeof l.id === 'string' && typeof l.url === 'string').map((l) => ({ id: l.id, url: l.url, note: note(l.note), addedAt: Number(l.addedAt) || 0, ...(typeof l.dir === 'string' && REPO_DIR.test(l.dir) && !/^\.+$/.test(l.dir) ? { dir: l.dir } : {}) })) : []
  const notes: Record<string, string> = {}
  if (raw.notes && typeof raw.notes === 'object') for (const [k, v] of Object.entries(raw.notes)) notes[k] = note(v)
  return { links, notes }
}
const writeMeta = (dir: string, m: Meta) => atomicWrite(join(dir, 'links.json'), JSON.stringify(m, null, 2))

function fileEntries(dir: string) {
  let names: string[] = []
  try { names = readdirSync(dir) } catch {}
  return names.flatMap((name) => {
    if (RESERVED.has(name) || name.endsWith('.tmp')) return []
    try { const s = lstatSync(join(dir, name)); return s.isFile() ? [{ name, size: s.size, addedAt: s.mtimeMs }] : [] } catch { return [] }
  })
}

export function listReferences(project: string): Reference[] {
  const dir = folder(project)
  if (!dir) return []
  const meta = readMeta(dir)
  const out: Reference[] = [
    ...fileEntries(dir).map((f): Reference => ({ id: f.name, kind: kindOf(f.name) === 'image' ? 'image' : 'file', name: f.name, size: f.size, note: meta.notes[f.name] ?? '', addedAt: f.addedAt })),
    ...meta.links.map((l): Reference => ({ id: l.id, kind: 'link', name: l.url, url: l.url, note: l.note, addedAt: l.addedAt, ...(l.dir ? { path: join(dir, 'repos', l.dir) } : {}) })),
  ]
  return out.sort((a, b) => b.addedAt - a.addedAt)
}

const uniqueName = (dir: string, name: string) => {
  if (RESERVED.has(name.toLowerCase())) name = `file-${name}`
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}${ext}`
  return name
}

export function addReference(project: string, item: NewReference): Reference {
  if (!item || typeof item !== 'object') throw new Error('Nothing to add.')
  if (listReferences(project).length >= MAX_REFS) throw new Error(`A project can keep up to ${MAX_REFS} references. Remove one first.`)
  const dir = ensureForgeDir(project, DIR)
  const text = note(item.note)
  if (typeof item.url === 'string' && item.url.trim()) {
    let u: URL
    try { u = new URL(item.url.trim()) } catch { throw new Error('That is not a web address.') }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Links must start with http:// or https://.')
    const meta = readMeta(dir)
    const l = { id: randomBytes(4).toString('hex'), url: u.href.slice(0, 2000), note: text, addedAt: Date.now() }
    meta.links.push(l)
    writeMeta(dir, meta)
    return { id: l.id, kind: 'link', name: l.url, url: l.url, note: l.note, addedAt: l.addedAt }
  }
  const data = String(item.data ?? '')
  const name = safeName(item.name ?? '')
  if (!data) throw new Error('Nothing to add.')
  if (kindOf(name) === 'video') throw new Error('Videos are not kept here. Attach them to a run instead.')
  if (data.length > Math.ceil((MAX_REF_BYTES * 4) / 3) + 4) throw new Error(`${name} is too big (up to ${MAX_REF_BYTES / 1024 / 1024} MB).`)
  const buf = Buffer.from(data, 'base64')
  if (!buf.length) throw new Error(`${name} is empty.`)
  if (buf.length > MAX_REF_BYTES) throw new Error(`${name} is too big (up to ${MAX_REF_BYTES / 1024 / 1024} MB).`)
  const stored = uniqueName(dir, name)
  atomicWrite(join(dir, stored), buf)
  if (text) { const meta = readMeta(dir); meta.notes[stored] = text; writeMeta(dir, meta) }
  return { id: stored, kind: kindOf(stored) === 'image' ? 'image' : 'file', name: stored, size: buf.length, note: text, addedAt: Date.now() }
}

export function removeReference(project: string, id: string) {
  const dir = folder(project)
  if (!dir || typeof id !== 'string') return
  const meta = readMeta(dir)
  const link = meta.links.find((l) => l.id === id)
  if (link) {
    if (link.dir) rmSync(join(dir, 'repos', link.dir), { recursive: true, force: true }) // the clone goes with its entry; dir was checked when read
    meta.links = meta.links.filter((l) => l.id !== id)
    return writeMeta(dir, meta)
  }
  if (safeName(id) !== id || RESERVED.has(id)) throw new Error('That reference is not in this project.')
  try { unlinkSync(join(dir, id)) } catch { return }
  if (id in meta.notes) { delete meta.notes[id]; writeMeta(dir, meta) }
}

export function setReferenceNote(project: string, id: string, text: unknown) {
  const dir = folder(project)
  if (!dir || !listReferences(project).some((r) => r.id === id)) throw new Error('That reference is not in this project.')
  const meta = readMeta(dir)
  const link = meta.links.find((l) => l.id === id)
  if (link) link.note = note(text)
  else meta.notes[id] = note(text)
  writeMeta(dir, meta)
}

// A cloned GitHub repository (already on disk at repos/<owner>__<repo>) as a reference; adding it again replaces the earlier entry.
export function addRepoReference(project: string, o: { fullName: string; description?: string }): Reference {
  const [owner, repo] = o.fullName.split('/')
  const dirName = `${owner}__${repo}`
  if (!REPO_DIR.test(dirName) || /^\.+$/.test(owner) || /^\.+$/.test(repo)) throw new Error('That is not a GitHub repository name.')
  const dir = ensureForgeDir(project, DIR)
  const meta = readMeta(dir)
  meta.links = meta.links.filter((l) => l.dir !== dirName)
  const l = { id: randomBytes(4).toString('hex'), url: `https://github.com/${o.fullName}`, note: note(`Cloned reference: ${o.fullName}, ${o.description || 'no description'}`), addedAt: Date.now(), dir: dirName }
  meta.links.push(l)
  writeMeta(dir, meta)
  return { id: l.id, kind: 'link', name: l.url, url: l.url, path: join(dir, 'repos', dirName), note: l.note, addedAt: l.addedAt }
}

// The path of a stored picture or document, for a preview; null for anything that is not a plain file of this library.
export function referencePath(project: string, id: string): string | null {
  const dir = folder(project)
  return dir && typeof id === 'string' && safeName(id) === id && fileEntries(dir).some((f) => f.name === id) ? join(dir, id) : null
}

export const getAutoAttach = (project: string): boolean => { const d = folder(project); return !!d && readJson(join(d, 'settings.json')).autoAttach === true }
export function setAutoAttach(project: string, on: boolean) {
  atomicWrite(join(ensureForgeDir(project, DIR), 'settings.json'), JSON.stringify({ autoAttach: on === true }))
}

// The library's pictures and documents as attachments for a run. Agents may only read attachments from Forge's attachment folder
// (`root`, see cleanAttachments), so each call copies the files into a fresh folder there.
export function referenceAttachments(project: string, o: { root: string; kinds?: ('image' | 'file')[]; limit?: number }): TeamAttachment[] {
  const dir = folder(project)
  if (!dir) return []
  const kinds = o.kinds ?? ['image', 'file']
  const files = fileEntries(dir).filter((f) => kinds.includes(kindOf(f.name) === 'image' ? 'image' : 'file')).sort((a, b) => b.addedAt - a.addedAt).slice(0, Math.min(o.limit ?? 12, 12))
  if (!files.length) return []
  const to = join(o.root, randomBytes(5).toString('hex'))
  mkdirSync(to, { recursive: true })
  return files.map((f, i) => {
    const path = join(to, `${String(i + 1).padStart(2, '0')}-${f.name}`)
    copyFileSync(join(dir, f.name), path)
    return { id: randomBytes(4).toString('hex'), name: f.name, path, kind: kindOf(f.name) === 'image' ? 'image' : 'file', size: f.size }
  })
}

// Links and the user's notes, for the goal text: links cannot be attached as files, and notes say what each picture is for.
export function referencesBlock(project: string): string {
  const refs = listReferences(project)
  const lines = refs.filter((r) => r.kind === 'link' || r.note).map((r) => `- ${r.kind === 'link' ? r.url : r.name}${r.path ? ` (files on this computer: ${r.path})` : ''}${r.note ? `: ${r.note}` : ''}`)
  return lines.length ? `REFERENCES the user saved for this project (links, and notes on the attached pictures and files):\n${lines.join('\n')}` : ''
}
