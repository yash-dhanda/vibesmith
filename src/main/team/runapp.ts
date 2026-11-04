import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { detectRun, ProjectRunner } from '../runner'

// "Run website": start the project's dev server for a Crew run and report its port. While the result is not applied yet the code lives in
// the crew's own folder; that folder has no node_modules, so the project's are linked in (and hidden from git) for as long as the app runs.

export const RUN_APP_WORDS = /^(?:please\s+)?(?:run|start|launch|serve|open)\s+(?:up\s+)?(?:the\s+|my\s+|this\s+)?(?:web\s?site|site|app|server|dev server|project|it)\b(?:\s+(?:so|and|for|please|now|here|again|give|show)\b.*)?$/i
export const STOP_APP_WORDS = /^(?:please\s+)?(?:stop|close|kill|shut down)\s+(?:the\s+|my\s+|this\s+)?(?:web\s?site|site|app|server|dev server)\b.*$/i
export const isRunAppWords = (text: string) => text.length <= 120 && RUN_APP_WORDS.test(text.trim())
export const isStopAppWords = (text: string) => text.length <= 120 && STOP_APP_WORDS.test(text.trim())

export type AppResult = { ok: boolean; message: string; url?: string }

function linkDeps(dir: string, project: string): boolean {
  const target = join(project, 'node_modules')
  const link = join(dir, 'node_modules')
  if (dir === project || existsSync(link) || !existsSync(target)) return false
  try {
    symlinkSync(target, link, 'dir')
    const rel = execFileSync('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim()
    const file = resolve(dir, rel)
    const have = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (!/^\/?node_modules\/?$/m.test(have)) appendFileSync(file, `${have.endsWith('\n') || !have ? '' : '\n'}node_modules\n`)
    return true
  } catch {
    return false
  }
}

export class AppRunners {
  private apps = new Map<string, { runner: ProjectRunner; dir: string; linked: boolean }>()
  constructor(private wait = 90_000, private tick = 250) {}

  async run(id: string, dir: string, project: string): Promise<AppResult> {
    const where = dir === project ? 'your project' : "the crew's copy, not applied to your project yet"
    const have = this.apps.get(id)
    if (have && ['starting', 'running'].includes(have.runner.state.state)) {
      const url = have.runner.state.url ?? undefined
      return { ok: true, url, message: url ? `The website is already running at ${url} (${where}).` : 'The website is starting; the port shows up in a moment.' }
    }
    this.drop(id)
    const first = detectRun(dir)
    if (first.kind === 'none') return { ok: false, message: 'There is nothing to run yet: no dev or start script, no index.html and no server file in the folder.' }
    if (first.kind === 'static') return { ok: true, message: `This is a plain page with no server. Open ${join(dir, 'index.html')} in your browser (${where}).` }
    const linked = linkDeps(dir, project)
    const command = detectRun(dir).command
    if (!command) return { ok: false, message: 'Could not work out how to start it.' }
    const runner = new ProjectRunner(dir, () => {}, () => {})
    this.apps.set(id, { runner, dir, linked })
    try { runner.start(command) } catch (e) { this.drop(id); return { ok: false, message: (e as Error).message } }
    for (let waited = 0; waited < this.wait; waited += this.tick) {
      await new Promise((r) => setTimeout(r, this.tick))
      const s = runner.state
      if (s.url) return { ok: true, url: s.url, message: `The website is running at ${s.url} (${where}). Say "stop the website" to stop it.` }
      if (s.state === 'exited') { this.drop(id); return { ok: false, message: `It stopped right away (exit ${s.exitCode}). Last output: ${runner.logs.slice(-400).trim() || 'none'}` } }
    }
    return { ok: true, message: `Started with \`${command}\` but no port has shown up after ${Math.round(this.wait / 1000)} s (${where}). Last output: ${runner.logs.slice(-300).trim() || 'none'}` }
  }

  stop(id: string): AppResult {
    if (!this.apps.has(id)) return { ok: false, message: 'No website is running for this run.' }
    this.drop(id)
    return { ok: true, message: 'The website was stopped.' }
  }

  stopAll() { for (const id of [...this.apps.keys()]) this.drop(id) }

  private drop(id: string) {
    const a = this.apps.get(id)
    if (!a) return
    this.apps.delete(id)
    a.runner.stop()
    if (a.linked) { try { if (lstatSync(join(a.dir, 'node_modules')).isSymbolicLink()) rmSync(join(a.dir, 'node_modules'), { force: true }) } catch {} }
  }
}
