import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { ipcMain } from 'electron'
import { sanitizeConfig, type TeamService } from './team/service'

// The overnight queue (queue:*) and landing part of a run (team:land-part, team:landings, team:undo-landing).
export type QueueDeps = { team: () => TeamService; rootOf: (e: unknown) => string | null }

const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[\w-]{1,60}$/.test(v)) throw new Error('bad id')
  return v
}
const isDir = (p: string) => {
  try { return isAbsolute(p) && statSync(p).isDirectory() } catch { return false }
}

export function registerQueue(d: QueueDeps) {
  const q = () => d.team().queue
  ipcMain.handle('queue:list', () => ({ items: q().list(), active: q().active }))
  ipcMain.handle('queue:add', (e, raw: unknown) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const project = typeof o.project === 'string' && o.project ? o.project : d.rootOf(e)
    if (!project || !isDir(project)) throw new Error('Choose a folder that exists for this goal.')
    return q().add({
      project,
      goal: String(o.goal ?? '').slice(0, 20_000),
      config: sanitizeConfig(o.config),
      attachments: Array.isArray(o.attachments) ? o.attachments : undefined, // checked against the attachments folder when the run starts
      autoLand: o.autoLand === true,
      continueOnFail: o.continueOnFail === true,
    })
  })
  ipcMain.handle('queue:remove', (_e, itemId: unknown) => q().remove(id(itemId)))
  ipcMain.handle('queue:move', (_e, itemId: unknown, to: unknown) => q().move(id(itemId), typeof to === 'number' ? to : 0))
  ipcMain.handle('queue:start', () => q().start())
  ipcMain.handle('queue:pause', () => q().pause())
  ipcMain.handle('queue:report', () => q().morningReport())

  ipcMain.handle('team:land-part', (_e, runId: unknown, files: unknown) => {
    const list = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string' && f.length < 1000).slice(0, 5000) : []
    return d.team().orch.approveFinal(id(runId), false, list) // refuses anything that is not one of the run's changed files
  })
  ipcMain.handle('team:landings', (_e, runId: unknown) => d.team().orch.landings(id(runId)))
  ipcMain.handle('team:undo-landing', (_e, runId: unknown, checkpoint: unknown) => d.team().orch.undoLanding(id(runId), id(checkpoint)))
}
