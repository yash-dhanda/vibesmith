import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppRunners, isRunAppWords, isStopAppWords } from './runapp'

describe('run website words', () => {
  it('matches the ways people ask for it, and nothing that is an instruction for the agents', () => {
    for (const t of ['run website', 'Run the website', 'start the website so i can check give the port', 'start the website', 'launch the app', 'please run it', 'serve the site now', 'open my project']) expect(isRunAppWords(t), t).toBe(true)
    for (const t of ['start building the website', 'run the tests', 'start the redesign of the app', 'run npm test', 'make the website faster', '']) expect(isRunAppWords(t), t).toBe(false)
    expect(isRunAppWords('run the website ' + 'x'.repeat(200))).toBe(false)
    for (const t of ['stop the website', 'close the server', 'Stop the app please']) expect(isStopAppWords(t), t).toBe(true)
    for (const t of ['stop', 'pause', 'stop working on the header']) expect(isStopAppWords(t), t).toBe(false)
  })
})

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' })
function toy() {
  const root = mkdtempSync(join(tmpdir(), 'forge-runapp-'))
  const project = join(root, 'proj')
  mkdirSync(project)
  git(project, 'init', '-q'); git(project, 'config', 'user.email', 't@t.t'); git(project, 'config', 'user.name', 't')
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 't', scripts: { dev: `node -e "console.log('ready on http://localhost:4321'); setInterval(() => {}, 1000)"` }, devDependencies: { left: '1' } }))
  writeFileSync(join(project, '.gitignore'), 'node_modules/\n')
  git(project, 'add', '-A'); git(project, 'commit', '-qm', 'init')
  mkdirSync(join(project, 'node_modules'))
  return { root, project }
}

describe('AppRunners', () => {
  it('starts the dev server in the project, reports the port, and stops it', async () => {
    const { project } = toy()
    const apps = new AppRunners(15_000, 50)
    const r = await apps.run('r1', project, project)
    expect(r.ok).toBe(true)
    expect(r.url).toBe('http://localhost:4321')
    expect(r.message).toContain('your project')
    expect((await apps.run('r1', project, project)).message).toContain('already running')
    expect(apps.stop('r1').ok).toBe(true)
    expect(apps.stop('r1').ok).toBe(false)
  }, 30_000)

  it("runs the crew's unapplied copy with the project's node_modules linked in, hidden from git, and unlinks it on stop", async () => {
    const { root, project } = toy()
    const wt = join(root, 'wt')
    git(project, 'worktree', 'add', '-q', '-b', 'forge/x', wt)
    const apps = new AppRunners(15_000, 50)
    const r = await apps.run('r2', wt, project)
    expect(r.url).toBe('http://localhost:4321')
    expect(r.message).toContain("crew's copy")
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(git(wt, 'status', '--porcelain')).toBe('') // the link does not show up as a change
    apps.stop('r2')
    expect(existsSync(join(wt, 'node_modules'))).toBe(false)
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('node_modules')
  }, 30_000)

  it('says so when there is nothing to run, and when the server dies at once', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'forge-runapp-empty-'))
    const apps = new AppRunners(5_000, 50)
    expect((await apps.run('e', empty, empty)).ok).toBe(false)
    const bad = mkdtempSync(join(tmpdir(), 'forge-runapp-bad-'))
    writeFileSync(join(bad, 'package.json'), JSON.stringify({ scripts: { dev: 'node -e "process.exit(3)"' } }))
    const r = await apps.run('b', bad, bad)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('exit 3')
  }, 20_000)
})
