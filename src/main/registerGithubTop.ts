import { BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { safetyCheck } from './repoSafety'
import { SavedStore, type NewSaved } from './savedRepos'
import { cloneAsReference, cloneRepo, freeBytes } from './githubClone'
import { ownersVerified, refreshStars, repoSize, repoSummary, skillSuggestions, topRepos, validRepoName, type Mode, type Period } from './githubTop'
import type { Reference } from './references'

// IPC for the Top GitHub repos browser. Arguments come from the window, so each one is checked here before it reaches the network or the disk.
export type CloneResult = { path: string | null; reference?: Reference }
// What the window needs before it asks the owner to confirm: where the clone goes (null: the folder dialog was cancelled), how big it is and how much room is left.
export type ClonePlan = { parent: string | null; sizeKb: number | null; freeBytes: number | null }

export function registerGithubTop(d: { rootOf: (e: unknown) => string | null; userData: string }) {
  const saved = new SavedStore(join(d.userData, 'savedRepos.json'))
  const repo = (v: unknown) => { if (typeof v !== 'string' || !validRepoName(v)) throw new Error('That is not a GitHub repository name.'); return v }
  const project = (e: unknown) => d.rootOf(e) ?? (() => { throw new Error('Open a project first.') })()
  let picked: string | null = null // the one folder the dialog returned; a new-project clone goes only there

  ipcMain.handle('github:top', (_e, period: unknown, mode: unknown, refresh: unknown) => {
    if (period !== 'day' && period !== 'week' && period !== 'month' && period !== 'all') throw new Error('Unknown period.')
    if (mode !== 'new' && mode !== 'trending') throw new Error('Unknown list.')
    return topRepos({ period: period as Period, mode: mode as Mode, refresh: refresh === true })
  })
  ipcMain.handle('github:summary', (_e, fullName: unknown) => repoSummary(repo(fullName)))

  ipcMain.handle('github:skill-suggestions', (_e, round: unknown, exclude: unknown) => {
    if (typeof round !== 'number' || !Number.isInteger(round) || round < 0 || round > 50) throw new Error('Unknown round.')
    if (!Array.isArray(exclude) || exclude.length > 3000 || exclude.some((n) => typeof n !== 'string' || n.length > 200)) throw new Error('Unknown list.')
    return skillSuggestions({ round, exclude })
  })

  ipcMain.handle('github:owners', (_e, owners: unknown) => {
    if (!Array.isArray(owners) || owners.length > 200 || owners.some((o) => typeof o !== 'string' || !/^[\w.-]{1,39}$/.test(o) || /^\.+$/.test(o))) throw new Error('Unknown owners.')
    return ownersVerified(owners as string[])
  })

  ipcMain.handle('github:safety', (_e, fullName: unknown) => safetyCheck(repo(fullName)))

  // Saved list. Opening it can refresh the star counts; a rate limit just leaves the older numbers.
  ipcMain.handle('github:saved-list', async (_e, refresh: unknown) => {
    let items = saved.list()
    let stopped: 'rate' | 'error' | null = null
    if (refresh === true && items.length) {
      const r = await refreshStars(items.map((x) => x.fullName))
      stopped = r.stopped
      if (r.checked) items = saved.updateStars(r.stars)
    }
    return { items, stopped }
  })
  ipcMain.handle('github:saved-set', (_e, item: unknown) => {
    const x = item as NewSaved
    if (!x || typeof x !== 'object') throw new Error('Nothing to save.')
    repo(x.fullName)
    if (typeof x.description !== 'string' || typeof x.stars !== 'number' || !Array.isArray(x.topics) || x.topics.length > 50 || (x.language !== null && typeof x.language !== 'string') || (x.note !== undefined && typeof x.note !== 'string')) throw new Error('Nothing to save.')
    return saved.set({ fullName: x.fullName, url: '', description: x.description, stars: x.stars, topics: x.topics, language: x.language, note: x.note })
  })
  ipcMain.handle('github:saved-remove', (_e, fullName: unknown) => saved.remove(repo(fullName)))

  ipcMain.handle('github:plan', async (e, fullName: unknown, mode: unknown, knownKb: unknown): Promise<ClonePlan> => {
    const name = repo(fullName)
    let parent: string
    if (mode === 'reference') parent = project(e)
    else if (mode === 'project') {
      // The folder dialog exists only in the computer's window; a phone cannot choose a folder on the computer.
      if ((e as { remote?: boolean }).remote) throw new Error('Cloning a new project works from the Forge window on the computer.')
      const win = BrowserWindow.fromWebContents((e as { sender: Electron.WebContents }).sender)
      const opts = { title: `Choose where to put ${name.split('/')[1]}`, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
      const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      picked = pick.canceled ? null : (pick.filePaths[0] ?? null)
      if (!picked) return { parent: null, sizeKb: null, freeBytes: null }
      parent = picked
    } else throw new Error('Unknown way to add it.')
    const sizeKb = typeof knownKb === 'number' && knownKb > 0 ? knownKb : await repoSize(name).catch(() => null)
    return { parent: mode === 'project' ? parent : null, sizeKb, freeBytes: await freeBytes(parent) }
  })

  ipcMain.handle('github:clone', async (e, fullName: unknown, mode: unknown, description: unknown, parent: unknown): Promise<CloneResult> => {
    const name = repo(fullName)
    const sizeKb = await repoSize(name).catch(() => null)
    const send = (ch: string, p: unknown) => (e as { sender?: { send?: (c: string, p: unknown) => void } }).sender?.send?.(ch, p)
    const deps = { sizeKb, onProgress: (bytes: number) => send('github:clone-progress', { fullName: name, bytes }) }
    if (mode === 'reference') {
      const ref = await cloneAsReference(project(e), name, typeof description === 'string' ? description.replace(/\s+/g, ' ').trim().slice(0, 200) : '', deps)
      return { path: ref.path ?? null, reference: ref }
    }
    if (mode !== 'project') throw new Error('Unknown way to add it.')
    if ((e as { remote?: boolean }).remote) throw new Error('Cloning a new project works from the Forge window on the computer.')
    if (typeof parent !== 'string' || parent !== picked) throw new Error('Choose the folder again.')
    picked = null
    const dest = join(parent, name.split('/')[1])
    await cloneRepo({ fullName: name, dest }, deps)
    return { path: dest }
  })
}
