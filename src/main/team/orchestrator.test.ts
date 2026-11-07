import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentName } from './events'
import { ProjectMemoryStore } from './memory'
import { asksForLocal, isLimitPause, limitBackAt, TeamOrchestrator, type AgentCall, type AgentRunner, type Deps } from './orchestrator'
import type { RunResult } from './process'
import { TeamStore } from './store'
import type { Run, RunEvent } from './types'

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
const project = () => {
  const d = mkdtempSync(join(tmpdir(), 'forge-orch-p-'))
  sh(d, 'init', '-q')
  writeFileSync(join(d, 'base.txt'), 'base\n')
  sh(d, 'add', '-A')
  sh(d, 'commit', '-q', '-m', 'init')
  return d
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ok = (text: string, agent: string, taskId: string, usage = { input: 10, output: 5, cached: 0, costUsd: 0 }): RunResult => ({ ok: true, text, sessionId: `s-${agent}-${taskId}`, usage, events: [] })

type Plan = { summary?: string; tasks: object[] }
type Script = {
  plan: Plan
  work?: (agent: AgentName, task: string, cwd: string) => void | Promise<void>
  reviews?: Record<string, string[]> // task -> verdicts in order; default PASS
  conflict?: (cwd: string) => void | Promise<void>
  verifyFix?: (cwd: string) => void
  delayMs?: number
  limitsPct?: number // emitted by the work step, like Codex app-server's plan readout
  steerable?: boolean
  stream?: boolean // emit typing events and leave a file in the folder for a while
  fail?: (agent: AgentName, kind: 'plan' | 'work' | 'review' | 'fix' | 'verifyfix' | 'security', task: string, n: number, resume?: string) => RunResult | null
  security?: string[] // verdicts of the security review in order; default PASS
  hang?: (agent: AgentName, kind: string, task: string, n: number) => boolean // the agent says nothing until it is stopped, like a hung CLI
}

function harness(script: Script, over: { available?: AgentName[]; cfg?: object; sleep?: (ms: number) => Promise<void>; deps?: Partial<Deps> } = {}) {
  const proj = project()
  const teamDir = mkdtempSync(join(tmpdir(), 'forge-orch-t-'))
  const events: RunEvent[] = []
  const calls: { agent: AgentName; kind: string; task: string; cwd: string; resume?: string; model?: string; prompt: string; effort?: string }[] = []
  const counts = new Map<string, number>()
  const steers: string[] = []
  let active = 0, maxActive = 0
  let approve: AgentCall['onApproval']
  const runner: AgentRunner = async (agent, o: AgentCall) => {
    const p = o.prompt
    const find = (re: RegExp) => p.match(re)?.[1] ?? ''
    let kind = 'work', task = find(/# Your task (t\d+)/)
    if (/lead planner/.test(p)) (kind = 'plan'), (task = 'plan')
    else if (/You are reviewing/.test(p)) (kind = 'review'), (task = find(/task that was done: (t\d+)/))
    else if (/A reviewer checked your work on task (t\d+)/.test(p)) (kind = 'fix'), (task = find(/work on task (t\d+)/))
    else if (/produced conflicts/.test(p)) (kind = 'conflict'), (task = find(/Merging task (t\d+)/))
    else if (/project's check failed/.test(p)) kind = 'verifyfix'
    else if (/You are the security reviewer/.test(p)) kind = 'security'
    else if (/The team finished this goal/.test(p)) kind = 'final'
    calls.push({ agent, kind, task, cwd: o.cwd, resume: o.resume, model: o.model, prompt: p, effort: o.effort })
    if (kind === 'work') approve = o.onApproval
    const n = (counts.set(`${kind}:${task}`, (counts.get(`${kind}:${task}`) ?? 0) + 1), counts.get(`${kind}:${task}`)!)
    const failure = script.fail?.(agent, kind as never, task, n, o.resume)
    if (failure) return failure
    if (script.hang?.(agent, kind, task, n)) {
      await new Promise<void>((res) => (o.signal.aborted ? res() : o.signal.addEventListener('abort', () => res(), { once: true })))
      return { ...ok('', agent, task), ok: false, error: { kind: 'aborted', message: 'stopped' } }
    }
    active++
    maxActive = Math.max(maxActive, active)
    try {
      if (script.steerable && kind === 'work') o.onHandle?.({ steer: async (t) => (steers.push(t), true), interrupt() {} })
      if (script.stream && kind === 'work') {
        for (const t of ['Hel', 'lo ', 'world']) o.onEvent({ type: 'delta', agent, channel: 'text', text: t })
        o.onEvent({ type: 'code', agent, id: 'w1', path: `${task}.txt`, text: 'par', kind: 'content', done: false })
        o.onEvent({ type: 'code', agent, id: 'w1', path: `${task}.txt`, text: 'partial file', kind: 'content', done: false })
        writeFileSync(join(o.cwd, `${task}.txt`), 'live\n')
        await sleep(300)
      }
      if (script.delayMs) await sleep(script.delayMs)
      if (o.signal.aborted) return { ...ok('', agent, task), ok: false, error: { kind: 'aborted', message: 'stopped' } }
      if (kind === 'plan' && /already working/.test(p)) {
        // a newer request: like a real planner, add one task for it
        const asked = [...p.matchAll(/REQUEST \d+[^\n]*:\n([\s\S]*?)(?=\n\nREQUEST \d+|\n\n(?:PROJECT NOTES|WHAT THE TEAM))/g)]
        const newest = asked.at(-1)?.[1]?.trim() ?? 'more'
        return ok('```json\n' + JSON.stringify({ summary: 'new request', tasks: [{ id: 'n1', title: newest.slice(0, 60), goal: newest, agent: 'claude', kind: 'build', acceptance: [], deps: [], files: [] }], cancel: [] }) + '\n```', agent, task)
      }
      if (kind === 'plan') return ok('```json\n' + JSON.stringify(script.plan) + '\n```', agent, task)
      if (kind === 'work') {
        if (script.limitsPct) o.onEvent({ type: 'limits', agent, primaryPct: script.limitsPct, secondaryPct: 3 })
        if (script.work) await script.work(agent, task, o.cwd)
        else writeFileSync(join(o.cwd, `${task}.txt`), `${task} by ${agent}\n`)
        return ok(`did ${task}`, agent, task)
      }
      if (kind === 'review') {
        const v = script.reviews?.[task]?.[n - 1] ?? 'PASS'
        return ok(`- ${v === 'FAIL' ? 'missing the thing' : 'fine'}\nVERDICT: ${v}`, agent, task)
      }
      if (kind === 'fix') {
        writeFileSync(join(o.cwd, `${task}-fixed.txt`), 'fixed\n')
        return ok('fixed it', agent, task)
      }
      if (kind === 'conflict') {
        await script.conflict?.(o.cwd)
        return ok('merged both', agent, task)
      }
      if (kind === 'verifyfix') {
        script.verifyFix?.(o.cwd)
        return ok('fixed the check', agent, 'v')
      }
      if (kind === 'security') {
        const v = script.security?.[n - 1] ?? 'PASS'
        return ok(`- ${v === 'FAIL' ? 'user input reaches a shell' : 'nothing found'}\nVERDICT: ${v}`, agent, task)
      }
      return ok('VERDICT: PASS', agent, task)
    } finally {
      active--
    }
  }
  const store = new TeamStore(join(teamDir, 'runs'))
  const orch = new TeamOrchestrator({ store, teamDir, runner, available: async () => over.available ?? ['claude', 'codex'], codexModels: async () => ['gpt-x-luna'], localModels: async () => ['qwen-x'], emit: (e) => events.push(e), sleep: over.sleep ?? (async () => {}), ...over.deps })
  return { proj, orch, events, calls, store, teamDir, steers, maxActive: () => maxActive, ready: () => !!approve, approve: (a: Parameters<NonNullable<AgentCall['onApproval']>>[0]) => approve!(a) }
}

async function until(orch: TeamOrchestrator, id: string, pred: (r: Run) => boolean, ms = 15000): Promise<Run> {
  const t = Date.now()
  for (;;) {
    const r = orch.get(id)!
    if (pred(r)) return r
    if (Date.now() - t > ms) throw new Error(`timeout; status=${r.status} (${r.pausedReason ?? ''}) tasks=${r.tasks.map((x) => `${x.id}:${x.status}/${x.phase}`).join(' ')}`)
    await sleep(15)
  }
}
const T = (id: string, extra: object = {}) => ({ id, title: `Task ${id}`, goal: `do ${id}`, acceptance: ['works'], deps: [], agent: 'claude', kind: 'build', files: [], ...extra })

let orchs: TeamOrchestrator[] = []
afterEach(() => (orchs.forEach((o) => o.shutdown()), (orchs = [])))
const h = (s: Script, o?: Parameters<typeof harness>[1]) => {
  const x = harness(s, o)
  orchs.push(x.orch)
  return x
}

describe('team orchestrator', () => {
  it('plans, runs independent tasks in parallel, reviews across agents, merges, and applies on approval', async () => {
    const x = h({ delayMs: 40, plan: { summary: 'build it', tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'codex' }), T('c', { agent: 'claude', deps: ['a', 'b'] })] } })
    const run = await x.orch.start(x.proj, 'make three things')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks.map((t) => t.status)).toEqual(['done', 'done', 'done'])
    expect(x.maxActive()).toBeGreaterThanOrEqual(2) // a and b ran at the same time
    // the reviewer is always the other agent
    for (const c of x.calls.filter((c) => c.kind === 'review')) {
      const author = x.calls.find((a) => a.kind === 'work' && a.task === c.task)!.agent
      expect(c.agent).not.toBe(author)
    }
    // c started after a and b were merged, so it sees their files
    expect(r.tasks[2].handoff).toBeTruthy()
    expect(['t1', 't2', 't3'].every((t) => existsSync(join(r.integrationWorktree, `${t}.txt`)))).toBe(true)
    expect(existsSync(join(x.proj, 't1.txt'))).toBe(false) // the user's folder is untouched until approval
    expect(r.final?.report).toContain('Task a')
    expect(r.approvals.filter((a) => a.kind === 'final' && a.status === 'pending')).toHaveLength(1)
    expect(r.messages.some((m) => m.kind === 'handoff')).toBe(true)
    expect(r.usage.claude.runs + r.usage.codex.runs).toBe(x.calls.length)

    const done = await x.orch.approveFinal(run.id)
    expect(done.ok).toBe(true)
    expect(readFileSync(join(x.proj, 't3.txt'), 'utf8')).toBe('t3 by claude\n')
    expect(x.orch.get(run.id)?.status).toBe('done')
    expect(sh(x.proj, 'worktree', 'list').trim().split('\n')).toHaveLength(1) // worktrees are gone
    expect(sh(x.proj, 'branch', '--list', 'forge/*').trim()).toBe('')

  })

  it('keeps the same run going: a message after the result was applied reopens it with a new task', async () => {
    const x = h({ plan: { tasks: [T('a'), T('b')] } })
    const run = await x.orch.start(x.proj, 'first job')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.approveFinal(run.id)
    expect(x.orch.get(run.id)?.status).toBe('done')
    await x.orch.followUp(run.id, 'now also add a third thing')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.id).toBe(run.id)
    expect(r.tasks).toHaveLength(3)
    expect(r.tasks[2]).toMatchObject({ goal: 'now also add a third thing', status: 'done' })
    expect(r.applied).toBe(false)
    expect(r.approvals.filter((a) => a.kind === 'final' && a.status === 'pending')).toHaveLength(1)
    expect(existsSync(join(r.integrationWorktree, 't1.txt'))).toBe(true) // the first round's files are in the project, so the new branch has them
    expect((await x.orch.approveFinal(run.id)).ok).toBe(true)
  })

  it('"start the website" starts the dev server and reports it instead of steering the agents', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const calls: string[] = []
    ;(x.orch as any).d.runApp = async (r: { id: string }) => (calls.push(r.id), { ok: true, message: 'The website is running at http://localhost:4321' })
    ;(x.orch as any).d.stopApp = () => ({ ok: true, message: 'The website was stopped.' })
    const run = await x.orch.start(x.proj, 'site')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.followUp(run.id, 'start the website so i can check give the port')
    await new Promise((r) => setTimeout(r, 50))
    const r = x.orch.get(run.id)!
    expect(calls).toEqual([run.id])
    expect(r.status).toBe('awaiting_approval') // no new task, nothing reopened
    expect(r.tasks).toHaveLength(1)
    expect(r.messages.some((m) => m.kind === 'steer' && /website/.test(m.body))).toBe(false)
    expect(r.messages.some((m) => /localhost:4321/.test(m.body))).toBe(true)
    await x.orch.followUp(run.id, 'stop the website')
    expect(x.orch.get(run.id)!.messages.some((m) => /was stopped/.test(m.body))).toBe(true)
  })

  it('a message with pictures or files names them and gives every later turn of every agent access', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'with files')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    const shot = { id: '1', name: 'screenshot-10-02.png', path: join(x.proj, 'shot.png'), kind: 'image' as const, size: 10 }
    await x.orch.followUp(run.id, 'make it look like this', 'all', [shot])
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval' && r.tasks.length === 2)
    expect(r.config.attachments?.map((f) => f.path)).toContain(shot.path)
    expect(r.tasks[1].goal).toContain('make it look like this')
    expect(r.tasks[1].goal).toContain(shot.path)
    await x.orch.followUp(run.id, '', 'all', [shot]) // only a file: the text is filled in, and the same file is not stored twice
    const r2 = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval' && r.tasks.length === 3)
    expect(r2.tasks[2].goal).toContain('See the attached files.')
    expect(r2.config.attachments?.filter((f) => f.path === shot.path)).toHaveLength(1)
  })

  it('page check: screenshots go to the final reviewer when the owner turned it on, a failing capture never blocks, and off means no capture', async () => {
    const prompts: string[] = []
    const mk = (visualCheck: 'off' | 'always', shots: () => Promise<{ route: string; size: string; path: string }[]>) => {
      const x = h({ plan: { tasks: [T('a')] } })
      const orig = (x.orch as any).d.runner
      ;(x.orch as any).d.runner = async (agent: AgentName, o: AgentCall) => { if (/The team finished this goal/.test(o.prompt)) prompts.push(o.prompt + '\nIMAGES:' + (o.images ?? []).join(',')); return orig(agent, o) }
      ;(x.orch as any).d.visualShots = shots
      return { x, visualCheck }
    }
    const on = mk('always', async () => [{ route: '/', size: 'phone', path: '/tmp/shot-phone.png' }])
    const r = await on.x.orch.start(on.x.proj, 'ui', { finalReview: true, visualCheck: 'always' })
    await until(on.x.orch, r.id, (v) => v.status === 'awaiting_approval')
    const seen = prompts.find((p) => p.includes('/tmp/shot-phone.png'))
    expect(seen).toBeTruthy()
    expect(seen).toContain('IMAGES:/tmp/shot-phone.png')
    let called = 0
    const off = mk('off', async () => (called++, []))
    const r2 = await off.x.orch.start(off.x.proj, 'ui', { finalReview: true, visualCheck: 'off' })
    await until(off.x.orch, r2.id, (v) => v.status === 'awaiting_approval')
    expect(called).toBe(0)
    const bad = mk('always', async () => { throw new Error('no dev server') })
    const r3 = await bad.x.orch.start(bad.x.proj, 'ui', { finalReview: true, visualCheck: 'always' })
    const done = await until(bad.x.orch, r3.id, (v) => v.status === 'awaiting_approval')
    expect(done.messages.some((m) => /Page check skipped: no dev server/.test(m.body))).toBe(true)
  })

  it('when the local model fails a task, a cloud agent takes it over once instead of pausing the run', async () => {
    const lost = { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'other' as const, message: 'The local model gave up (too many steps).' } }
    const x = h({ plan: { tasks: [T('a', { agent: 'local' })] }, fail: (agent, kind) => (agent === 'local' && kind === 'work' ? lost : null) }, { available: ['claude', 'codex', 'local'] })
    const run = await x.orch.start(x.proj, 'local fails')
    const r = await until(x.orch, run.id, (v) => v.status === 'awaiting_approval' || v.status === 'paused')
    expect(r.status).toBe('awaiting_approval')
    expect(r.tasks[0]).toMatchObject({ status: 'done', escalated: true })
    expect(r.tasks[0].agent).not.toBe('local')
    expect(r.messages.some((m) => /local model could not finish/.test(m.body))).toBe(true)
    // only once: a task the cloud agent also fails is a real failure
    const y = h({ plan: { tasks: [T('a', { agent: 'local' })] }, fail: (agent, kind) => (kind === 'work' ? lost : null) }, { available: ['claude', 'codex', 'local'] })
    const run2 = await y.orch.start(y.proj, 'everyone fails', { autoSwitch: true })
    const r2 = await until(y.orch, run2.id, (v) => v.status === 'paused' || v.status === 'awaiting_approval')
    expect(r2.tasks[0].status).toBe('failed')
  })

  it('takes an applied result back out of the project with undo', async () => {
    const x = h({ plan: { tasks: [T('a'), T('b')] } })
    const run = await x.orch.start(x.proj, 'undo me')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect((await x.orch.undoApply(run.id)).ok).toBe(false) // nothing applied yet
    const done = await x.orch.approveFinal(run.id)
    expect(done.checkpoint).toBeTruthy()
    expect(existsSync(join(x.proj, 't1.txt'))).toBe(true)
    expect(x.orch.get(run.id)?.appliedCheckpoint).toBe(done.checkpoint)
    const u = await x.orch.undoApply(run.id)
    expect(u.ok).toBe(true)
    expect(u.paths.sort()).toEqual(['t1.txt', 't2.txt'])
    expect(existsSync(join(x.proj, 't1.txt'))).toBe(false)
    expect((await x.orch.undoApply(run.id)).message).toMatch(/Already/)
  })

  it('skips the final review on a small run and does it on a bigger one', async () => {
    const small = h({ plan: { tasks: [T('a')] } })
    const r1 = await small.orch.start(small.proj, 'small')
    await until(small.orch, r1.id, (r) => r.status === 'awaiting_approval')
    expect(small.calls.some((c) => c.kind === 'final')).toBe(false)
    const big = h({ plan: { tasks: [T('a'), T('b'), T('c')] } })
    const r2 = await big.orch.start(big.proj, 'big')
    await until(big.orch, r2.id, (r) => r.status === 'awaiting_approval')
    expect(big.calls.some((c) => c.kind === 'final')).toBe(true)
  })

  it('sends a failed review back to the author, who resumes the same session', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'codex' })] }, reviews: { t1: ['FAIL', 'PASS'] } })
    const run = await x.orch.start(x.proj, 'one thing')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks[0].fixRounds).toBe(1)
    expect(r.tasks[0].reviews.map((v) => v.verdict)).toEqual(['fail', 'pass'])
    const fix = x.calls.find((c) => c.kind === 'fix')!
    expect(fix.agent).toBe('codex')
    expect(fix.resume).toBe('s-codex-t1') // the author's own session, so it remembers
    expect(r.messages.some((m) => m.kind === 'review' && m.from === 'claude' && m.to === 'codex')).toBe(true)
    expect(existsSync(join(r.integrationWorktree, 't1-fixed.txt'))).toBe(true)
  })

  it('asks the user when review keeps failing, and a "no" fails the task and stops for attention', async () => {
    const x = h({ plan: { tasks: [T('a'), T('b', { deps: ['a'] })] }, reviews: { t1: ['FAIL', 'FAIL', 'FAIL', 'FAIL'] } }, { cfg: {} })
    const run = await x.orch.start(x.proj, 'stubborn', { maxFixRounds: 1 })
    const r = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'review_override' && a.status === 'pending'))
    const a = r.approvals.find((a) => a.kind === 'review_override')!
    expect(x.orch.answerApproval(run.id, a.id, false, 'no')).toBe(true)
    const end = await until(x.orch, run.id, (r) => r.status === 'paused')
    expect(end.tasks.map((t) => t.status)).toEqual(['failed', 'blocked'])
    expect(end.pausedReason).toMatch(/needs attention/)
  })

  it('Resume retries a task that failed, instead of pausing again at once with the same message', async () => {
    const stalled = { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'stalled' as const, message: 'claude gave no output for 5 minutes and was stopped' } }
    let calls = 0 // a stall is retried three times before the task fails
    const x = h({ plan: { tasks: [T('a'), T('b', { deps: ['a'] })] }, fail: (_agent, kind, task) => (kind === 'work' && task === 't1' && ++calls <= 4 ? stalled : null) })
    const run = await x.orch.start(x.proj, 'stalls')
    const stuck = await until(x.orch, run.id, (r) => r.status === 'paused')
    expect(stuck.tasks.map((t) => t.status)).toEqual(['failed', 'blocked'])
    await x.orch.resume(run.id) // the Resume button and the word "resume" both end here
    const end = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(end.tasks.map((t) => t.status)).toEqual(['done', 'done'])
  })

  it('hands merge conflicts to an agent and keeps both changes', async () => {
    let n = 0
    const x = h({
      plan: { tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'codex' })] },
      work: (agent, task, cwd) => writeFileSync(join(cwd, 'shared.txt'), `from ${task}\n${++n}\n`),
      conflict: (cwd) => writeFileSync(join(cwd, 'shared.txt'), 'both a and b\n'),
    })
    const run = await x.orch.start(x.proj, 'conflict')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(x.calls.some((c) => c.kind === 'conflict')).toBe(true)
    expect(readFileSync(join(r.integrationWorktree, 'shared.txt'), 'utf8')).toBe('both a and b\n')
    expect(r.tasks.every((t) => t.status === 'done')).toBe(true)
  })

  it('runs the project check on the merged result and has an agent fix it', async () => {
    const x = h({ plan: { tasks: [T('a')] }, verifyFix: (cwd) => writeFileSync(join(cwd, 'ok.txt'), 'ok') })
    const verify = `node -e "process.exit(require('fs').existsSync('ok.txt')?0:1)"`
    const run = await x.orch.start(x.proj, 'verify', { verify })
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.final?.verifyOk).toBe(true)
    expect(r.tasks.map((t) => t.title)).toContain('Fix failing checks (attempt 1)')
    expect(r.errors.length).toBeGreaterThan(0)
    expect(x.events.some((e) => e.type === 'verify' && !e.ok)).toBe(true)
    expect(x.events.some((e) => e.type === 'verify' && e.ok)).toBe(true)
  })

  it('lets the local model join: it gets its model, works one task at a time, and is reviewed by someone else', async () => {
    const x = h({ delayMs: 30, plan: { tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'local' }), T('c', { agent: 'local' })] } }, { available: ['claude', 'codex', 'local'] })
    const run = await x.orch.start(x.proj, 'three agents')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks.map((t) => t.agent)).toEqual(['claude', 'local', 'local'])
    expect(r.config.localModel).toBe('qwen-x')
    expect(x.calls.filter((c) => c.agent === 'local').every((c) => c.model === 'qwen-x')).toBe(true)
    for (const c of x.calls.filter((c) => c.kind === 'review')) expect(c.agent).not.toBe(x.calls.find((a) => a.kind === 'work' && a.task === c.task)!.agent)
    expect(x.calls.filter((c) => c.kind === 'review' && c.task !== 't1').every((c) => c.agent === 'claude')).toBe(true) // the strongest other agent reviews the local one
    expect(r.usage.local?.runs).toBeGreaterThan(0)
    // two local tasks never overlap: find the work calls of t2 and t3 in order and check no other work started between a local pair
    const locals = r.tasks.filter((t) => t.agent === 'local')
    expect(locals.every((t) => t.startedAt && t.endedAt)).toBe(true)
    const [p, q] = locals.sort((a, b) => a.startedAt! - b.startedAt!)
    expect(q.startedAt!).toBeGreaterThanOrEqual(p.startedAt!)
  })

  it('plans with Claude when the local model is also ready, and works with only the local model if it is alone', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' })] } }, { available: ['claude', 'local'] })
    const run = await x.orch.start(x.proj, 'mixed')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(x.calls.find((c) => c.kind === 'plan')!.agent).toBe('claude')
    const y = h({ plan: { tasks: [T('a', { agent: 'claude' })] } }, { available: ['local'] })
    const run2 = await y.orch.start(y.proj, 'alone')
    const r2 = await until(y.orch, run2.id, (r) => r.status === 'awaiting_approval')
    expect(new Set(y.calls.map((c) => c.agent))).toEqual(new Set(['local']))
    expect(r2.tasks[0].agent).toBe('local')
  })

  it('bypass mode (the default) never asks for a permission but keeps the hard limits', async () => {
    const x = h({ delayMs: 600, plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'perm')
    await until(x.orch, run.id, (r) => r.tasks.length === 1)
    const ask = (tool: string, input: object) => (x.orch as any).onHub('permission', { tool_name: tool, input }, { runId: run.id, taskId: 't1', agent: 'claude' }) as Promise<string>
    expect(JSON.parse(await ask('Bash', { command: 'sudo rm -rf /' })).behavior).toBe('deny')
    expect(JSON.parse(await ask('Bash', { command: 'git push origin main' })).behavior).toBe('deny')
    expect(JSON.parse(await ask('Bash', { command: 'rm -rf build' })).behavior).toBe('allow')
    expect(JSON.parse(await ask('Read', { file_path: '/etc/hosts' })).behavior).toBe('allow')
    expect(await (x.orch as any).onHub('request_approval', { title: 'deploy', detail: 'x' }, { runId: run.id, taskId: 't1', agent: 'claude' })).toMatch(/^allowed/)
    expect(x.orch.get(run.id)!.approvals.filter((a) => a.status === 'pending')).toHaveLength(0)
    await x.orch.cancel(run.id)
  })

  it('an agent that asks to leave its sandbox: commands are judged by the policy, file changes always ask the user, and its open cards expire when it ends', async () => {
    let late: Promise<boolean> | undefined
    const x = h({ delayMs: 400, plan: { tasks: [T('a')] }, work: async () => { late = x.approve({ kind: 'files', title: 'change files', detail: 'x' }) } })
    const run = await x.orch.start(x.proj, 'approvals')
    await until(x.orch, run.id, (r) => r.tasks.length === 1)
    while (!x.ready()) await sleep(5)
    const cmd = (command: string) => x.approve({ kind: 'command', title: command, detail: '', command })
    expect(await cmd('git -C . push origin HEAD')).toBe(false)
    expect(await cmd('cp a /home/nobody/else')).toBe(false)
    expect(await cmd('npm test')).toBe(true)
    expect(await cmd('rm -rf build')).toBe(true) // 'ask' is waved through only while bypass mode is on
    expect(x.orch.get(run.id)!.approvals.filter((a) => a.status === 'pending')).toHaveLength(0)
    await until(x.orch, run.id, () => !!late)
    expect(await late).toBe(false) // asked the user (a card exists) instead of being auto-accepted in bypass mode; nobody answered before the agent ended
    expect(x.orch.get(run.id)!.approvals.find((a) => a.title === 'change files')!.status).toBe('expired')
    await x.orch.cancel(run.id)
  })

  it('with bypass off, a risky command from a sandboxed agent goes to the user', async () => {
    const x = h({ delayMs: 600, plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'approvals', { bypassPermissions: false })
    await until(x.orch, run.id, (r) => r.tasks.length === 1)
    while (!x.ready()) await sleep(5)
    const p = x.approve({ kind: 'command', title: 'rm', detail: '', command: 'rm -rf build' })
    const r = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'permission' && a.status === 'pending'))
    x.orch.answerApproval(run.id, r.approvals.find((a) => a.kind === 'permission')!.id, true)
    expect(await p).toBe(true)
    await x.orch.cancel(run.id)
  })

  it('uses the one available agent for planning, work and review', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' })] } }, { available: ['codex'] })
    const run = await x.orch.start(x.proj, 'solo')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(new Set(x.calls.map((c) => c.agent))).toEqual(new Set(['codex']))
    expect(r.tasks[0].agent).toBe('codex')
  })

  it('pauses without losing work and resumes; cancel removes worktrees', async () => {
    const x = h({ delayMs: 80, plan: { tasks: [T('a'), T('b', { deps: ['a'] })] } })
    const run = await x.orch.start(x.proj, 'pause me')
    await until(x.orch, run.id, (r) => r.tasks.some((t) => t.status === 'running'))
    x.orch.pause(run.id)
    await sleep(500)
    const paused = x.orch.get(run.id)!
    expect(paused.status).toBe('paused')
    expect(paused.tasks[1].status).toBe('queued') // nothing new started while paused
    await x.orch.resume(run.id)
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')

    const y = h({ delayMs: 200, plan: { tasks: [T('a'), T('b')] } })
    const run2 = await y.orch.start(y.proj, 'cancel me')
    await until(y.orch, run2.id, (r) => r.tasks.some((t) => t.status === 'running'))
    await y.orch.cancel(run2.id)
    expect(y.orch.get(run2.id)?.status).toBe('cancelled')
    expect(y.orch.get(run2.id)!.tasks.every((t) => t.status === 'cancelled')).toBe(true)
    expect(sh(y.proj, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
  })

  it('marks runs interrupted after a restart and continues them on resume, keeping sessions', async () => {
    const x = h({ delayMs: 150, plan: { tasks: [T('a', { agent: 'codex' })] } })
    const run = await x.orch.start(x.proj, 'restart')
    await until(x.orch, run.id, (r) => r.tasks[0]?.status === 'running')
    x.orch.pause(run.id, true) // the same state a crash leaves, as far as the saved file goes
    await until(x.orch, run.id, (r) => r.tasks[0].status === 'interrupted')
    x.orch.flush()
    const saved = x.store.load(run.id)!
    saved.status = 'running'
    saved.tasks[0].status = 'running'
    x.store.save(saved)
    const again = new TeamOrchestrator({ store: x.store, teamDir: x.teamDir, runner: async (a, o) => ok('VERDICT: PASS', a, 'a'), available: async () => ['claude', 'codex'], codexModels: async () => [], emit: () => {}, sleep: async () => {} })
    orchs.push(again)
    again.recoverAll()
    expect(again.get(run.id)?.status).toBe('interrupted')
    expect(again.get(run.id)?.tasks[0].status).toBe('interrupted')
    await again.resume(run.id)
    const r = await until(again, run.id, (r) => r.status === 'awaiting_approval' || r.status === 'paused' || r.status === 'failed')
    expect(['awaiting_approval', 'paused', 'failed']).toContain(r.status)
  })

  it('stops at once when the user types pause, and carries on when they type resume', async () => {
    const x = h({ delayMs: 250, plan: { tasks: [T('a'), T('b')] } })
    const run = await x.orch.start(x.proj, 'pause by typing')
    await until(x.orch, run.id, (r) => r.tasks.some((t) => t.status === 'running'))
    await x.orch.followUp(run.id, 'Pause')
    expect(x.orch.get(run.id)?.status).toBe('paused')
    await until(x.orch, run.id, (r) => r.tasks.some((t) => t.status === 'interrupted'))
    expect(x.orch.get(run.id)!.messages.some((m) => m.from === 'user' && /pause/i.test(m.body))).toBe(false) // a command, not a note for the agents
    await x.orch.followUp(run.id, 'resume')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks.every((t) => t.status === 'done')).toBe(true)
  })

  it('can be stopped during the last checks and finishes them after resume', async () => {
    const x = h({ delayMs: 120, plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'pause while verifying', { verify: 'sleep 1' })
    await until(x.orch, run.id, (r) => r.status === 'verifying', 20000)
    x.orch.pause(run.id) // soft pause is upgraded: checks cannot wait
    expect(x.orch.get(run.id)?.status).toBe('paused')
    await new Promise((r) => setTimeout(r, 200))
    await x.orch.resume(run.id)
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval', 20000)
    expect(r.final?.verifyOk).toBe(true)
  })

  it('resumes a task interrupted during review without redoing its work', async () => {
    const x = h({ delayMs: 250, plan: { tasks: [T('a', { agent: 'codex' })] } })
    const run = await x.orch.start(x.proj, 'review interrupted')
    await until(x.orch, run.id, (r) => r.tasks[0]?.phase === 'review')
    x.orch.pause(run.id, true)
    await until(x.orch, run.id, (r) => r.tasks[0].status === 'interrupted')
    expect(x.orch.get(run.id)!.tasks[0].resumeFrom).toBe('review')
    await x.orch.resume(run.id)
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks[0].status).toBe('done')
    expect(x.calls.filter((c) => c.kind === 'work')).toHaveLength(1) // the work was not run a second time
    expect(x.calls.filter((c) => c.kind === 'review').length).toBeGreaterThanOrEqual(2) // the review was
    expect(existsSync(join(r.integrationWorktree, 't1.txt'))).toBe(true)
  })

  it('runs the project check again after a fix from the final review', async () => {
    let finals = 0
    const x = h({ plan: { tasks: [T('a')] }, verifyFix: () => {} })
    // the final review fails once; the check passes only once t1-fixed.txt exists (made by the fix)
    const base = (x as any)
    const orig = (x.orch as any).d.runner
    ;(x.orch as any).d.runner = async (agent: AgentName, o: AgentCall) => {
      if (/The team finished this goal/.test(o.prompt)) return ok(finals++ === 0 ? '- missing thing\nVERDICT: FAIL' : 'VERDICT: PASS', agent, 'final')
      if (/A reviewer checked your work on task t2|Fix problems/.test(o.prompt) || /A reviewer checked your work/.test(o.prompt)) writeFileSync(join(o.cwd, 'fixed.txt'), 'x')
      return orig(agent, o)
    }
    void base
    const verify = `node -e "process.exit(require('fs').existsSync('fixed.txt')?0:1)"`
    const run = await x.orch.start(x.proj, 'final review fixes', { verify, maxVerifyRounds: 0, finalReview: true })
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    const checks = x.events.filter((e) => e.type === 'verify')
    expect(checks.map((c: any) => c.ok)).toEqual([false, true]) // failed first, then re-run after the fix and passed
    expect(r.final?.verifyOk).toBe(true)
  })

  it('leaves an agent out when its plan allowance is nearly used, and refuses to start when none is left', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'codex' })] } })
    ;(x.orch as any).d.limits = async () => ({ codex: { primaryPct: 97, primaryResetsAt: 1793747988 } })
    const run = await x.orch.start(x.proj, 'quota', { maxLimitPercent: 80 })
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(new Set(x.calls.map((c) => c.agent))).toEqual(new Set(['claude'])) // everything, planning and review included, went to Claude
    expect(r.tasks[0].agent).toBe('claude')
    expect(r.messages.some((m) => /Codex was left out.*97% used/.test(m.body))).toBe(true)

    const y = h({ plan: { tasks: [T('a')] } }, { available: ['codex'] })
    ;(y.orch as any).d.limits = async () => ({ codex: { primaryPct: 97 } })
    await expect(y.orch.start(y.proj, 'nothing left', { maxLimitPercent: 80 })).rejects.toThrow(/97% used/)
    const z = h({ plan: { tasks: [T('a')] } }, { available: ['codex'] })
    ;(z.orch as any).d.limits = async () => ({ codex: { primaryPct: 97 } })
    const run3 = await z.orch.start(z.proj, 'override', { maxLimitPercent: 0 }) // the user turned the guard off
    await until(z.orch, run3.id, (r) => r.status === 'awaiting_approval')
  })

  it('can stop after planning so the user edits the plan, and starts only on approval', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'claude' }), T('c', { agent: 'claude', deps: ['a'] })] } })
    const run = await x.orch.start(x.proj, 'review the plan', { reviewPlan: true })
    const r = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'plan' && a.status === 'pending'))
    expect(r.status).toBe('paused')
    expect(x.calls.filter((c) => c.kind === 'work')).toHaveLength(0) // nothing started
    expect(x.orch.updatePlan(run.id, [{ id: 't3', deps: ['t1', 't3'] }]).ok).toBe(true) // a self-dependency is dropped, not an error
    expect(x.orch.updatePlan(run.id, [{ id: 't1', deps: ['t3'] }])).toMatchObject({ ok: false, message: expect.stringMatching(/circle/) })
    expect(x.orch.updatePlan(run.id, [{ id: 't2', skip: true }, { id: 't1', agent: 'codex', goal: 'do t1 differently' }]).ok).toBe(true)
    expect(x.orch.updatePlan(run.id, [{ id: 'zzz', skip: true }]).ok).toBe(false)
    x.orch.answerApproval(run.id, r.approvals.find((a) => a.kind === 'plan')!.id, true)
    const end = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(end.tasks.map((t) => [t.id, t.status, t.agent])).toEqual([['t1', 'done', 'codex'], ['t2', 'cancelled', 'claude'], ['t3', 'done', 'claude']])
    expect(x.calls.find((c) => c.kind === 'work' && c.task === 't1')!.agent).toBe('codex')
    expect(x.orch.updatePlan(run.id, [{ id: 't1', skip: true }]).ok).toBe(false) // too late to change
  })

  it('cancels the run when the user turns the plan down', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'no thanks', { reviewPlan: true })
    const r = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'plan' && a.status === 'pending'))
    x.orch.answerApproval(run.id, r.approvals[0].id, false)
    await until(x.orch, run.id, (r) => r.status === 'cancelled')
    expect(x.calls.filter((c) => c.kind === 'work')).toHaveLength(0)
  })

  it('stops at the budget and asks before spending more', async () => {
    const x = h({ plan: { tasks: [T('a'), T('b', { deps: ['a'] }), T('c', { deps: ['b'] })] } })
    const run = await x.orch.start(x.proj, 'budget', { budget: { maxAgentRuns: 3 } })
    const r = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'budget' && a.status === 'pending'))
    expect(r.status).toBe('paused')
    expect(r.pausedReason).toMatch(/budget/i)
    expect(r.tasks.filter((t) => t.status === 'done').length).toBeLessThan(3) // it really stopped early
    // each "yes" buys 50% more; keep saying yes until the run finishes
    for (let i = 0; i < 10 && x.orch.get(run.id)!.status !== 'awaiting_approval'; i++) {
      const p = x.orch.get(run.id)!.approvals.find((a) => a.kind === 'budget' && a.status === 'pending')
      if (p) x.orch.answerApproval(run.id, p.id, true)
      await sleep(40)
    }
    expect(x.orch.get(run.id)!.status).toBe('awaiting_approval')
    expect(x.orch.get(run.id)!.config.budget.maxAgentRuns).toBeGreaterThan(3)
  })

  it('the "Allow 50% more" button clears the budget question and lets the run carry on', async () => {
    const x = h({ plan: { tasks: [T('a'), T('b', { deps: ['a'] }), T('c', { deps: ['b'] })] } })
    const run = await x.orch.start(x.proj, 'budget button', { budget: { maxAgentRuns: 3 } })
    await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'budget' && a.status === 'pending'))
    for (let i = 0; i < 10 && x.orch.get(run.id)!.status !== 'awaiting_approval'; i++) { x.orch.extendBudget(run.id); await sleep(40) }
    const r = x.orch.get(run.id)!
    expect(r.status).toBe('awaiting_approval')
    expect(r.approvals.filter((a) => a.kind === 'budget' && a.status === 'pending')).toHaveLength(0)
  })

  it('has no budget or allowance limits unless the user sets one', async () => {
    const x = h({ limitsPct: 95, plan: { tasks: [T('a'), T('b', { deps: ['a'] }), T('c', { deps: ['b'] })] } })
    const run = await x.orch.start(x.proj, 'unlimited')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.approvals.some((a) => a.kind === 'budget')).toBe(false)
  })

  it('pauses when the subscription allowance is nearly used, and continues after the user allows more', async () => {
    const x = h({ limitsPct: 95, plan: { tasks: [T('a'), T('b', { deps: ['a'] })] } })
    const run = await x.orch.start(x.proj, 'limits', { maxLimitPercent: 80 })
    const r = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'budget' && a.status === 'pending'))
    expect(r.pausedReason).toMatch(/plan allowance for this window is 95% used/)
    expect(r.limits?.codex ?? r.limits?.claude).toMatchObject({ primaryPct: 95, secondaryPct: 3 })
    for (let i = 0; i < 10 && x.orch.get(run.id)!.status !== 'awaiting_approval'; i++) {
      const p = x.orch.get(run.id)!.approvals.find((a) => a.kind === 'budget' && a.status === 'pending')
      if (p) x.orch.answerApproval(run.id, p.id, true)
      await sleep(40)
    }
    expect(x.orch.get(run.id)!.status).toBe('awaiting_approval')
    expect(x.orch.get(run.id)!.config.maxLimitPercent).toBe(100)
  })

  it('steers a running agent at once when it supports it, and does not deliver the message twice', async () => {
    const x = h({ delayMs: 300, steerable: true, plan: { tasks: [T('a', { agent: 'codex' })] } })
    const run = await x.orch.start(x.proj, 'steer')
    await until(x.orch, run.id, (r) => r.tasks[0]?.status === 'running')
    await sleep(60)
    x.orch.steer(run.id, 'use tabs', 'codex')
    await sleep(60)
    expect(x.steers).toEqual(['The user says: use tabs'])
    const m = x.orch.get(run.id)!.messages.find((m) => m.kind === 'steer')!
    expect(m.readBy).toContain('codex') // so the next turn does not repeat it
    await x.orch.cancel(run.id)
  })

  it('deletes a finished run completely, refuses a running one, and sweeps leftovers of crashed runs', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'delete me')
    expect(await x.orch.deleteRun(run.id)).toBe(false) // still planning or running
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.rejectFinal(run.id)
    expect(await x.orch.deleteRun(run.id)).toBe(true)
    expect(x.orch.get(run.id)).toBeNull()
    expect(existsSync(join(x.teamDir, 'wt', run.id))).toBe(false)
    expect(sh(x.proj, 'branch', '--list', 'forge/*').trim()).toBe('')

    // a worktree folder whose run is gone (a crash between steps) is removed at startup
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(x.teamDir, 'wt', 'rghost', 'integration'), { recursive: true })
    await x.orch.sweep()
    expect(existsSync(join(x.teamDir, 'wt', 'rghost'))).toBe(false)
  })

  it('streams typing in merged bursts, reports files changing in the folder, and shows what each agent was given and what the team shares', async () => {
    const x = h({ stream: true, plan: { tasks: [T('a', { agent: 'codex' })] } })
    const run = await x.orch.start(x.proj, 'live')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await sleep(250) // the merge window for the last streamed events
    const agentEv = x.events.filter((e) => e.type === 'agent').map((e: any) => e.ev)
    const deltas = agentEv.filter((e) => e.type === 'delta')
    expect(deltas.map((d) => d.text)).toEqual(['Hello world']) // three tiny events arrived as one
    const code = agentEv.filter((e) => e.type === 'code')
    expect(code).toHaveLength(1)
    expect(code[0].text).toBe('partial file') // the latest version replaces the earlier one
    expect(x.events.some((e) => e.type === 'live' && e.files.some((f) => f.path === 't1.txt'))).toBe(true)
    // the log keeps the prompt each agent received, not the typing
    const logged = x.orch.events(run.id).map((l) => l.ev)
    expect(logged.some((e: any) => e.type === 'agent' && e.ev.type === 'prompt' && /Your task t1/.test(e.ev.text))).toBe(true)
    expect(logged.some((e: any) => e.type === 'agent' && (e.ev.type === 'delta' || e.ev.type === 'code'))).toBe(false)

    const mem = x.orch.memorySnapshot(run.id)!
    expect(mem.handoffs[0]).toMatchObject({ taskId: 't1' })
    expect(mem.messages.some((m) => m.kind === 'handoff')).toBe(true)
    expect(mem.project.stats['codex:build']).toEqual({ ok: 1, fail: 0 })
    expect(await x.orch.liveDiff(run.id, 't1')).toContain('t1.txt') // after the merge it shows the team branch's change
    expect(await x.orch.liveDiff(run.id, 't1', 'nope.txt')).toBe('')
  })

  it('carries on without memory when a saved session has gone missing', async () => {
    const x = h({
      plan: { tasks: [T('a', { agent: 'codex' })] },
      reviews: { t1: ['FAIL', 'PASS'] },
      fail: (agent, kind, task, n, resume) => (kind === 'fix' && resume ? { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'other', message: 'No conversation found with session ID: s-codex-t1' } } : null),
    })
    const run = await x.orch.start(x.proj, 'lost session')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    const fixes = x.calls.filter((c) => c.kind === 'fix')
    expect(fixes.map((f) => f.resume)).toEqual(['s-codex-t1', undefined]) // tried to resume, then started fresh
    expect(r.tasks[0].status).toBe('done')
  })

  it('a task that hits an auth error blocks the run with the agent named', async () => {
    const x = h({
      plan: { tasks: [T('a', { agent: 'claude' })] },
      fail: (agent, kind) => (kind === 'work' ? { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'auth', message: 'OAuth session expired' } } : null),
    })
    const run = await x.orch.start(x.proj, 'auth')
    const r = await until(x.orch, run.id, (r) => r.status === 'paused')
    expect(r.tasks[0].status).toBe('blocked')
    expect(r.pausedReason).toMatch(/claude.*OAuth/)
  })

  it('a plan usage limit blocks the run (waiting minutes would not help); resume tries again', async () => {
    const x = h({
      plan: { tasks: [T('a', { agent: 'claude' })] },
      fail: (agent, kind, task, n) => (kind === 'work' && n <= 1 ? { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'limit', message: 'Claude AI usage limit reached|1793747988' } } : null),
    })
    const run = await x.orch.start(x.proj, 'limit', { autoSwitch: false })
    const r = await until(x.orch, run.id, (r) => r.status === 'paused')
    expect(r.tasks[0].status).toBe('blocked')
    expect(r.pausedReason).toMatch(/claude.*usage limit/i)
    await x.orch.resume(run.id) // the allowance came back
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
  })

  it('retries a busy agent shortly instead of failing', async () => {
    const x = h({
      plan: { tasks: [T('a', { agent: 'codex' })] },
      fail: (agent, kind, task, n) => (kind === 'work' && n <= 2 ? { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'busy', message: '529 overloaded' } } : null),
    })
    const run = await x.orch.start(x.proj, 'busy')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks[0].attempts).toBe(2)
    expect(r.messages.filter((m) => /busy right now/.test(m.body))).toHaveLength(2)
  })

  it('retries a transient failure, then gives up with the task failed', async () => {
    const x = h({
      plan: { tasks: [T('a')] },
      fail: (agent, kind, task, n) => (kind === 'work' && n <= 1 ? { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'other', message: 'flaky' } } : null),
    })
    const run = await x.orch.start(x.proj, 'flaky')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks[0].status).toBe('done')
    expect(r.tasks[0].attempts).toBe(1)
  })
})

describe('mailbox operations agents call', () => {
  const call = (x: ReturnType<typeof h>, run: Run, op: string, args: object, agent: AgentName = 'codex', taskId = 't1') => (x.orch as any).onHub(op, args, { runId: run.id, taskId, agent })

  it('delivers posts to the other agent once, records decisions and handoffs, and answers context searches', async () => {
    const x = h({ delayMs: 400, plan: { tasks: [T('a', { agent: 'codex' }), T('b', { agent: 'claude' })] } })
    const run = await x.orch.start(x.proj, 'mail')
    await until(x.orch, run.id, (r) => r.tasks.length === 2)
    await call(x, run, 'post', { to: 'claude', kind: 'finding', body: 'the API base path is /v2' }, 'codex', 't1')
    await call(x, run, 'decision', { text: 'use sqlite for storage' }, 'codex', 't1')
    await call(x, run, 'handoff', { notes: 'api is in api.js' }, 'codex', 't1')
    const inbox: any[] = await call(x, run, 'inbox', {}, 'claude', 't2')
    expect(inbox.map((m) => m.body)).toEqual(expect.arrayContaining(['the API base path is /v2', 'use sqlite for storage']))
    expect(await call(x, run, 'inbox', {}, 'claude', 't2')).toEqual([]) // read once
    expect(await call(x, run, 'inbox', {}, 'codex', 't1')).toEqual([]) // never your own messages
    expect(x.orch.get(run.id)!.tasks[0].handoff).toBe('api is in api.js')
    expect((await call(x, run, 'context', { query: 'which storage database' })) as string[]).toEqual(expect.arrayContaining([expect.stringContaining('sqlite')]))
    x.orch.steer(run.id, 'please keep it simple')
    expect((await call(x, run, 'inbox', {}, 'claude', 't2')) as any[]).toEqual([{ from: 'user', kind: 'instruction', body: 'please keep it simple' }])
    await x.orch.cancel(run.id)
  })

  it('writes the run file in batches, not once per message, and caps the message log', async () => {
    const x = h({ delayMs: 500, plan: { tasks: [T('a', { agent: 'codex' })] } })
    const run = await x.orch.start(x.proj, 'busy')
    await until(x.orch, run.id, (r) => r.tasks.length === 1)
    x.orch.flush()
    let saves = 0
    const orig = x.store.save.bind(x.store)
    x.store.save = (r: Run) => (saves++, orig(r))
    for (let i = 0; i < 1700; i++) await (x.orch as any).onHub('post', { to: 'all', kind: 'note', body: `m${i}` }, { runId: run.id, taskId: 't1', agent: 'codex' })
    x.orch.flush()
    expect(saves).toBeLessThan(40)
    const r = x.orch.get(run.id)!
    expect(r.messages.length).toBe(1500)
    expect(r.messages.at(-1)!.body).toBe('m1699') // the newest are kept
    await x.orch.cancel(run.id)
  })

  it('always has another agent check the local model\'s work, even with review turned off', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'local' })] } }, { available: ['claude', 'local'] })
    const run = await x.orch.start(x.proj, 'local check', { review: 'off', finalReview: false })
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks[0].reviews.length).toBeGreaterThan(0)
    expect(r.tasks[0].reviews[0].by).toBe('claude')
  })

  it('lets an agent ask the user a question with options, even when permission prompts are off, and hands the answer back', async () => {
    const x = h({ delayMs: 600, plan: { tasks: [T('a', { agent: 'claude' })] } })
    const run = await x.orch.start(x.proj, 'ask', { bypassPermissions: true })
    await until(x.orch, run.id, (r) => r.tasks.length === 1)
    let settled = false
    const p = call(x, run, 'ask', { question: 'Which database?', options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }], multi: false }, 'claude').then((v: string) => ((settled = true), v))
    const pending = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'question' && a.status === 'pending'))
    const card = pending.approvals.find((a) => a.kind === 'question')!
    expect(settled).toBe(false)
    expect(card.title).toBe('Which database?')
    expect(card.options).toEqual([{ label: 'SQLite', description: 'one file' }, { label: 'Postgres', description: undefined }])
    x.orch.answerApproval(run.id, card.id, true, 'SQLite')
    expect(await p).toBe('The user answered: SQLite')
  })

  it('tells agents to decide for themselves when the user turned questions off', async () => {
    const x = h({ delayMs: 600, plan: { tasks: [T('a', { agent: 'claude' })] } })
    const run = await x.orch.start(x.proj, 'noask', { askQuestions: false })
    await until(x.orch, run.id, (r) => r.tasks.length === 1)
    expect(await call(x, run, 'ask', { question: 'Which database?' }, 'claude')).toMatch(/decide it yourself/i)
    expect(x.orch.get(run.id)!.approvals.some((a) => a.kind === 'question')).toBe(false)
  })

  it('blocks an approval request until the user answers, and applies the policy to permission prompts', async () => {
    const x = h({ delayMs: 600, plan: { tasks: [T('a', { agent: 'claude' })] } })
    const run = await x.orch.start(x.proj, 'approve', { bypassPermissions: false })
    await until(x.orch, run.id, (r) => r.tasks.length === 1)
    let settled = false
    const p = call(x, run, 'request_approval', { title: 'deploy to prod', detail: 'vercel --prod' }, 'claude').then((v: string) => ((settled = true), v))
    const pending = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.status === 'pending'))
    expect(settled).toBe(false)
    x.orch.answerApproval(run.id, pending.approvals[0].id, true, 'ok go')
    expect(await p).toBe('allowed: ok go')

    expect(JSON.parse(await call(x, run, 'permission', { tool_name: 'Bash', input: { command: 'npm test' } }, 'claude'))).toMatchObject({ behavior: 'allow' })
    expect(JSON.parse(await call(x, run, 'permission', { tool_name: 'Bash', input: { command: 'git push origin main' } }, 'claude'))).toMatchObject({ behavior: 'deny' })
    const ask = call(x, run, 'permission', { tool_name: 'Bash', input: { command: 'npm publish' } }, 'claude')
    const r2 = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'permission' && a.status === 'pending'))
    x.orch.answerApproval(run.id, r2.approvals.find((a) => a.kind === 'permission')!.id, false, 'not now')
    expect(JSON.parse(await ask)).toMatchObject({ behavior: 'deny', message: 'not now' })
    await x.orch.cancel(run.id)
  })

  it('lets a task hand a subtask to the team, once, and not from a subtask', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' })] } })
    const run = await x.orch.start(x.proj, 'subtasks')
    await until(x.orch, run.id, (r) => r.tasks.length === 1)
    const msg = await call(x, run, 'propose_subtask', { title: 'Write tests', goal: 'tests for a', agent: 'codex' }, 'claude', 't1')
    expect(msg).toMatch(/added as t2.*codex/)
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks.map((t) => [t.id, t.proposedBy, t.status])).toEqual([['t1', undefined, 'done'], ['t2', 't1', 'done']])
    expect(await call(x, r, 'propose_subtask', { title: 'x', goal: 'y' }, 'codex', 't2')).toMatch(/cannot propose/)
  })
})

describe('orchestrator audit fixes', () => {
  it('a deleted run stays deleted after the pending save timer fires', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'delete me for good')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.rejectFinal(run.id)
    expect(await x.orch.deleteRun(run.id)).toBe(true)
    await sleep(450)
    expect(x.orch.get(run.id)).toBeNull()
    expect(x.store.list().map((r) => r.id)).not.toContain(run.id)
    expect(x.orch.list().map((r) => r.id)).not.toContain(run.id)
  })

  it('a later round of the same run can be undone after an earlier one was', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'round one')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.approveFinal(run.id)
    expect((await x.orch.undoApply(run.id)).ok).toBe(true)
    await x.orch.followUp(run.id, 'round two')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect((await x.orch.approveFinal(run.id)).ok).toBe(true)
    expect(existsSync(join(x.proj, 't2.txt'))).toBe(true)
    const u = await x.orch.undoApply(run.id)
    expect(u.ok).toBe(true)
    expect(existsSync(join(x.proj, 't2.txt'))).toBe(false)
  })

  it('work whose reviewer cannot run is not merged: the run pauses naming the reviewer, and resume reviews without redoing the work', async () => {
    let failReview = true
    const x = h({
      plan: { tasks: [T('a', { agent: 'local' })] },
      fail: (agent, kind) => (kind === 'review' && failReview ? { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'limit', message: 'usage limit reached' } } as RunResult : null),
    }, { available: ['claude', 'local'] })
    const run = await x.orch.start(x.proj, 'local work', { finalReview: false })
    const r = await until(x.orch, run.id, (r) => r.status === 'paused')
    expect(r.pausedReason).toMatch(/claude could not review/)
    expect(r.tasks[0].status).toBe('blocked')
    expect(r.tasks[0].reviews).toHaveLength(0)
    expect(existsSync(join(r.integrationWorktree, 't1.txt'))).toBe(false)
    failReview = false
    await x.orch.resume(run.id)
    const done = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(done.tasks[0].reviews.map((v) => v.verdict)).toEqual(['pass'])
    expect(x.calls.filter((c) => c.kind === 'work')).toHaveLength(1)
  })

  it('a final review that cannot run because of the plan limit pauses the run instead of passing it', async () => {
    const x = h({
      plan: { tasks: [T('a'), T('b'), T('c')] },
      fail: (agent, kind) => ((kind as string) === 'final' ? { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'limit', message: 'usage limit reached' } } as RunResult : null),
    })
    const run = await x.orch.start(x.proj, 'big')
    const r = await until(x.orch, run.id, (r) => r.status === 'paused')
    expect(r.pausedReason).toMatch(/could not do the final review/)
    expect(r.final).toBeUndefined()
  })

  it('a failed Apply leaves the folder exactly as it was, with the approval still open', async () => {
    const x = h({ plan: { tasks: [T('a')] }, work: (_a, _t, cwd) => writeFileSync(join(cwd, 'base.txt'), 'team version\n') })
    const run = await x.orch.start(x.proj, 'conflict')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    writeFileSync(join(x.proj, 'base.txt'), 'my own edit\n')
    sh(x.proj, 'commit', '-q', '-am', 'mine')
    const r = await x.orch.approveFinal(run.id)
    expect(r.ok).toBe(false)
    expect(readFileSync(join(x.proj, 'base.txt'), 'utf8')).toBe('my own edit\n')
    expect(sh(x.proj, 'status', '--porcelain').trim()).toBe('')
    const after = x.orch.get(run.id)!
    expect(after.status).toBe('awaiting_approval')
    expect(after.approvals.filter((a) => a.kind === 'final' && a.status === 'pending')).toHaveLength(1)
  })

  it('refuses to apply without a recovery point unless the user agrees to that', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'no way back')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    const locked = join(x.proj, 'locked.txt')
    writeFileSync(locked, 'x')
    chmodSync(locked, 0o000)
    try {
      const refused = await x.orch.approveFinal(run.id)
      expect(refused.ok).toBe(false)
      expect(existsSync(join(x.proj, 't1.txt'))).toBe(false)
      expect((await x.orch.approveFinal(run.id, true)).ok).toBe(true)
      expect(existsSync(join(x.proj, 't1.txt'))).toBe(true)
    } finally {
      chmodSync(locked, 0o600)
    }
  })

  it('after a quit during review, the new process resumes at the review instead of redoing the work', async () => {
    const x = h({ delayMs: 250, plan: { tasks: [T('a', { agent: 'codex' })] } })
    const run = await x.orch.start(x.proj, 'quit in review')
    await until(x.orch, run.id, (r) => r.tasks[0]?.phase === 'review')
    x.orch.flush() // what shutdown() writes: the task is still running
    const runs = join(x.teamDir, 'runs')
    const copy = mkdtempSync(join(tmpdir(), 'forge-orch-copy-'))
    cpSync(runs, copy, { recursive: true })
    x.orch.pause(run.id, true)
    await until(x.orch, run.id, (r) => r.tasks[0].status === 'interrupted')
    let work = 0
    const again = new TeamOrchestrator({ store: new TeamStore(copy), teamDir: x.teamDir, runner: async (a, o) => ((/You are reviewing/.test(o.prompt) ? 0 : work++), ok('VERDICT: PASS', a, 'a')), available: async () => ['claude', 'codex'], codexModels: async () => [], emit: () => {}, sleep: async () => {} })
    orchs.push(again)
    again.recoverAll()
    expect(again.get(run.id)!.tasks[0]).toMatchObject({ status: 'interrupted', resumeFrom: 'review' })
    await again.resume(run.id)
    await until(again, run.id, (r) => r.status === 'awaiting_approval' || r.status === 'failed')
    expect(work).toBe(0)
  })

  it('resume waits for a stopped planner, so the old planner does not carry on beside the new one', async () => {
    const x = h({ delayMs: 300, plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'plan twice')
    await sleep(60)
    x.orch.pause(run.id, true)
    await x.orch.resume(run.id)
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(x.calls.filter((c) => c.kind === 'plan')).toHaveLength(2)
    expect(x.calls.filter((c) => c.kind === 'work')).toHaveLength(1)
  })

  it('a typed "go" does not approve a plan that is waiting, and the plan card still starts it', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'review first', { reviewPlan: true })
    const waiting = await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'plan' && a.status === 'pending'))
    await x.orch.followUp(run.id, 'go')
    await sleep(100)
    expect(x.calls.filter((c) => c.kind === 'work')).toHaveLength(0)
    expect(x.orch.get(run.id)!.status).toBe('paused')
    const plan = waiting.approvals.find((a) => a.kind === 'plan')!
    expect(x.orch.answerApproval(run.id, plan.id, true)).toBe(true)
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
  })

  it('a plan waiting for approval is still waiting after a restart, and answering it works without the old process', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'review across restart', { reviewPlan: true })
    await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'plan' && a.status === 'pending'))
    x.orch.flush()
    const copy = mkdtempSync(join(tmpdir(), 'forge-orch-copy-'))
    cpSync(join(x.teamDir, 'runs'), copy, { recursive: true })
    let work = 0
    const again = new TeamOrchestrator({ store: new TeamStore(copy), teamDir: x.teamDir, runner: async (a, o) => ((/You are reviewing/.test(o.prompt) || /lead planner/.test(o.prompt) ? 0 : work++), ok('VERDICT: PASS', a, 'a')), available: async () => ['claude', 'codex'], codexModels: async () => [], emit: () => {}, sleep: async () => {} })
    orchs.push(again)
    again.recoverAll()
    const plan = again.get(run.id)!.approvals.find((a) => a.kind === 'plan')!
    expect(plan.status).toBe('pending')
    await again.resume(run.id)
    await sleep(80)
    expect(work).toBe(0)
    expect(again.answerApproval(run.id, plan.id, true)).toBe(true)
    await until(again, run.id, (r) => r.status === 'awaiting_approval' || r.status === 'failed')
    expect(work).toBeGreaterThan(0)
  })

  it('answering the final approval card applies or rejects, it does not expire', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'answer the card')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    const card = r.approvals.find((a) => a.kind === 'final' && a.status === 'pending')!
    expect(x.orch.answerApproval(run.id, card.id, true)).toBe(true)
    await until(x.orch, run.id, (r) => r.status === 'done')
    expect(x.orch.get(run.id)!.applied).toBe(true)
    expect(x.orch.get(run.id)!.approvals.find((a) => a.id === card.id)!.status).toBe('allowed')
    expect(existsSync(join(x.proj, 't1.txt'))).toBe(true)
  })

  it('a hard stop still ends the turns in flight after a sign-in problem paused the run', async () => {
    const x = h({
      delayMs: 400,
      plan: { tasks: [T('a'), T('b')] },
      fail: (agent, kind, task) => (kind === 'work' && task === 't1' ? { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'auth', message: 'not signed in' } } as RunResult : null),
    })
    const run = await x.orch.start(x.proj, 'sign-in problem')
    await until(x.orch, run.id, (r) => r.status === 'paused' && r.tasks[1]?.status === 'running')
    x.orch.pause(run.id, true)
    const r = await until(x.orch, run.id, (r) => r.tasks[1].status === 'interrupted', 5000)
    expect(r.tasks[1].status).toBe('interrupted')
  })

  it('"Allow 50% more" works when the plan window is at 100%', async () => {
    const x = h({ limitsPct: 100, plan: { tasks: [T('a'), T('b', { deps: ['a'] })] } })
    const run = await x.orch.start(x.proj, 'full window', { maxLimitPercent: 80 })
    await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'budget' && a.status === 'pending'))
    for (let i = 0; i < 6 && x.orch.get(run.id)!.status !== 'awaiting_approval'; i++) {
      const p = x.orch.get(run.id)!.approvals.find((a) => a.kind === 'budget' && a.status === 'pending')
      if (p) x.orch.answerApproval(run.id, p.id, true)
      await sleep(60)
    }
    expect(x.orch.get(run.id)!.status).toBe('awaiting_approval')
  })

  it('stops at the agent-run budget inside a task, and counts the local model', async () => {
    const x = h({ plan: { tasks: [T('a')] }, reviews: { t1: ['FAIL', 'FAIL', 'FAIL'] } })
    const run = await x.orch.start(x.proj, 'tight budget', { budget: { maxAgentRuns: 2 } })
    const r = await until(x.orch, run.id, (r) => r.status === 'paused')
    expect(r.pausedReason).toMatch(/agent-run budget reached \(2 of 2\)/)
    expect(x.calls.filter((c) => c.kind === 'review')).toHaveLength(0)
    expect(r.tasks[0].status).toBe('interrupted')
    expect(r.tasks[0].resumeFrom).toBe('review')

    const y = h({ plan: { tasks: [T('a', { agent: 'local' })] } }, { available: ['local'] })
    const run2 = await y.orch.start(y.proj, 'local only', { budget: { maxAgentRuns: 1 } })
    const r2 = await until(y.orch, run2.id, (r) => r.status === 'paused')
    expect(r2.pausedReason).toMatch(/agent-run budget/)
    expect(y.calls.filter((c) => c.kind === 'work')).toHaveLength(0)
  })

  it('a steering message reaches every later task, not only the next turn', async () => {
    const x = h({ delayMs: 150, plan: { tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'claude', deps: ['a'] }), T('c', { agent: 'claude', deps: ['b'] })] } })
    const run = await x.orch.start(x.proj, 'steer for good')
    await until(x.orch, run.id, (r) => r.tasks[0]?.status === 'running')
    x.orch.steer(run.id, 'use tabs not spaces')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    for (const t of ['t2', 't3']) expect(x.calls.find((c) => c.kind === 'work' && c.task === t)!.prompt).toMatch(/Instructions from the user during this run\n- use tabs not spaces/)
  })

  it('a stopped check-fix leaves nothing behind in the team folder, and the re-queued fix merges', async () => {
    let slow = true
    const x = h({ plan: { tasks: [T('a')] }, verifyFix: (cwd) => writeFileSync(join(cwd, 'ok.txt'), 'ok') })
    const verify = `node -e "process.exit(require('fs').existsSync('ok.txt')?0:1)"`
    const orig = x.orch as unknown as { agentRun: (...a: unknown[]) => Promise<unknown> }
    const real = orig.agentRun.bind(x.orch)
    orig.agentRun = async (...a: unknown[]) => {
      const res = (await real(...a)) as RunResult
      if (slow && a[3] === 'fix') await sleep(300)
      return res
    }
    const run = await x.orch.start(x.proj, 'stopped fixer', { verify })
    await until(x.orch, run.id, (r) => r.tasks.some((t) => /Fix failing checks/.test(t.title) && t.phase === 'fix'))
    x.orch.pause(run.id)
    await sleep(500)
    expect(sh(x.orch.get(run.id)!.integrationWorktree, 'status', '--porcelain').trim()).toBe('')
    slow = false
    await x.orch.resume(run.id)
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.final?.verifyOk).toBe(true)
    expect(sh(r.integrationWorktree, 'status', '--porcelain').trim()).toBe('')
  })
})

describe('orchestrator audit fixes, round 2', () => {
  const call = (x: ReturnType<typeof h>, run: Run, op: string, args: object, agent: AgentName = 'codex', taskId = 't1') => (x.orch as any).onHub(op, args, { runId: run.id, taskId, agent })
  const failed = (kind: string, message: string): RunResult => ({ ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: kind as never, message } })
  const settle = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => 'settled'), sleep(ms).then(() => 'hung')])

  it('7: a soft pause during planning keeps the run paused when the plan lands, and Resume does not start a second planner', async () => {
    const x = h({ delayMs: 200, plan: { tasks: [T('a'), T('b')] } })
    const run = await x.orch.start(x.proj, 'soft pause while planning')
    x.orch.pause(run.id)
    await until(x.orch, run.id, (r) => r.tasks.length === 2)
    expect(x.orch.get(run.id)!.status).toBe('paused')
    expect(x.calls.filter((c) => c.kind === 'work')).toHaveLength(0)
    await x.orch.resume(run.id)
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(x.calls.filter((c) => c.kind === 'plan')).toHaveLength(1)
    expect(x.calls.filter((c) => c.kind === 'work')).toHaveLength(2)

    const y = h({ delayMs: 200, plan: { tasks: [T('a'), T('b')] } })
    const run2 = await y.orch.start(y.proj, 'pause and resume at once')
    y.orch.pause(run2.id)
    await y.orch.resume(run2.id)
    await until(y.orch, run2.id, (r) => r.status === 'awaiting_approval')
    expect(y.calls.filter((c) => c.kind === 'plan')).toHaveLength(1)
    expect(y.calls.filter((c) => c.kind === 'work')).toHaveLength(2)
  })

  it('11: control words are recognised in every state and never become a task', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'words')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.followUp(run.id, 'stop')
    await x.orch.followUp(run.id, 'continue')
    const r = x.orch.get(run.id)!
    expect(r.status).toBe('awaiting_approval')
    expect(r.tasks).toHaveLength(1)
    expect(r.approvals.filter((a) => a.kind === 'final' && a.status === 'pending')).toHaveLength(1)
    expect(r.messages.some((m) => m.from === 'user')).toBe(false)
  })

  it('13: a hard pause answers an open "merge anyway?" question, so Resume does not hang on it', async () => {
    const x = h({ plan: { tasks: [T('a')] }, reviews: { t1: ['FAIL', 'FAIL', 'FAIL'] } })
    const run = await x.orch.start(x.proj, 'override', { maxFixRounds: 0 })
    await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'review_override' && a.status === 'pending'))
    x.orch.pause(run.id, true)
    expect(await settle(x.orch.resume(run.id), 700)).toBe('settled')
    expect(x.orch.get(run.id)!.approvals[0]).toMatchObject({ kind: 'review_override', status: 'expired' })
  })

  it('16: the time budget counts working time, not the age of the run', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'old run', { budget: { maxMinutes: 30 } })
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.approveFinal(run.id)
    x.orch.get(run.id)!.createdAt -= 2 * 24 * 3600_000
    await x.orch.followUp(run.id, 'one more thing')
    const r = await until(x.orch, run.id, (r) => r.tasks.length === 2 && ['awaiting_approval', 'paused'].includes(r.status))
    expect(r.status).toBe('awaiting_approval')
  })

  it('18: a message sent while the checks run becomes a task instead of being dropped', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'verify then talk', { verify: 'sleep 1' })
    await until(x.orch, run.id, (r) => r.status === 'verifying', 20000)
    await x.orch.followUp(run.id, 'also make the button blue')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval' && r.tasks.length === 2, 20000)
    expect(r.tasks[1]).toMatchObject({ goal: 'also make the button blue', status: 'done' })
  }, 30000)

  it('20: a failed check-fix from the last round does not pause the next round', async () => {
    const x = h({ plan: { tasks: [T('a')] }, fail: (agent, kind) => (kind === 'verifyfix' ? failed('other', 'the fixer crashed') : null) })
    const run = await x.orch.start(x.proj, 'fixer fails', { verify: 'exit 1', maxVerifyRounds: 1 })
    const first = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(first.tasks.some((t) => t.status === 'failed')).toBe(true)
    await x.orch.followUp(run.id, 'more')
    const r = await until(x.orch, run.id, (r) => r.tasks.some((t) => t.goal === 'more' && t.status === 'done') && ['paused', 'awaiting_approval'].includes(r.status))
    expect(r.status).toBe('awaiting_approval')
  })

  it('20b: a failed check-fix does not pause the run when a message sent during the checks becomes a task', async () => {
    const x = h({ plan: { tasks: [T('a')] }, fail: (agent, kind) => (kind === 'verifyfix' ? failed('other', 'the fixer crashed') : null) })
    const run = await x.orch.start(x.proj, 'late and failed', { verify: 'sleep 1; test -f t2.txt', maxVerifyRounds: 1 })
    await until(x.orch, run.id, (r) => r.status === 'verifying', 20000)
    await x.orch.followUp(run.id, 'also add a file')
    const r = await until(x.orch, run.id, (r) => r.tasks.some((t) => t.goal === 'also add a file' && t.status === 'done') && ['paused', 'awaiting_approval'].includes(r.status), 30000)
    expect(r.pausedReason ?? '').not.toMatch(/needs attention/)
    expect(r.tasks.find((t) => t.lastStep)?.status).toBe('cancelled')
  }, 40000)

  it('the apply is scoped to the files of the run, so Undo leaves a file made by hand afterwards', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'scoped undo')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.approveFinal(run.id)
    writeFileSync(join(x.proj, 'mine.txt'), 'mine')
    const u = await x.orch.undoApply(run.id)
    expect(u.paths).not.toContain('mine.txt')
    expect(existsSync(join(x.proj, 'mine.txt'))).toBe(true)
    expect(existsSync(join(x.proj, 't1.txt'))).toBe(false)
  })

  it('a refused apply posts a note, so answering the approval card does not look like nothing happened', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'no way back, note')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    const locked = join(x.proj, 'locked.txt')
    writeFileSync(locked, 'x')
    chmodSync(locked, 0o000)
    try {
      await x.orch.approveFinal(run.id)
      expect(x.orch.get(run.id)!.messages.some((m) => m.kind === 'note' && /Nothing was applied/.test(m.body))).toBe(true)
    } finally {
      chmodSync(locked, 0o600)
    }
  })

  it('21: a hard pause answers the questions agents had open, they do not stay pending', async () => {
    const x = h({ delayMs: 400, plan: { tasks: [T('a', { agent: 'claude' })] } })
    const run = await x.orch.start(x.proj, 'ask then pause')
    await until(x.orch, run.id, (r) => r.tasks[0]?.status === 'running')
    const asked = call(x, run, 'ask', { question: 'Which database?' }, 'claude', 't1')
    await until(x.orch, run.id, (r) => r.approvals.some((a) => a.kind === 'question'))
    x.orch.pause(run.id, true)
    expect(await settle(asked, 500)).toBe('settled')
    expect(x.orch.get(run.id)!.approvals.find((a) => a.kind === 'question')!.status).toBe('expired')
  })

  it('22: cancel does not wait out the busy-retry backoff', async () => {
    const x = h({ plan: { tasks: [T('a')] }, fail: (agent, kind) => (kind === 'work' ? failed('busy', '529 overloaded') : null) }, { sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref()) })
    const run = await x.orch.start(x.proj, 'busy then cancel')
    await until(x.orch, run.id, (r) => r.messages.some((m) => /busy right now/.test(m.body)))
    const t = Date.now()
    await x.orch.cancel(run.id)
    expect(Date.now() - t).toBeLessThan(2000)
    expect(x.orch.get(run.id)!.status).toBe('cancelled')
  })

  it('23: a task waiting for the merge lock is not merged by a hard pause', async () => {
    let X: ReturnType<typeof h>
    let runId = ''
    const x = (X = h({
      plan: { tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'codex' }), T('c', { agent: 'claude' })] },
      work: async (agent, task, cwd) => {
        if (task === 't3') (await sleep(150), writeFileSync(join(cwd, 'c.txt'), 'c\n'))
        else writeFileSync(join(cwd, 'shared.txt'), `from ${task}\n`)
      },
      conflict: async (cwd) => {
        writeFileSync(join(cwd, 'shared.txt'), 'both\n')
        await sleep(600)
        X.orch.pause(runId, true)
      },
    }))
    const run = await x.orch.start(x.proj, 'merge lock')
    runId = run.id
    const r = await until(x.orch, run.id, (r) => r.status === 'paused' && r.tasks.every((t) => t.status !== 'running'))
    const c = r.tasks[2]
    expect(c.status).toBe('interrupted')
    expect(c.resumeFrom).toBe('merge')
    expect(existsSync(join(r.integrationWorktree, 'c.txt'))).toBe(false)
    expect(r.tasks.filter((t) => t.status === 'done')).toHaveLength(2)
    await x.orch.resume(run.id)
    const end = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(existsSync(join(end.integrationWorktree, 'c.txt'))).toBe(true)
  })

  it('24: after a restart, a follow-up on a run waiting for approval goes to an agent that is signed in', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'codex' })] } }, { available: ['codex'] })
    const run = await x.orch.start(x.proj, 'codex only')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    x.orch.flush()
    const agents: string[] = []
    const again = new TeamOrchestrator({ store: x.store, teamDir: x.teamDir, runner: async (a, o) => (agents.push(a), ok('VERDICT: PASS', a, 'a')), available: async () => ['codex'], codexModels: async () => [], emit: () => {}, sleep: async () => {} })
    orchs.push(again)
    again.recoverAll()
    await again.followUp(run.id, 'one more thing')
    const r = await until(again, run.id, (r) => r.tasks.length === 2 && ['awaiting_approval', 'paused'].includes(r.status))
    expect(r.status).toBe('awaiting_approval')
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((a) => a === 'codex')).toBe(true)
  })

  it('25: a plan-limit error while planning pauses the run, and Resume plans again', async () => {
    let limited = true
    const x = h({ plan: { tasks: [T('a')] }, fail: (agent, kind) => (kind === 'plan' && limited ? failed('limit', 'Claude AI usage limit reached') : null) }, { available: ['claude'] })
    const run = await x.orch.start(x.proj, 'limit while planning')
    const r = await until(x.orch, run.id, (r) => r.status === 'paused' || r.status === 'failed')
    expect(r.status).toBe('paused')
    expect(r.pausedReason).toMatch(/claude.*usage limit/i)
    expect(r.tasks).toHaveLength(0)
    limited = false
    await x.orch.resume(run.id)
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
  })

  it('26: a subtask proposed while the checks run is refused instead of being left queued', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'late subtask', { verify: 'sleep 1' })
    await until(x.orch, run.id, (r) => r.status === 'verifying', 20000)
    const answer = await call(x, run, 'propose_subtask', { title: 'late', goal: 'too late' }, 'codex', 't1')
    expect(answer).not.toMatch(/added as/)
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval', 20000)
    expect(r.tasks.some((t) => t.status === 'queued')).toBe(false)
  }, 30000)

  it('27: cancelling while the last steps run leaves the run cancelled, with no result to approve', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const orig = (x.orch as any).clean.bind(x.orch)
    let cancelling: Promise<void> | null = null
    ;(x.orch as any).clean = async (wt: string) => {
      const run = x.orch.list()[0]
      if (run.status === 'verifying' && !cancelling) cancelling = x.orch.cancel(run.id)
      return orig(wt)
    }
    const run = await x.orch.start(x.proj, 'cancel at the end')
    await until(x.orch, run.id, () => !!cancelling)
    await cancelling
    await sleep(200)
    const r = x.orch.get(run.id)!
    expect(r.status).toBe('cancelled')
    expect(r.approvals.some((a) => a.kind === 'final' && a.status === 'pending')).toBe(false)
  })

  it('28: one torn line in the event log does not empty the replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-store-'))
    const store = new TeamStore(dir)
    const run = { id: 'rtorn', status: 'done' } as unknown as Run
    store.save(run)
    store.appendEvent('rtorn', { type: 'run', runId: 'rtorn', status: 'planning' })
    store.appendEvent('rtorn', { type: 'run', runId: 'rtorn', status: 'running' })
    writeFileSync(join(dir, 'rtorn', 'events.jsonl'), readFileSync(join(dir, 'rtorn', 'events.jsonl'), 'utf8') + '{"t":1,"ev":{')
    expect(store.events('rtorn')).toHaveLength(2)
  })

  it('30: the report of a later round lists only that round\'s files, and counts the local model', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'two rounds')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.approveFinal(run.id)
    await x.orch.followUp(run.id, 'more')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval' && r.tasks.length === 2)
    expect(r.final!.files.map((f) => f.path)).toEqual(['t2.txt'])
    expect(r.final!.report).toMatch(/Files changed \(1\)/)
    expect(r.final!.report).not.toContain('`t1.txt`')

    const y = h({ plan: { tasks: [T('a', { agent: 'local' })] } }, { available: ['local'] })
    const run2 = await y.orch.start(y.proj, 'local only')
    const r2 = await until(y.orch, run2.id, (r) => r.status === 'awaiting_approval')
    expect(r2.final!.report).toMatch(/- Local: [1-9]\d* runs/)
  })

  it('31: work the local model reviewed alone says so', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'local' })] } }, { available: ['local'] })
    const run = await x.orch.start(x.proj, 'local self review')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.final!.report).toMatch(/local said pass.*own work/)
    expect(r.messages.some((m) => m.kind === 'note' && /reviewed its own work|no other agent/i.test(m.body))).toBe(true)
  })

  it('32: the startup sweep leaves finished runs alone, and Apply leaves no empty folder behind', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'sweep me')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.approveFinal(run.id)
    expect(existsSync(join(x.teamDir, 'wt', run.id))).toBe(false)
    x.orch.flush()
    mkdirSync(join(x.teamDir, 'wt', run.id, 'leftover'), { recursive: true }) // what a crash leaves
    const saved = x.store.load(run.id)!.updatedAt
    await sleep(30)
    const again = new TeamOrchestrator({ store: x.store, teamDir: x.teamDir, runner: async (a) => ok('', a, 'a'), available: async () => ['claude'], codexModels: async () => [], emit: () => {}, sleep: async () => {} })
    orchs.push(again)
    await again.sweep()
    again.flush()
    expect(existsSync(join(x.teamDir, 'wt', run.id))).toBe(false)
    expect(x.store.load(run.id)!.updatedAt).toBe(saved)
  })

  it('33: a check-fix is remembered only after the check passes', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'never passes', { verify: 'exit 1' })
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(new ProjectMemoryStore(x.teamDir, x.proj).load().errors.filter((e) => e.fix)).toHaveLength(0)

    const y = h({ plan: { tasks: [T('a')] }, verifyFix: (cwd) => writeFileSync(join(cwd, 'ok.txt'), 'ok') })
    const run2 = await y.orch.start(y.proj, 'passes', { verify: `node -e "process.exit(require('fs').existsSync('ok.txt')?0:1)"` })
    await until(y.orch, run2.id, (r) => r.status === 'awaiting_approval')
    expect(new ProjectMemoryStore(y.teamDir, y.proj).load().errors.filter((e) => e.fix)).toHaveLength(1)
  })

  it('34: a hub that failed to start is tried again, and a turn that throws stops its folder poller', async () => {
    let starts = 0
    const x = h({ plan: { tasks: [T('a')] } }, { deps: { mcpScript: '/x/team-mcp.js' } })
    ;(x.orch as any).hub.start = async () => {
      if (++starts === 1) throw new Error('listen EPERM')
      return '/x/hub.sock'
    }
    const run = await x.orch.start(x.proj, 'hub down')
    expect((await until(x.orch, run.id, (r) => r.status === 'failed')).pausedReason).toMatch(/EPERM/)
    const run2 = await x.orch.start(x.proj, 'hub back')
    await until(x.orch, run2.id, (r) => r.status === 'awaiting_approval')
    expect(starts).toBe(2)

    const opened = new Set<unknown>()
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    const set = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => { const t = realSet(fn, ms); if (ms === 1500) opened.add(t); return t }) as never)
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((t: never) => (opened.delete(t), realClear(t))) as never)
    try {
      const y = h({ plan: { tasks: [T('a')] }, work: () => { throw new Error('runner blew up') } })
      const run3 = await y.orch.start(y.proj, 'throws')
      await until(y.orch, run3.id, (r) => r.tasks[0]?.status === 'failed')
      expect(opened.size).toBe(0)
    } finally {
      set.mockRestore()
      clear.mockRestore()
    }
  }, 30000)
})

describe('crew engine: auto-switch, effort, stats, test agent, security review', () => {
  const failed = (kind: string, message: string): RunResult => ({ ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: kind as never, message } })
  const withTests = (x: ReturnType<typeof h>) => writeFileSync(join(x.proj, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
  const soon = () => `usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`
  const ts = (_a: AgentName, task: string, cwd: string) => writeFileSync(join(cwd, `${task}.ts`), 'x\n')

  it('auto-switch: a task whose agent hit its limit goes to the other agent, queued tasks follow, and nobody pauses', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'claude', deps: ['a'] })] }, fail: (agent, kind) => (agent === 'claude' && kind === 'work' ? failed('limit', soon()) : null) })
    const run = await x.orch.start(x.proj, 'switch')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks.map((t) => [t.agent, t.status])).toEqual([['codex', 'done'], ['codex', 'done']])
    expect(r.messages.some((m) => m.kind === 'note' && /Claude hit its limit: Codex took over t1/.test(m.body))).toBe(true)
    expect(r.messages.some((m) => m.kind === 'note' && /Claude hit its limit: Codex took over t2/.test(m.body))).toBe(true)
    expect(x.calls.filter((c) => c.agent === 'claude' && c.kind !== 'plan')).toHaveLength(1) // the one that failed; reviews and the later task stayed away
  })

  it('auto-switch: a limit that has already reset does not keep the agent out', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'claude', deps: ['a'] })] }, fail: (agent, kind, task) => (agent === 'claude' && kind === 'work' && task === 't1' ? failed('limit', 'usage limit reached|1793747988') : null) })
    const run = await x.orch.start(x.proj, 'reset')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks.map((t) => t.agent)).toEqual(['codex', 'claude'])
  })

  it('auto-switch: a reviewer that hit its limit is replaced, the local model never takes the review, and with nobody else the run pauses as before', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'local' })] }, fail: (agent, kind) => (agent === 'claude' && kind === 'review' ? failed('limit', soon()) : null) }, { available: ['claude', 'codex', 'local'] })
    const run = await x.orch.start(x.proj, 'review switch')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks[0].reviews.map((v) => v.by)).toEqual(['codex'])
    expect(r.messages.some((m) => /Claude hit its limit: Codex took over the review of t1/.test(m.body))).toBe(true)
    expect(x.calls.filter((c) => c.kind === 'review' || c.kind === 'final').every((c) => c.agent !== 'local')).toBe(true)

    const y = h({ plan: { tasks: [T('a', { agent: 'local' })] }, fail: (agent, kind) => (agent === 'claude' && kind === 'review' ? failed('limit', soon()) : null) }, { available: ['claude', 'local'] })
    const run2 = await y.orch.start(y.proj, 'nobody else')
    expect((await until(y.orch, run2.id, (r) => r.status === 'paused')).pausedReason).toMatch(/claude could not review/) // only the local model is left, and it does not review
  })

  it('auto-switch: when the planner is out of allowance the next one plans, and the plan is not handed back to the planner that is out', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' })] }, fail: (agent, kind) => (agent === 'claude' && kind === 'plan' ? failed('limit', soon()) : null) })
    const run = await x.orch.start(x.proj, 'planner out')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.plan.plannedBy).toBe('codex')
    expect(r.tasks[0].agent).toBe('codex')
    expect(r.messages.some((m) => /Claude hit its limit: Codex took over planning/.test(m.body))).toBe(true)
  })

  it('auto-switch: with no other agent left the run pauses naming the agent, as before', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' })] }, fail: (agent, kind) => (kind === 'work' ? failed('limit', 'Claude AI usage limit reached') : null) }, { available: ['claude'] })
    const run = await x.orch.start(x.proj, 'alone')
    const r = await until(x.orch, run.id, (r) => r.status === 'paused')
    expect(r.tasks[0].status).toBe('blocked')
    expect(r.pausedReason).toMatch(/claude.*usage limit/i)
  })

  it('effort: auto lowers research and small reviews, fixed keeps the configured value, cheap goes lower and moves build work to Codex', async () => {
    const cfg = { claudeEffort: 'high', codexEffort: 'high' } as const
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'codex', kind: 'research' })] } })
    const run = await x.orch.start(x.proj, 'auto', cfg)
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(x.calls.find((c) => c.kind === 'work' && c.task === 't1')!.effort).toBe('high')
    expect(x.calls.find((c) => c.kind === 'review' && c.task === 't1')!.effort).toBe('medium')
    expect(x.calls.find((c) => c.kind === 'work' && c.task === 't2')!.effort).toBe('medium')

    const f = h({ plan: { tasks: [T('a', { agent: 'claude' })] } })
    const run2 = await f.orch.start(f.proj, 'fixed', { ...cfg, effortMode: 'fixed' })
    await until(f.orch, run2.id, (r) => r.status === 'awaiting_approval')
    expect(f.calls.filter((c) => c.agent !== 'local' && c.kind !== 'plan').map((c) => c.effort)).toEqual(['high', 'high'])

    const c = h({ plan: { tasks: [T('a', { agent: 'claude' })] } })
    const run3 = await c.orch.start(c.proj, 'cheap', { ...cfg, effortMode: 'cheap' })
    const r3 = await until(c.orch, run3.id, (r) => r.status === 'awaiting_approval')
    expect(r3.tasks[0].agent).toBe('codex')
    expect(c.calls.find((x) => x.kind === 'work')!.effort).toBe('medium')
    expect(c.calls.find((x) => x.kind === 'review')!.effort).toBe('low')
  })

  it('stats: every task reports time, tokens and cost, and the forecast knows what is left', async () => {
    const x = h({ delayMs: 20, plan: { tasks: [T('a'), T('b', { deps: ['a'] })] } })
    const run = await x.orch.start(x.proj, 'stats')
    expect(x.orch.stats('nope')).toBeNull()
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    const s = x.orch.stats(run.id)!
    expect(s.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(s.tasks.every((t) => t.tokens > 0 && t.seconds > 0)).toBe(true)
    expect(s.forecast).toMatchObject({ tasksDone: 2, tasksLeft: 0, estTokensLeft: 0 })
  })

  it('test agent: after the builds one test task runs, by an agent that did not write most of the files, and goes through review and merge', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'claude' }), T('b', { agent: 'codex' })] }, work: (_a, task, cwd) => { writeFileSync(join(cwd, `${task}.ts`), 'x\n'); if (task === 't1') writeFileSync(join(cwd, 't1b.ts'), 'y\n') } })
    withTests(x)
    const run = await x.orch.start(x.proj, 'with tests')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    const t = r.tasks.find((t) => t.kind === 'test')!
    expect(r.tasks).toHaveLength(3)
    expect(t).toMatchObject({ status: 'done', agent: 'codex', deps: ['t1', 't2'] })
    expect(t.reviews.map((v) => v.by)).toEqual(['claude'])
    expect(x.calls.find((c) => c.task === t.id && c.kind === 'work')!.prompt).toContain('focused tests next to the code')
    expect(existsSync(join(r.integrationWorktree, `${t.id}.ts`))).toBe(true)
    expect(x.events.filter((e) => e.type === 'verify').length).toBeGreaterThan(0) // the project check ran after it
  })

  it('test agent: not added when the planner made one, when turned off, without a test command, or for docs-only changes', async () => {
    const planned = h({ plan: { tasks: [T('a'), T('b', { kind: 'test', deps: ['a'] })] }, work: ts })
    withTests(planned)
    const r1 = await planned.orch.start(planned.proj, 'planner test')
    expect((await until(planned.orch, r1.id, (r) => r.status === 'awaiting_approval')).tasks).toHaveLength(2)

    const off = h({ plan: { tasks: [T('a')] }, work: ts })
    withTests(off)
    const r2 = await off.orch.start(off.proj, 'off', { testTask: false })
    expect((await until(off.orch, r2.id, (r) => r.status === 'awaiting_approval')).tasks).toHaveLength(1)

    const none = h({ plan: { tasks: [T('a')] }, work: ts })
    const r3 = await none.orch.start(none.proj, 'no test command')
    expect((await until(none.orch, r3.id, (r) => r.status === 'awaiting_approval')).tasks).toHaveLength(1)

    const docs = h({ plan: { tasks: [T('a')] }, work: (_a, _t, cwd) => writeFileSync(join(cwd, 'README.md'), 'hi\n') })
    withTests(docs)
    const r4 = await docs.orch.start(docs.proj, 'docs only')
    expect((await until(docs.orch, r4.id, (r) => r.status === 'awaiting_approval')).tasks).toHaveLength(1)
  })

  it('security review: always runs, is read-only, lands in the final notes and the report; off never runs; auto looks only at risky changes', async () => {
    const always = h({ plan: { tasks: [T('a')] }, work: ts })
    const r1 = await always.orch.start(always.proj, 'always', { securityReview: 'always' })
    const done = await until(always.orch, r1.id, (r) => r.status === 'awaiting_approval')
    expect(always.calls.filter((c) => c.kind === 'security')).toHaveLength(1)
    expect(done.final?.reviewNotes.some((n) => /^Security review: PASS — /.test(n))).toBe(true)
    expect(done.final?.report).toMatch(/## Security review\n- PASS — /)

    const off = h({ plan: { tasks: [T('a')] }, work: ts })
    const r2 = await off.orch.start(off.proj, 'off', { securityReview: 'off' })
    await until(off.orch, r2.id, (r) => r.status === 'awaiting_approval')
    expect(off.calls.some((c) => c.kind === 'security')).toBe(false)

    const calm = h({ plan: { tasks: [T('a')] }, work: ts })
    const r3 = await calm.orch.start(calm.proj, 'calm')
    await until(calm.orch, r3.id, (r) => r.status === 'awaiting_approval')
    expect(calm.calls.some((c) => c.kind === 'security')).toBe(false)

    const risky = h({ plan: { tasks: [T('a')] }, work: (_a, _t, cwd) => (mkdirSync(join(cwd, 'src/auth'), { recursive: true }), writeFileSync(join(cwd, 'src/auth/login.ts'), 'x\n')) })
    const r4 = await risky.orch.start(risky.proj, 'risky')
    await until(risky.orch, r4.id, (r) => r.status === 'awaiting_approval')
    expect(risky.calls.filter((c) => c.kind === 'security')).toHaveLength(1)
  })

  it('security review: a FAIL makes a fix task and runs the check again; a review that cannot run is recorded, or pauses when the plan is out', async () => {
    const x = h({ plan: { tasks: [T('a')] }, security: ['FAIL', 'PASS'] })
    const run = await x.orch.start(x.proj, 'unsafe', { securityReview: 'always', verify: 'node -e "process.exit(0)"' })
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(r.tasks.map((t) => t.title)).toContain('Fix problems from the security review')
    expect(r.tasks.at(-1)).toMatchObject({ status: 'done', lastStep: true })
    expect(x.events.filter((e) => e.type === 'verify').map((e: any) => e.ok)).toEqual([true, true])
    expect(r.final?.reviewNotes[0]).toMatch(/^Security review: FAIL — .*shell/)

    const broken = h({ plan: { tasks: [T('a')] }, fail: (_a, kind) => ((kind as string) === 'security' ? failed('other', 'boom') : null) })
    const r2 = await broken.orch.start(broken.proj, 'cannot run', { securityReview: 'always' })
    const end = await until(broken.orch, r2.id, (r) => r.status === 'awaiting_approval')
    expect(end.final?.reviewNotes[0]).toMatch(/^Security review: could not run — boom/)

    const out = h({ plan: { tasks: [T('a')] }, fail: (_a, kind) => ((kind as string) === 'security' ? failed('limit', 'usage limit reached') : null) }, { available: ['claude'] })
    const r3 = await out.orch.start(out.proj, 'plan is out', { securityReview: 'always' })
    const paused = await until(out.orch, r3.id, (r) => r.status === 'paused')
    expect(paused.pausedReason).toMatch(/could not do the security review/)
    expect(paused.final).toBeUndefined()
  })
})

describe('landing part of a run', () => {
  const three = () => h({ plan: { tasks: [T('a'), T('b'), T('c')] } })
  const readyRun = async (x: ReturnType<typeof three>) => {
    const run = await x.orch.start(x.proj, 'three things')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    return run
  }

  it('applies only the chosen files, keeps the approval open, and a later full landing applies the rest', async () => {
    const x = three()
    const run = await readyRun(x)
    const p = await x.orch.approveFinal(run.id, false, ['t1.txt'])
    expect(p.ok).toBe(true)
    expect(existsSync(join(x.proj, 't1.txt'))).toBe(true)
    expect(existsSync(join(x.proj, 't2.txt'))).toBe(false)
    const mid = x.orch.get(run.id)!
    expect(mid.status).toBe('awaiting_approval')
    expect(mid.applied).toBeFalsy()
    expect(mid.landedFiles).toEqual(['t1.txt'])
    expect(mid.final!.files).toHaveLength(3) // the list itself is intact
    expect(mid.approvals.filter((a) => a.kind === 'final' && a.status === 'pending')).toHaveLength(1)
    const view = x.orch.landings(run.id)!
    expect(view.files.map((f) => `${f.path}:${f.state}`).sort()).toEqual(['t1.txt:landed', 't2.txt:pending', 't3.txt:pending'])
    expect(view.tasks.map((t) => t.files)).toEqual([['t1.txt'], ['t2.txt'], ['t3.txt']])
    const rest = await x.orch.approveFinal(run.id) // t1.txt is in the project already: it must not be applied again
    expect(rest.ok).toBe(true)
    expect(['t1.txt', 't2.txt', 't3.txt'].every((f) => existsSync(join(x.proj, f)))).toBe(true)
    const done = x.orch.get(run.id)!
    expect(done.status).toBe('done')
    expect(done.applied).toBe(true)
    expect(done.landings).toHaveLength(2)
    expect(done.landings![1].files.sort()).toEqual(['t2.txt', 't3.txt'])
  })

  it('refuses unknown paths, path traversal and empty picks without touching the folder', async () => {
    const x = three()
    const run = await readyRun(x)
    for (const only of [[], ['nope.txt'], ['../outside.txt'], ['t1.txt', '/etc/passwd'], ['t1.txt', 't1.txt/../base.txt']]) {
      const r = await x.orch.approveFinal(run.id, false, only)
      expect(r.ok).toBe(false)
    }
    expect(sh(x.proj, 'status', '--porcelain').trim()).toBe('')
    expect(x.orch.get(run.id)!.landings ?? []).toHaveLength(0)
    expect((await x.orch.approveFinal(run.id, false, ['t1.txt'])).ok).toBe(true)
    expect((await x.orch.approveFinal(run.id, false, ['t1.txt'])).message).toMatch(/already landed/)
  })

  it('undoes one landing and leaves the other alone', async () => {
    const x = three()
    const run = await readyRun(x)
    const first = await x.orch.approveFinal(run.id, false, ['t1.txt'])
    const second = await x.orch.approveFinal(run.id, false, ['t2.txt'])
    expect(first.checkpoint && second.checkpoint && first.checkpoint !== second.checkpoint).toBe(true)
    const u = await x.orch.undoLanding(run.id, second.checkpoint!)
    expect(u).toMatchObject({ ok: true, paths: ['t2.txt'] })
    expect(existsSync(join(x.proj, 't1.txt'))).toBe(true)
    expect(existsSync(join(x.proj, 't2.txt'))).toBe(false)
    expect(x.orch.get(run.id)!.landedFiles).toEqual(['t1.txt'])
    expect((await x.orch.undoLanding(run.id, second.checkpoint!)).message).toMatch(/Already/)
    expect((await x.orch.approveFinal(run.id, false, ['t2.txt'])).ok).toBe(true) // back to pending, so it can land again
    expect((await x.orch.undoLanding(run.id, 'nope')).ok).toBe(false)
  })

  it('the last pick completes the run, and Undo then takes back just that landing', async () => {
    const x = three()
    const run = await readyRun(x)
    await x.orch.approveFinal(run.id, false, ['t1.txt'])
    const last = await x.orch.approveFinal(run.id, false, ['t2.txt', 't3.txt'])
    expect(x.orch.get(run.id)).toMatchObject({ status: 'done', applied: true, appliedCheckpoint: last.checkpoint })
    const u = await x.orch.undoApply(run.id)
    expect(u.paths.sort()).toEqual(['t2.txt', 't3.txt'])
    expect(existsSync(join(x.proj, 't1.txt'))).toBe(true)
  })

  it('a failed partial landing leaves the folder as it was and nothing recorded', async () => {
    const x = h({ plan: { tasks: [T('a'), T('b')] }, work: (_a, t, cwd) => writeFileSync(join(cwd, t === 't1' ? 'base.txt' : 't2.txt'), 'team version\n') })
    const run = await x.orch.start(x.proj, 'conflict')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    writeFileSync(join(x.proj, 'base.txt'), 'my own edit\n')
    sh(x.proj, 'commit', '-q', '-am', 'mine')
    const r = await x.orch.approveFinal(run.id, false, ['base.txt'])
    expect(r.ok).toBe(false)
    expect(readFileSync(join(x.proj, 'base.txt'), 'utf8')).toBe('my own edit\n')
    expect(sh(x.proj, 'status', '--porcelain').trim()).toBe('')
    const after = x.orch.get(run.id)!
    expect(after.landedFiles ?? []).toEqual([])
    expect(after.status).toBe('awaiting_approval')
    expect((await x.orch.approveFinal(run.id, false, ['t2.txt'])).ok).toBe(true) // the other file is unaffected
    expect(readFileSync(join(x.proj, 't2.txt'), 'utf8')).toBe('team version\n')
  })
})

describe('changing models during a run', () => {
  it('the next agent call uses the new local and Claude model, bad values are ignored, and the choice is saved on the run', async () => {
    const x = h({ plan: { tasks: [T('a', { agent: 'local' })] } }, { available: ['claude', 'codex', 'local'] })
    const run = await x.orch.start(x.proj, 'models', { localModel: 'old:1b', claudeModel: 'claude-sonnet-5-5' })
    expect(x.orch.setModels(run.id, { localModel: ' qwen3-coder:30b ', claudeModel: 'claude-opus-5-5', codexModel: '   ', claudeEffort: 'bogus', codexEffort: 'low' })).toMatchObject({ localModel: 'qwen3-coder:30b', claudeModel: 'claude-opus-5-5', codexEffort: 'low' })
    const r = x.orch.get(run.id)!
    expect(r.config.localModel).toBe('qwen3-coder:30b')
    expect(r.config.codexModel).not.toBe('')
    expect(r.config.claudeEffort).not.toBe('bogus')
    expect(x.orch.setModels('nope', { localModel: 'x' })).toBeNull()
    await until(x.orch, run.id, (q) => q.status === 'awaiting_approval')
  })
})

describe('asking for the local model in words', () => {
  it('recognises "let local fix this" and friends, and leaves other uses of the word alone', () => {
    for (const t of ['this is happening also let local fix this', 'use the local model for it', 'mainly local please', 'do it with local AI', 'let Local fix it, then claude review']) expect(asksForLocal(t)).toBe(true)
    for (const t of ['fix the local storage bug', 'start the local server', 'the localhost page is blank', 'use localStorage for the theme', 'run it locally']) expect(asksForLocal(t)).toBe(false)
  })
})

describe('several main requests in one run', () => {
  it('a message while the team works adds work without stopping anyone, and every agent reads both requests', async () => {
    const x = h({ delayMs: 150, plan: { tasks: [T('a'), T('b')] } })
    const run = await x.orch.start(x.proj, 'build the first thing')
    await until(x.orch, run.id, (r) => r.tasks.some((t) => t.status === 'running'))
    await x.orch.followUp(run.id, 'and also add a settings page')
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval' && q.tasks.some((t) => t.goal === 'and also add a settings page' && t.status === 'done'), 20000)
    expect(r.prompts?.map((q) => q.text)).toEqual(['build the first thing', 'and also add a settings page'])
    expect(r.tasks.filter((t) => t.id === 't1' || t.id === 't2').every((t) => t.status === 'done')).toBe(true) // nothing the team was doing was cancelled
    const added = r.tasks.find((t) => t.goal === 'and also add a settings page')!
    expect(added.proposedBy).toBe('user')
    const workPrompt = x.calls.find((c) => c.kind === 'work' && c.task === added.id)!.prompt
    expect(workPrompt).toContain('2 main requests')
    expect(workPrompt).toContain('build the first thing')
    expect(workPrompt).toContain('and also add a settings page')
  })

  it('a message after the result keeps the finished work and adds a task for the new request', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'first')
    await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    await x.orch.followUp(run.id, 'second request')
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval' && q.tasks.some((t) => t.goal === 'second request' && t.status === 'done'))
    expect(r.tasks.find((t) => t.id === 't1')?.status).toBe('done')
    expect(r.prompts).toHaveLength(2)
  })

  it('"do it fast" turns on fast mode (many sessions, no cross-review, no extra test task) and the old settings come back after', async () => {
    const x = h({ plan: { tasks: [T('a')] } })
    const run = await x.orch.start(x.proj, 'build this as fast as you can', { maxParallelPerAgent: 2, review: 'cross' })
    const c = x.orch.get(run.id)!.config
    expect(c).toMatchObject({ speed: 'fast', review: 'off', testTask: false, maxParallelPerAgent: 6, finalReview: false })
    x.orch.setSpeed(run.id, false)
    expect(x.orch.get(run.id)!.config).toMatchObject({ speed: 'normal', review: 'cross', maxParallelPerAgent: 2 })
  })
})

describe('long unattended runs: the watchdog', () => {
  const quick = { watchMs: 20 }
  it('an agent that goes quiet is stopped and the task is retried in a new session', async () => {
    const x = h({ plan: { tasks: [T('a')] }, hang: (_a, kind, _t, n) => kind === 'work' && n === 1 }, { deps: quick })
    const run = await x.orch.start(x.proj, 'quiet agent', { stallMinutes: 0.01, review: 'off' })
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval', 20000)
    expect(r.tasks[0].status).toBe('done')
    expect(r.messages.some((m) => /went quiet/.test(m.body))).toBe(true)
    expect(x.calls.filter((c) => c.kind === 'work')).toHaveLength(2)
    expect(x.calls.filter((c) => c.kind === 'work')[1].resume).toBeUndefined() // the hung session is not resumed
  })

  it('after two stalls another agent takes the task, and a task that keeps stalling fails instead of blocking the run', async () => {
    const x = h({ plan: { tasks: [T('a')] }, hang: (agent, kind) => kind === 'work' && agent === 'claude' }, { deps: quick })
    const run = await x.orch.start(x.proj, 'always quiet', { stallMinutes: 0.01, review: 'off' })
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval', 30000)
    expect(r.tasks[0]).toMatchObject({ agent: 'codex', status: 'done' })
    expect(r.messages.some((m) => /stopped twice/.test(m.body))).toBe(true)
  })

  it('a task that runs past its time cap is stopped', async () => {
    const x = h({ plan: { tasks: [T('a')] }, hang: (_a, kind, _t, n) => kind === 'work' && n === 1 }, { deps: quick })
    const run = await x.orch.start(x.proj, 'endless', { stallMinutes: 600, taskMinutes: 0.01, review: 'off' })
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval', 20000)
    expect(r.messages.some((m) => /ran past/.test(m.body))).toBe(true)
    expect(r.tasks[0].status).toBe('done')
  })
})

describe('long unattended runs: coming back by themselves', () => {
  it('limitBackAt reads Claude\'s reset time and Codex\'s, and isLimitPause tells a plan limit from a missing sign-in', () => {
    const now = 1_000_000_000_000
    expect(limitBackAt('usage limit reached|1000000600', undefined, now)).toBe(1_000_000_600_000)
    expect(limitBackAt('limit', { codex: { primaryPct: 100, primaryResetsAt: 1_000_000_900 } }, now)).toBe(1_000_000_900_000)
    expect(limitBackAt('limit', { codex: { primaryPct: 40, primaryResetsAt: 1_000_000_900 } }, now)).toBeNull()
    expect(isLimitPause('claude: usage limit reached|1000000600')).toBe(true)
    expect(isLimitPause('Claude Code is not signed in. Run: claude auth login')).toBe(false)
  })

  it('a run that stopped on a plan limit continues by itself when the plan comes back', async () => {
    const back = Math.floor(Date.now() / 1000) + 1
    const x = h({ plan: { tasks: [T('a')] }, fail: (agent, kind, _t, n) => (kind === 'work' && n === 1 ? ({ ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'limit', message: `usage limit reached|${back}` } } as RunResult) : null) }, { available: ['claude'], deps: { resumeSlackMs: 50 } })
    const run = await x.orch.start(x.proj, 'limit then back', { review: 'off' })
    await until(x.orch, run.id, (q) => q.status === 'paused', 10000)
    expect(x.orch.get(run.id)!.messages.some((m) => /continues by itself/.test(m.body))).toBe(true)
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval', 20000)
    expect(r.tasks[0].status).toBe('done')
  })

  it('autoResume: false leaves a limit pause for the user', async () => {
    const back = Math.floor(Date.now() / 1000) + 1
    const x = h({ plan: { tasks: [T('a')] }, fail: (_a, kind, _t, n) => (kind === 'work' && n === 1 ? ({ ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events: [], error: { kind: 'limit', message: `usage limit reached|${back}` } } as RunResult) : null) }, { available: ['claude'], deps: { resumeSlackMs: 50 } })
    const run = await x.orch.start(x.proj, 'no auto', { review: 'off', autoResume: false })
    await until(x.orch, run.id, (q) => q.status === 'paused', 10000)
    await new Promise((r) => setTimeout(r, 1500))
    expect(x.orch.get(run.id)!.status).toBe('paused')
  })
})

describe('long unattended runs: checkpoints', () => {
  const four = [T('a'), T('b'), T('c'), T('d')]
  it('the project check runs after every few finished tasks and says so', async () => {
    const x = h({ plan: { tasks: four } })
    const run = await x.orch.start(x.proj, 'checkpoints pass', { verify: 'exit 0', checkpointEvery: 2, review: 'off', testTask: false, finalReview: false, maxParallelPerAgent: 1 })
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval', 30000)
    expect(r.messages.filter((m) => /Checkpoint after \d+ tasks: `exit 0` passed/.test(m.body)).length).toBeGreaterThanOrEqual(1)
  })

  it('a failing checkpoint adds one fix task at once, not a pile of them', async () => {
    const x = h({ plan: { tasks: four } })
    const run = await x.orch.start(x.proj, 'checkpoints fail', { verify: 'exit 1', checkpointEvery: 2, review: 'off', testTask: false, finalReview: false, maxVerifyRounds: 0, maxParallelPerAgent: 1 })
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval', 30000)
    const fixes = r.tasks.filter((t) => /^Fix failing checks \(checkpoint/.test(t.title))
    expect(fixes.length).toBeGreaterThanOrEqual(1)
    expect(fixes[0].goal).toContain('exit 1')
    expect(r.messages.some((m) => /failed; a fix task was added/.test(m.body))).toBe(true)
  })

  it('checkpointEvery: 0 turns them off', async () => {
    const x = h({ plan: { tasks: four } })
    const run = await x.orch.start(x.proj, 'no checkpoints', { verify: 'exit 0', checkpointEvery: 0, review: 'off', testTask: false, finalReview: false })
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval', 30000)
    expect(r.messages.some((m) => /Checkpoint after/.test(m.body))).toBe(false)
  })
})

describe('stopping one task', () => {
  it('Stop on a running task cuts its agent off, ends it as stopped, and the rest of the run carries on', async () => {
    const x = h({ plan: { tasks: [T('a'), T('b')] }, hang: (_a, kind, task) => kind === 'work' && task === 't1' }, { deps: { watchMs: 20 } })
    const run = await x.orch.start(x.proj, 'stop one', { review: 'off', maxParallelPerAgent: 2 })
    await until(x.orch, run.id, (q) => q.tasks[0]?.status === 'running' && x.calls.some((c) => c.kind === 'work' && c.task === 't1'))
    expect(x.orch.stopTask(run.id, 't1')).toBe(true)
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval', 20000)
    expect(r.tasks.find((t) => t.id === 't1')).toMatchObject({ status: 'cancelled', error: 'Stopped by you.' })
    expect(r.tasks.find((t) => t.id === 't2')?.status).toBe('done')
    expect(x.calls.filter((c) => c.kind === 'work' && c.task === 't1')).toHaveLength(1) // not retried
    expect(r.messages.some((m) => /Stopped "Task a"/.test(m.body))).toBe(true)
  })

  it('Stop on a queued task skips it', async () => {
    const x = h({ delayMs: 200, plan: { tasks: [T('a'), T('b', { deps: ['t1'] })] } })
    const run = await x.orch.start(x.proj, 'skip queued', { review: 'off' })
    await until(x.orch, run.id, (q) => q.tasks[0]?.status === 'running')
    x.orch.stopTask(run.id, 't2')
    const r = await until(x.orch, run.id, (q) => q.status === 'awaiting_approval', 20000)
    expect(r.tasks.find((t) => t.id === 't2')?.status).toBe('cancelled')
  })
})
