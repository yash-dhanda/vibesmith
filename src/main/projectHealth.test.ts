import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectProject } from './projectHealth'

const made: string[] = []
function project(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'forge-health-'))
  made.push(d)
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(d, name)), { recursive: true }); writeFileSync(join(d, name), text) }
  return d
}
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })
const ids = async (d: string) => (await inspectProject(d)).suggestions.map((s) => s.id)
// Assembled at run time so this file does not itself look like a leaked key.
const AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'
const LONG_README = '# Demo\n\nThis project does a useful thing for people.\n\n## Run\n\n```\nnpm install\nnpm start\n```\n\n' + 'More words about it. '.repeat(20)

describe('inspectProject', () => {
  it('detects the stack and frameworks', async () => {
    const d = project({
      'package.json': JSON.stringify({ dependencies: { express: '^4', prisma: '^5', 'discord.js': '^14' }, devDependencies: { typescript: '^5' } }),
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
      'app.py': 'print(1)',
      'requirements.txt': 'flask==3.0.0\nfastapi==0.1\n',
    })
    const r = await inspectProject(d)
    expect(r.stack).toEqual(expect.arrayContaining(['node', 'typescript', 'express', 'prisma', 'discord.js', 'python', 'flask', 'fastapi']))
    expect(r.facts.tsStrict).toBe(true)
  })
  it('calls a plain html folder static', async () => {
    const r = await inspectProject(project({ 'index.html': '<html lang="en"><head><title>x</title></head></html>' }))
    expect(r.stack).toEqual(['html', 'static'])
  })

  it('flags secrets by file and line without printing them', async () => {
    const d = project({ 'package.json': '{}', 'src/config.js': `const a = 1\nconst key = "${AWS}"\n`, '.gitignore': 'node_modules\n.env\n' })
    const r = await inspectProject(d)
    const s = r.suggestions.find((x) => x.id === 'secrets-in-code')!
    expect(s.severity).toBe('high')
    expect(s.evidence.join(' ')).toContain('src/config.js:2')
    expect(JSON.stringify(r)).not.toContain(AWS)
  })
  it('ignores secrets in git-ignored files, tests and placeholders', async () => {
    const d = project({ '.gitignore': '.env\n', '.env': `KEY=${AWS}\n`, 'a.test.js': `const k = "${AWS}"`, 'b.js': 'const k = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"' })
    expect(await ids(d)).not.toContain('secrets-in-code')
  })
  it('flags a .env that git does not ignore, and stays quiet when it is ignored', async () => {
    expect(await ids(project({ '.env': 'A=1\n' }))).toContain('env-not-ignored')
    expect(await ids(project({ '.env': 'A=1\n', '.gitignore': '.env*\n' }))).not.toContain('env-not-ignored')
  })
  it('sees a .env that was committed', async () => {
    const d = project({ '.env': 'A=1\n', 'a.txt': 'x' })
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' })
    g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'x')
    const r = await inspectProject(d)
    expect(r.suggestions.find((s) => s.id === 'env-not-ignored')?.title).toMatch(/committed/)
    expect(r.facts.git).toMatchObject({ repo: true, commits: true, remote: false, uncommitted: 0 })
    expect(r.suggestions.map((s) => s.id)).toContain('git-no-remote')
  })
  it('reports a repository without commits', async () => {
    const d = project({ 'a.txt': 'x' })
    execFileSync('git', ['init', '-q'], { cwd: d })
    const r = await inspectProject(d)
    expect(r.facts.git.commits).toBe(false)
    expect(r.suggestions.map((s) => s.id)).toContain('git-no-commits')
  })

  it('wants tests when there are none, and a test script when only test files exist', async () => {
    const src = { 'a.js': '1', 'b.js': '2', 'c.js': '3' }
    expect(await ids(project({ 'package.json': '{}', ...src }))).toContain('no-tests')
    expect(await ids(project({ 'package.json': '{"scripts":{"test":"vitest run"}}', ...src }))).not.toContain('no-tests')
    const d = await ids(project({ 'package.json': '{}', 'a.test.js': 'x', 'b.js': '1', 'c.js': '2' }))
    expect(d).toContain('no-test-script')
    expect(d).not.toContain('no-tests')
  })
  it('counts empty catches, debug leftovers and todos', async () => {
    const d = project({ 'a.js': 'try { x() } catch (e) {}\ntry { y() } catch {\n}\ndebugger\n// TODO a\n// FIXME b\n// HACK c\n// TODO d\n// TODO e\n' })
    const r = await inspectProject(d)
    expect(r.facts).toMatchObject({ emptyCatches: 2, debuggers: 1, todos: 5 })
    expect(r.suggestions.map((s) => s.id)).toEqual(expect.arrayContaining(['empty-catch', 'debug-leftovers', 'todo-pile']))
  })
  it('flags non-strict TypeScript, loose and deprecated dependencies, missing engines and lockfile', async () => {
    const d = project({ 'package.json': JSON.stringify({ dependencies: { request: '^2', lodash: '*', left: 'latest' } }), 'tsconfig.json': '{ "compilerOptions": { "strict": false } }' })
    const r = await inspectProject(d)
    const got = r.suggestions.map((s) => s.id)
    expect(got).toEqual(expect.arrayContaining(['ts-not-strict', 'deprecated-deps', 'loose-versions', 'no-lockfile', 'no-engines']))
    expect(r.suggestions.find((s) => s.id === 'loose-versions')!.evidence).toEqual(['lodash@*', 'left@latest'])
  })
  it('judges the README', async () => {
    expect(await ids(project({ 'a.js': '1' }))).toContain('readme-missing')
    expect(await ids(project({ 'README.md': '# hi' }))).toContain('readme-thin')
    const good = await ids(project({ 'README.md': LONG_README, 'LICENSE': 'MIT' }))
    expect(good).not.toContain('readme-missing')
    expect(good).not.toContain('readme-thin')
    expect(good).not.toContain('no-license')
  })
  it('checks html for lang, viewport, title and alt text', async () => {
    const d = project({ 'index.html': '<html><head></head><body><img src="a.png"><img src="b.png" alt="b"></body></html>', 'partial.html': '<div><img src="x.png"></div>' })
    const r = await inspectProject(d)
    const got = Object.fromEntries(r.suggestions.map((s) => [s.id, s]))
    expect(got['html-lang'].evidence).toEqual(['index.html'])
    expect(got['html-viewport']).toBeTruthy()
    expect(got['html-title']).toBeTruthy()
    expect(got['img-alt'].evidence[0]).toMatch(/^2 images/)
  })
  it('finds very large source files and duplicated big files', async () => {
    const big = 'x'.repeat(1_100_000)
    const copy = 'y'.repeat(6000)
    const r = await inspectProject(project({ 'huge.js': big, 'a/util.js': copy, 'b/util.js': copy }))
    expect(r.suggestions.find((s) => s.id === 'huge-files')!.evidence).toEqual(['huge.js'])
    expect(r.suggestions.find((s) => s.id === 'duplicate-files')!.evidence[0]).toContain('a/util.js = b/util.js')
  })
  it('skips node_modules and caps the number of files walked', async () => {
    const files: Record<string, string> = { 'node_modules/x/index.js': `const k = "${AWS}"` }
    const d = project(files)
    expect((await inspectProject(d)).suggestions.map((s) => s.id)).not.toContain('secrets-in-code')
    const many = project(Object.fromEntries(Array.from({ length: 4100 }, (_, i) => [`f/${i}.txt`, ''])))
    const r = await inspectProject(many)
    expect(r.facts.files).toBe(4000)
    expect(r.facts.truncated).toBe(true)
  })
  it('orders by severity then effort, caps at 25, and gives every suggestion a goal', async () => {
    const d = project({ 'package.json': JSON.stringify({ dependencies: { request: '*', express: '^4' } }), 'a.js': `const k="${AWS}"\ntry{}catch(e){}`, 'b.js': '1', 'c.js': '2', 'index.html': '<html></html>' })
    const r = await inspectProject(d)
    const rank = { high: 0, medium: 1, low: 2 }
    for (let i = 1; i < r.suggestions.length; i++) {
      const a = r.suggestions[i - 1], b = r.suggestions[i]
      expect(rank[a.severity] < rank[b.severity] || (a.severity === b.severity && a.effortMinutes <= b.effortMinutes)).toBe(true)
    }
    expect(r.suggestions.length).toBeLessThanOrEqual(25)
    for (const s of r.suggestions) { expect(s.goal.length).toBeGreaterThan(80); expect(s.why).toBeTruthy(); expect(s.evidence.length).toBeGreaterThan(0) }
    expect(new Set(r.suggestions.map((s) => s.id)).size).toBe(r.suggestions.length)
  })
  it('stays quiet about a tidy project', async () => {
    const d = project({
      'package.json': JSON.stringify({ license: 'MIT', engines: { node: '>=20' }, scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { prettier: '1', eslint: '1' } }),
      'package-lock.json': '{}', 'README.md': LONG_README, '.gitignore': 'node_modules\n.env\n', 'a.js': '1', 'b.js': '2', 'c.js': '3', 'a.test.js': 'x',
    })
    expect(await ids(d)).toEqual(['no-git']) // everything else is in order
  })
  it('finishes well inside two seconds', async () => {
    const d = project(Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`src/m${i % 30}/f${i}.js`, 'export const a = 1\n'.repeat(50)])))
    const t = Date.now()
    await inspectProject(d)
    expect(Date.now() - t).toBeLessThan(2000)
  })
})
