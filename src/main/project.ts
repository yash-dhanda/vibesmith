import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Every file op, UI or agent, is confined to the opened project folder (path jail).
let root: string | null = process.env.FORGE_PROJECT ? realpathSync(process.env.FORGE_PROJECT) : null

export const getRoot = () => root
export const setRoot = (p: string) => (root = realpathSync(p))

// The folder a chat works in is passed explicitly (agent runs go on in the background while the screen shows another chat).
export const inRoot = (p: string): string => resolveIn(root ?? (() => { throw new Error('no project open') })(), p)

export function resolveIn(root: string, p: string): string {
  const abs = resolve(root, p)
  // realpath resolves symlinks, so a link inside the root cannot point outside it.
  // A file that does not exist yet (the agent is creating it, maybe in new folders) is checked through its nearest existing parent.
  let existing = abs
  let rest = ''
  for (;;) {
    try {
      existing = realpathSync(existing)
      break
    } catch {
      // The entry exists but cannot be resolved: a dangling symlink. Writing through it would create its target, wherever that is.
      if (lstatSync(existing, { throwIfNoEntry: false })) throw new Error(`path outside project: ${p}`)
      const parent = dirname(existing)
      if (parent === existing) throw new Error(`path outside project: ${p}`)
      rest = abs.slice(parent.length) // includes the leading separator; resolve() already removed any '..'
      existing = parent
    }
  }
  const real = rest ? join(existing, rest) : existing
  const rel = relative(root, real)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`path outside project: ${p}`)
  return real
}
