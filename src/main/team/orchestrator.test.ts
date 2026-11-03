import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentName } from './events'
import { TeamOrchestrator, type AgentCall, type AgentRunner } from './orchestrator'
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
  work?: (agent: AgentName, task: string, cwd: string) => void
  reviews?: Record<string, string[]> // task -> verdicts in order; default PASS
  conflict?: (cwd: string) => void
  verifyFix?: (cwd: string) => void
  delayMs?: number
  limitsPct?: number // emitted by the work step, like Codex app-server's plan readout
  steerable?: boolean
  stream?: boolean // emit typing events and leave a file in the folder for a while
  fail?: (agent: AgentName, kind: 'plan' | 'work' | 'review' | 'fix', task: string, n: number, resume?: string) => RunResult | null
}

function harness(script: Script, over: { available?: AgentName[]; cfg?: object } = {}) {
  const proj = project()
  const teamDir = mkdtempSync(join(tmpdir(), 'forge-orch-t-'))
  const events: RunEvent[] = []
  const calls: { agent: AgentName; kind: string; task: string; cwd: string; resume?: string; model?: string }[] = []
  const counts = new Map<string, number>()
  const steers: string[] = []
  let active = 0, maxActive = 0
  const runner: AgentRunner = async (agent, o: AgentCall) => {
    const p = o.prompt
    const find = (re: RegExp) => p.match(re)?.[1] ?? ''
    let kind = 'work', task = find(/# Your task (t\d+)/)
    if (/lead planner/.test(p)) (kind = 'plan'), (task = 'plan')
    else if (/You are reviewing/.test(p)) (kind = 'review'), (task = find(/task that was done: (t\d+)/))
    else if (/A reviewer checked your work on task (t\d+)/.test(p)) (kind = 'fix'), (task = find(/work on task (t\d+)/))
    else if (/produced conflicts/.test(p)) (kind = 'conflict'), (task = find(/Merging task (t\d+)/))
    else if (/project's check failed/.test(p)) kind = 'verifyfix'
    else if (/The team finished this goal/.test(p)) kind = 'final'
    calls.push({ agent, kind, task, cwd: o.cwd, resume: o.resume, model: o.model })
    const n = (counts.set(`${kind}:${task}`, (counts.get(`${kind}:${task}`) ?? 0) + 1), counts.get(`${kind}:${task}`)!)
    const failure = script.fail?.(agent, kind as never, task, n, o.resume)
    if (failure) return failure
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
      if (kind === 'plan') return ok('```json\n' + JSON.stringify(script.plan) + '\n```', agent, task)
      if (kind === 'work') {
        if (script.limitsPct) o.onEvent({ type: 'limits', agent, primaryPct: script.limitsPct, secondaryPct: 3 })
        if (script.work) script.work(agent, task, o.cwd)
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
        script.conflict?.(o.cwd)
        return ok('merged both', agent, task)
      }
      if (kind === 'verifyfix') {
        script.verifyFix?.(o.cwd)
        return ok('fixed the check', agent, 'v')
      }
      return ok('VERDICT: PASS', agent, task)
    } finally {
      active--
    }
  }
  const store = new TeamStore(join(teamDir, 'runs'))
  const orch = new TeamOrchestrator({ store, teamDir, runner, available: async () => over.available ?? ['claude', 'codex'], codexModels: async () => ['gpt-x-luna'], localModels: async () => ['qwen-x'], emit: (e) => events.push(e), sleep: async () => {} })
  return { proj, orch, events, calls, store, teamDir, steers, maxActive: () => maxActive }
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
    const run = await x.orch.start(x.proj, 'quota')
    const r = await until(x.orch, run.id, (r) => r.status === 'awaiting_approval')
    expect(new Set(x.calls.map((c) => c.agent))).toEqual(new Set(['claude'])) // everything, planning and review included, went to Claude
    expect(r.tasks[0].agent).toBe('claude')
    expect(r.messages.some((m) => /Codex was left out.*97% used/.test(m.body))).toBe(true)

    const y = h({ plan: { tasks: [T('a')] } }, { available: ['codex'] })
    ;(y.orch as any).d.limits = async () => ({ codex: { primaryPct: 97 } })
    await expect(y.orch.start(y.proj, 'nothing left')).rejects.toThrow(/97% used/)
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

  it('pauses when the subscription allowance is nearly used, and continues after the user allows more', async () => {
    const x = h({ limitsPct: 95, plan: { tasks: [T('a'), T('b', { deps: ['a'] })] } })
    const run = await x.orch.start(x.proj, 'limits')
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
    const run = await x.orch.start(x.proj, 'limit')
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
