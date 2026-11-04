import { ipcMain } from 'electron'
import { statSync } from 'node:fs'
import { commitRun, gitState, openPr, prBodyFor, pushBranch, commitMessageFor, isProtected, type GitResult } from './team/gitpr'
import { historyPath, readHistory } from './team/history'
import { searchAll, type SearchDeps } from './search'
import type { Run } from './team/types'

// IPC for the git buttons of a landed run and for "Search everything". Everything the handlers need comes in through `deps`
// (the stores are created after the window, so they are read lazily).
export type GitSearchDeps = Pick<SearchDeps, 'listChats' | 'loadChat' | 'listRuns'> & { getRun(id: string): Run | null }

export function registerGitSearch(deps: GitSearchDeps) {
  const find = (id: unknown): Run => {
    const run = typeof id === 'string' && /^[\w-]{1,80}$/.test(id) ? deps.getRun(id) : null
    if (!run) throw new Error('That run is not available.')
    return run
  }
  // The branch the folder is on now: commit, push and the pull request all act on it, never on a name from the renderer.
  const onBranch = async (run: Run, what: string): Promise<string | GitResult> => {
    const s = await gitState(run.project)
    if (!s.branch || isProtected(s.branch) || s.branch === s.defaultBranch) return { ok: false, message: `${what} needs a branch of its own. Commit the run to a branch first.` }
    return s.branch
  }

  ipcMain.handle('team:git-state', async (_e, id: unknown) => {
    const run = find(id)
    return { ...(await gitState(run.project)), landed: !!run.applied }
  })
  ipcMain.handle('team:git-commit', (_e, id: unknown) => commitRun(find(id).project, find(id)))
  ipcMain.handle('team:git-push', async (_e, id: unknown) => {
    const run = find(id)
    const b = await onBranch(run, 'Pushing')
    return typeof b === 'string' ? pushBranch(run.project, b) : b
  })
  ipcMain.handle('team:git-pr', async (_e, id: unknown) => {
    const run = find(id)
    const b = await onBranch(run, 'A pull request')
    return typeof b === 'string' ? openPr(run.project, b, commitMessageFor(run).split('\n')[0] ?? '', prBodyFor(run)) : b
  })

  const search: SearchDeps = {
    ...deps,
    historyStamp: (p) => { try { const s = statSync(historyPath(p)); return Math.floor(s.mtimeMs) + s.size } catch { return 0 } },
    readHistory,
  }
  ipcMain.handle('search:all', (_e, query: unknown) => searchAll(typeof query === 'string' ? query.slice(0, 200) : '', search))
}
