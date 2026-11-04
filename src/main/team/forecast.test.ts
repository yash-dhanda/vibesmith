import { describe, expect, it } from 'vitest'
import { forecast, mainAuthor, taskStats } from './forecast'
import { onlyDocsOrConfig, touchesSecurity } from './security'
import { emptyUsage, type Run, type Task } from './types'

const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, goal: '', acceptance: [], deps: [], agent: 'claude', kind: 'build', files: [], status: 'done', phase: null, attempts: 0, fixRounds: 0, reviews: [], sessions: {}, branch: null, worktree: null, summary: '', handoff: '', changed: [], usage: emptyUsage(), ...extra })
const use = (input: number, output: number, costUsd = 0) => ({ ...emptyUsage(), input, output, costUsd, runs: 1 })
const run = (tasks: Task[], extra: Partial<Run> = {}) => ({ tasks, usage: { claude: emptyUsage(), codex: emptyUsage() }, ...extra }) as unknown as Run
const NOW = 1_000_000

describe('taskStats', () => {
  it('reports seconds, tokens and cost per task; a running task counts up to now, an unstarted one is zero', () => {
    const s = taskStats(run([task('a', { startedAt: NOW - 90_000, endedAt: NOW - 30_000, usage: use(100, 50, 0.25) }), task('b', { status: 'running', startedAt: NOW - 10_000 }), task('c', { status: 'queued', agent: 'codex' })]), NOW)
    expect(s).toEqual([{ id: 'a', agent: 'claude', seconds: 60, tokens: 150, costUsd: 0.25 }, { id: 'b', agent: 'claude', seconds: 10, tokens: 0, costUsd: 0 }, { id: 'c', agent: 'codex', seconds: 0, tokens: 0, costUsd: 0 }])
  })
})

describe('forecast', () => {
  const done = (id: string, secs: number, tokens: number) => task(id, { startedAt: 0, endedAt: secs * 1000, usage: use(tokens, 0) })
  it('averages the finished tasks and projects the rest', () => {
    const f = forecast(run([done('a', 60, 1000), done('b', 120, 3000), task('c', { status: 'queued' }), task('d', { status: 'running', startedAt: 0 }), task('e', { status: 'cancelled' })]), undefined, NOW)
    expect(f).toEqual({ tasksDone: 2, tasksLeft: 2, avgTokensPerTask: 2000, avgSecondsPerTask: 90, estTokensLeft: 4000, estMinutesLeft: 3 })
  })
  it('knows nothing before the first task is done, and nothing is left when all are', () => {
    expect(forecast(run([task('a', { status: 'queued' })]), undefined, NOW)).toMatchObject({ tasksDone: 0, tasksLeft: 1, estTokensLeft: 0, estMinutesLeft: 0 })
    expect(forecast(run([done('a', 30, 10)]), undefined, NOW)).toMatchObject({ tasksLeft: 0, estTokensLeft: 0 })
  })
  it('estimates the plan share left from the window reading when there is one', () => {
    const r = run([done('a', 60, 1000), task('b', { status: 'queued' }), task('c', { status: 'queued' })], { usage: { claude: emptyUsage(), codex: use(1000, 0) } } as never)
    expect(forecast(r, { codex: { primaryPct: 10 } }, NOW).estPlanPctLeft).toBe(70) // 10% for 1000 tokens: 2000 more tokens cost 20% more
    expect(forecast(r, {}, NOW).estPlanPctLeft).toBeUndefined()
    expect(forecast(r, { codex: { primaryPct: 60 } }, NOW).estPlanPctLeft).toBe(0)
  })
})

describe('mainAuthor', () => {
  it('is the agent with the most changed files, ignoring research and last-step fixes', () => {
    const ch = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, status: 'added' as const, added: 1, removed: 0 }))
    expect(mainAuthor(run([task('a', { changed: ch(2) }), task('b', { agent: 'codex', changed: ch(3) }), task('c', { agent: 'codex', kind: 'research', changed: ch(9) })]))).toBe('codex')
    expect(mainAuthor(run([task('a', { changed: [] })]))).toBeNull()
  })
})

describe('security triggers', () => {
  const f = (...paths: string[]) => paths.map((path) => ({ path }))
  it('flags auth, secrets, payments, admin and dependency files, and new routes in the diff', () => {
    for (const p of ['src/auth/login.ts', 'lib/session.py', 'app/PasswordReset.tsx', 'api/token.ts', 'payment/charge.go', 'web/checkout.html', 'x/withdraw.ts', 'admin/panel.ts', '.env.production', 'config/secrets.json', 'package.json', 'go.mod', 'requirements-dev.txt']) expect(touchesSecurity(f(p)), p).toBe(true)
    expect(touchesSecurity(f('src/util.ts'), "+router.post('/users', handler)")).toBe(true)
    expect(touchesSecurity(f('src/api.ts'), "+@Get('/items')\n")).toBe(true)
    expect(touchesSecurity(f('src/util.ts', 'docs/author.md'), '+const x = 1\n router.get("/old")')).toBe(false) // only an added line counts, and "author" is not "auth"
  })
  it('knows a change that is only docs or config', () => {
    expect(onlyDocsOrConfig(f('README.md', 'docs/a.png', 'tsconfig.json', '.github/ci.yml'))).toBe(true)
    expect(onlyDocsOrConfig(f('README.md', 'src/a.ts'))).toBe(false)
  })
})
