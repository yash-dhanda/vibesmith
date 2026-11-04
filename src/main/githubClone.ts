import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { cloneTimeoutMs } from './cloneSize'
import { validRepoName } from './githubTop'
import { addRepoReference, type Reference } from './references'
import { ensureForgeDir } from './projectRules'
import { friendlyGitError, git, withRetry } from './skills'

// Shallow clones of public GitHub repositories, as a new project or as a reference inside a project. Nothing in a clone is ever run:
// git's own hooks are off (see git() in skills.ts) and a reference clone loses its .git folder, so it is plain files. There is no size limit:
// the window tells the owner how big the repository is before cloning (cloneSize.ts), and a partial clone is removed when it fails.

export type CloneDeps = {
  run?: (args: string[], timeoutMs: number) => Promise<unknown> // tests point this at a local repository
  urlOf?: (fullName: string) => string
  sizeKb?: number | null // GitHub's size for the repository; scales the timeout
  onProgress?: (bytes: number) => void // folder size so far, about once a second
  pollMs?: number
}

// Counts file sizes without following links; the folder may change or vanish underneath while git works.
function folderBytes(dir: string): number {
  let total = 0
  let entries: import('node:fs').Dirent[] = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += folderBytes(p)
    else try { total += lstatSync(p).size } catch {}
  }
  return total
}

export async function freeBytes(dir: string): Promise<number | null> {
  try { const s = await statfs(dir); return s.bavail * s.bsize } catch { return null }
}

export async function cloneRepo(o: { fullName: string; dest: string; depth?: number }, d: CloneDeps = {}): Promise<void> {
  if (!validRepoName(o.fullName)) throw new Error('That is not a GitHub repository name.')
  const name = basename(o.dest)
  if (!/^[\w.-]+$/.test(name) || /^\.+$/.test(name)) throw new Error('That folder name is not allowed.')
  if (!existsSync(dirname(o.dest))) throw new Error('The folder to clone into does not exist.')
  if (existsSync(o.dest)) throw new Error(`A folder named ${name} already exists there. Choose another folder.`)
  const url = (d.urlOf ?? ((n) => `https://github.com/${n}.git`))(o.fullName)
  const depth = Math.max(1, Math.floor(o.depth ?? 1))
  const run = d.run ?? ((args: string[], t: number) => git(args, undefined, t))
  const timer = d.onProgress ? setInterval(() => d.onProgress!(folderBytes(o.dest)), d.pollMs ?? 1000) : null
  try {
    await withRetry(async () => {
      rmSync(o.dest, { recursive: true, force: true }) // a failed attempt may leave a partial folder
      await run(['clone', '--depth', String(depth), '--no-tags', '--single-branch', '--', url, o.dest], cloneTimeoutMs(d.sizeKb))
    })
  } catch (e) {
    rmSync(o.dest, { recursive: true, force: true })
    const m = (e as Error).message
    throw new Error(`Could not clone it: ${friendlyGitError(m)}${/certificate|timed out|took longer|resolve/i.test(m) ? '' : ' Is the repository public?'}`)
  } finally { if (timer) clearInterval(timer) }
}

// The reference copy lives in <project>/.forge/references/repos/<owner>__<repo>, which is hidden from git, and is listed in the reference library.
export async function cloneAsReference(project: string, fullName: string, description: string, d: CloneDeps = {}): Promise<Reference> {
  if (!validRepoName(fullName)) throw new Error('That is not a GitHub repository name.')
  ensureForgeDir(project, 'references') // each call refuses a .forge or references folder that is a link
  const dest = join(ensureForgeDir(project, 'references/repos'), fullName.replace('/', '__'))
  await cloneRepo({ fullName, dest }, d)
  try {
    rmSync(join(dest, '.git'), { recursive: true, force: true })
    return addRepoReference(project, { fullName, description })
  } catch (e) { rmSync(dest, { recursive: true, force: true }); throw e }
}
