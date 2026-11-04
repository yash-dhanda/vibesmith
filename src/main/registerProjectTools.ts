import { ipcMain, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Chat, ChatSummary } from './chatStore'
import { cachedOverview, type OverviewDeps } from './dashboard'
import { listRestorePoints, restoreDiff, restoreTo } from './restorePoints'
import type { RunSummary } from './team/service'
import type { Run } from './team/types'

// IPC for the project dashboard and the restore points browser. Everything the handlers need comes in through `deps`
// (the stores are created after the window, so they are read lazily).
export type ProjectToolsDeps = {
  listChats(): ChatSummary[]
  loadChat(id: string): Chat | null
  listRuns(): RunSummary[]
  getRun(id: string): Run | null
  scanned(): { path: string; mtime: number }[] // the cached folder scan, possibly empty
  busy(project: string): boolean // a Solo chat is working in this folder
}

const NAMES_FROM_CHATS = 25
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

export function registerProjectTools(deps: ProjectToolsDeps) {
  const overviewDeps: OverviewDeps = { chats: () => deps.listChats(), runs: () => deps.listRuns(), scanned: () => deps.scanned() }
  const known = new Set<string>() // folders the last overview listed: the only ones "open folder" will open

  // The renderer names the folder; it must be a real absolute folder, and never one a crew or a chat is writing into right now.
  const folder = async (p: unknown): Promise<string> => {
    if (typeof p !== 'string' || !isAbsolute(p) || p.length > 4096 || !(await stat(p).then((s) => s.isDirectory(), () => false))) throw new Error('That folder is not available.')
    return p
  }
  const pointId = (id: unknown): string => {
    if (typeof id !== 'string' || !/^\d{1,16}$/.test(id)) throw new Error('That restore point does not exist.')
    return id
  }

  // What made each point, when we know: the Crew run that landed (its goal) or the Solo chat that took it (its title).
  const namesFor = (project: string): Record<string, string> => {
    const names: Record<string, string> = {}
    for (const s of deps.listChats().filter((c) => c.project === project).slice(0, NAMES_FROM_CHATS)) {
      for (const id of Object.keys(deps.loadChat(s.id)?.checkpoints ?? {})) names[id] = `Solo: ${clip(s.title || 'New chat', 50)}`
    }
    for (const r of deps.listRuns().filter((x) => x.project === project)) {
      const id = deps.getRun(r.id)?.appliedCheckpoint
      if (id) names[id] = `Crew landing: ${clip(r.goal, 50)}`
    }
    return names
  }

  ipcMain.handle('projects:overview', async (_e, fresh?: unknown) => {
    const list = await cachedOverview(overviewDeps, fresh === true)
    list.forEach((p) => known.add(p.path))
    return list
  })
  ipcMain.handle('projects:open-folder', async (_e, path: unknown) => {
    const p = await folder(path)
    if (!known.has(p)) throw new Error('That folder is not one of your projects.')
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
  })

  ipcMain.handle('restore:list', async (_e, project: unknown) => {
    const p = await folder(project)
    return listRestorePoints(p, namesFor(p))
  })
  ipcMain.handle('restore:diff', async (_e, project: unknown, id: unknown) => restoreDiff(await folder(project), pointId(id)))
  ipcMain.handle('restore:apply', async (_e, project: unknown, id: unknown, files?: unknown) => {
    const p = await folder(project)
    if (deps.busy(p) || deps.listRuns().some((r) => r.project === p && ['planning', 'running', 'verifying'].includes(r.status))) throw new Error('Something is working in this project right now. Stop it or wait until it finishes, then restore.')
    const list = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string').slice(0, 20_000) : undefined
    return restoreTo(p, pointId(id), { files: list })
  })
}
