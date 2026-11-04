import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { detectVerify } from './agent/commands'

// Per-project settings live in the app's data folder, not in the project, so the user's repo stays clean.
const file = () => join(app.getPath('userData'), 'projects.json')
const load = (): Record<string, { verify?: string }> => {
  let raw: string
  try {
    raw = readFileSync(file(), 'utf8')
  } catch {
    return {} // no file yet
  }
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
  } catch {}
  // Unreadable: the next save would replace every project's setting with one. Keep what is left beside it instead.
  try {
    renameSync(file(), file() + '.corrupt')
  } catch {}
  return {}
}

export const getVerify = (root: string): { configured: string | null; detected: string | null; effective: string | null } => {
  const configured = load()[root]?.verify?.trim() || null
  const detected = detectVerify(root)
  return { configured, detected, effective: configured ?? detected }
}

export function setVerify(root: string, command: string) {
  const all = load()
  all[root] = { ...all[root], verify: command.trim() || undefined }
  mkdirSync(dirname(file()), { recursive: true })
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(all, null, 2))
  renameSync(tmp, file()) // a crash mid-write cannot corrupt every project's setting
}
