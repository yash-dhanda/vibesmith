import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { detectVerify } from './agent/commands'

// Per-project settings live in the app's data folder, not in the project, so the user's repo stays clean.
const file = () => join(app.getPath('userData'), 'projects.json')
const load = (): Record<string, { verify?: string }> => {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    return {}
  }
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
  writeFileSync(file(), JSON.stringify(all, null, 2))
}
