import { ipcMain } from 'electron'
import { featureIdeasFor, type FeatureIdea } from './featureIdeas'
import { inspectProject, type HealthReport } from './projectHealth'

// IPC for "Improve this project". The folder is always the window's current project (rootOf), never a path sent by the renderer.
export type IdeasDeps = { rootOf: (e: unknown) => string | null }
export type FeatureIdeasResult = { stack: string[]; ideas: FeatureIdea[] }

const TTL = 20_000 // the dialog asks for the report and the feature list back to back; one walk serves both
export function registerIdeas(d: IdeasDeps) {
  const project = (e: unknown) => d.rootOf(e) ?? (() => { throw new Error('Choose a project folder first.') })()
  const recent = new Map<string, { at: number; report: Promise<HealthReport> }>()
  const inspect = (root: string, fresh = false) => {
    const hit = recent.get(root)
    if (hit && !fresh && Date.now() - hit.at < TTL) return hit.report
    const report = inspectProject(root)
    recent.set(root, { at: Date.now(), report })
    report.catch(() => recent.delete(root))
    return report
  }
  ipcMain.handle('project:health', (e, fresh?: unknown): Promise<HealthReport> => inspect(project(e), fresh === true))
  ipcMain.handle('project:feature-ideas', async (e): Promise<FeatureIdeasResult> => {
    const { stack } = await inspect(project(e))
    return { stack, ideas: featureIdeasFor(stack) }
  })
}
