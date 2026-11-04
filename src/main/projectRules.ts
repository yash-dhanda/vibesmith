import { execFileSync } from 'node:child_process'
import { appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

// The project's standing rules: one markdown file the user can edit by hand, in the project's .forge/ folder (kept out of git
// through the repository's local exclude, like the history file). Solo and Crew read the same file. A project is not trusted:
// .forge and the file may be symlinks to somewhere else, so neither is ever followed.

export const FORGE_DIR = '.forge'
export const RULES_FILE = 'rules.md'
export const MAX_RULES_BYTES = 64 * 1024
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
const hidden = new Set<string>() // projects whose exclude entry is known to be in place

function hideFromGit(project: string) {
  if (hidden.has(project) || !existsSync(join(project, '.git'))) return
  let exclude = ''
  try { exclude = resolve(project, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: project, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_CEILING_DIRECTORIES: resolve(project, '..') } }).toString().trim()) } catch {}
  if (!exclude && statSync(join(project, '.git')).isDirectory()) exclude = join(project, '.git', 'info', 'exclude')
  if (!exclude) return
  const have = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!have.split('\n').includes(`${FORGE_DIR}/`)) {
    mkdirSync(join(exclude, '..'), { recursive: true })
    appendFileSync(exclude, `${have && !have.endsWith('\n') ? '\n' : ''}${FORGE_DIR}/\n`)
  }
  hidden.add(project)
}

// The folder inside .forge (created, and hidden from git), never through a link.
export function ensureForgeDir(project: string, sub?: string): string {
  const root = join(project, FORGE_DIR)
  const dir = sub ? join(root, sub) : root
  if (isLink(root) || isLink(dir)) throw new Error('The .forge folder is a link, so Forge will not use it.')
  mkdirSync(dir, { recursive: true })
  try { hideFromGit(project) } catch {}
  return dir
}

// Written beside the target and renamed over it, so a crash leaves the old file; rename replaces a link instead of following it.
export function atomicWrite(file: string, data: string | Buffer) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644)
  try { writeFileSync(fd, data) } catch (e) { closeSync(fd); rmSync(tmp, { force: true }); throw e }
  closeSync(fd)
  try { renameSync(tmp, file) } catch (e) { rmSync(tmp, { force: true }); throw e }
}

// null when the project has no rules file (or it cannot be read safely), so the caller can fall back to the brief's rules.
export function readRules(project: string): string | null {
  if (isLink(join(project, FORGE_DIR))) return null
  try { return readFileSync(join(project, FORGE_DIR, RULES_FILE), { encoding: 'utf8', flag: constants.O_RDONLY | NOFOLLOW }).slice(0, MAX_RULES_BYTES) } catch { return null }
}

export function writeRules(project: string, text: unknown) {
  if (typeof text !== 'string') throw new Error('Rules must be text.')
  const body = text.replace(/\r\n/g, '\n')
  if (Buffer.byteLength(body) > MAX_RULES_BYTES) throw new Error(`Rules can be up to ${MAX_RULES_BYTES / 1024} KB.`)
  const dir = ensureForgeDir(project)
  const file = join(dir, RULES_FILE)
  if (isLink(file)) throw new Error('The rules file is a link, so Forge will not write it.')
  atomicWrite(file, body)
}

// What agents get as the project's rules: the file when there is one (even an empty one: the user cleared them), otherwise the brief's older field.
export const effectiveRules = (project: string, fallback = '') => readRules(project) ?? fallback
