import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

// Every file op, UI or agent, is confined to the opened project folder (path jail).
let root: string | null = process.env.FORGE_PROJECT ? realpathSync(process.env.FORGE_PROJECT) : null

export const getRoot = () => root
export const setRoot = (p: string) => (root = realpathSync(p))

export function inRoot(p: string): string {
  if (!root) throw new Error('no project open')
  const abs = resolve(root, p)
  // realpath resolves symlinks so a link inside root cannot point outside it.
  // New files do not exist yet, so resolve the parent instead.
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    real = join(realpathSync(dirname(abs)), abs.slice(dirname(abs).length))
  }
  const rel = relative(root, real)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path outside project: ${p}`)
  return real
}
