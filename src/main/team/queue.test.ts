import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RunQueue } from './queue'
import type { Run, RunEvent } from './types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean, ms = 2000) {
  const t = Date.now()
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timeout')
    await sleep(5)
  }
}
const fin = (o: Partial<NonNullable<Run['final']>> = {}) => ({ report: '', files: [{ path: 'a.ts', status: 'modified' as const, added: 3, removed: 1 }], verifyOk: true, verifyOutput: '', reviewNotes: ['claude: PASS — fine'], ...o })

function rig(file = join(mkdtempSync(join(tmpdir(), 'forge-q-')), 'queue.json'), pre: Record<string, Partial<Run>> = {}) {
  const runs = new Map<string, Partial<Run>>(Object.entries(pre))
  const listeners: ((ev: RunEvent) => void)[] = []
  const started: string[] = []
  const landed: string[] = []
  const notes: string[] = []
  let landResult = { ok: true, message: 'Applied.' }
  const x = {
    file, runs, started, landed, notes,
    failLand: (message: string) => (landResult = { ok: false, message }),
    emit: (id: string, status: Run['status'], extra: Partial<Run> = {}) => {
      const r = runs.get(id)!
      Object.assign(r, { status, ...extra })
      listeners.forEach((l) => l({ type: 'run', runId: id, status, reason: r.pausedReason }))
    },
    make: () =>
      new RunQueue({
        file,
        start: async (_p, goal) => {
          started.push(goal)
          const id = `run${started.length}`
          runs.set(id, { id, status: 'planning', usage: { claude: { input: 0, output: 0, cached: 0, costUsd: 0.5, runs: 1 }, codex: { input: 0, output: 0, cached: 0, costUsd: 0.25, runs: 1 } } })
          return { id }
        },
        getRun: (id) => (runs.get(id) as Run) ?? null,
        onRunEvent: (cb) => void listeners.push(cb),
        land: async (id) => {
          landed.push(id)
          if (landResult.ok) x.emit(id, 'done', { applied: true })
          return landResult
        },
        notify: (k) => void notes.push(k),
      }),
  }
  return x
}
const add = (q: RunQueue, goal: string, o: object = {}) => q.add({ project: '/p/app', goal, ...o })

describe('run queue', () => {
  it('runs items one at a time, in order, and lands a clean result by itself when asked', async () => {
    const x = rig()
    const q = x.make()
    add(q, 'first', { autoLand: true })
    add(q, 'second', { autoLand: true })
    q.start()
    await until(() => x.started.length === 1)
    await sleep(30)
    expect(x.started).toEqual(['first']) // the second waits for the first
    x.emit('run1', 'awaiting_approval', { final: fin() })
    await until(() => x.started.length === 2)
    expect(x.landed).toEqual(['run1'])
    expect(q.list().map((i) => i.status)).toEqual(['landed', 'running'])
    x.emit('run2', 'awaiting_approval', { final: fin({ verifyOk: null }) }) // no check in the project: nothing against landing
    await until(() => q.list()[1].status === 'landed')
    expect(q.active).toBe(false)
    expect(x.notes).toEqual(['finished'])
  })

  it('does not land by itself unless the item asked, and stops as "needs you"', async () => {
    const x = rig()
    const q = x.make()
    add(q, 'manual')
    add(q, 'next', { autoLand: true })
    q.start()
    await until(() => x.started.length === 1)
    x.emit('run1', 'awaiting_approval', { final: fin() })
    await until(() => q.list()[0].status === 'ready')
    await sleep(30)
    expect(x.landed).toEqual([])
    expect(x.started).toEqual(['manual'])
    expect(q.active).toBe(false)
    expect(x.notes).toEqual(['attention'])
    expect(q.list()[0].note).toMatch(/off for this item/)
  })

  it.each([
    ['the check failed', { verifyOk: false }, /check failed/],
    ['the final review said FAIL', { reviewNotes: ['codex: FAIL — missing the edge case'] }, /said FAIL/],
    ['the security review said FAIL', { reviewNotes: ['Security review: FAIL — user input reaches a shell'] }, /said FAIL/],
  ])('stops instead of landing when %s', async (_n, f, why) => {
    const x = rig()
    const q = x.make()
    add(q, 'risky', { autoLand: true })
    add(q, 'later', { autoLand: true })
    q.start()
    await until(() => x.started.length === 1)
    x.emit('run1', 'awaiting_approval', { final: fin(f) })
    await until(() => q.list()[0].status === 'ready')
    expect(q.list()[0].note).toMatch(why)
    expect(x.landed).toEqual([])
    expect(x.started).toEqual(['risky'])
    expect(x.notes).toEqual(['attention'])
  })

  it('a landing that fails leaves the run for the user', async () => {
    const x = rig()
    const q = x.make()
    add(q, 'conflict', { autoLand: true })
    x.failLand('Could not apply cleanly')
    q.start()
    await until(() => x.started.length === 1)
    x.emit('run1', 'awaiting_approval', { final: fin() })
    await until(() => q.list()[0].status === 'ready')
    expect(q.list()[0].note).toMatch(/Could not apply cleanly/)
    expect(q.active).toBe(false)
  })

  it('a failed run stops the queue, unless the item says to continue', async () => {
    const x = rig()
    const q = x.make()
    add(q, 'breaks')
    add(q, 'after')
    q.start()
    await until(() => x.started.length === 1)
    x.emit('run1', 'failed', { pausedReason: 'Claude ran out of budget' })
    await until(() => q.list()[0].status === 'failed')
    expect(q.list()[0].note).toBe('Claude ran out of budget')
    await sleep(30)
    expect(x.started).toEqual(['breaks'])
    expect(x.notes).toEqual(['attention'])

    const y = rig()
    const q2 = y.make()
    add(q2, 'breaks', { continueOnFail: true })
    add(q2, 'after')
    q2.start()
    await until(() => y.started.length === 1)
    y.emit('run1', 'cancelled')
    await until(() => y.started.length === 2)
    expect(q2.list().map((i) => i.status)).toEqual(['failed', 'running'])
  })

  it('a start that throws is a failure of that item', async () => {
    const x = rig()
    const q = new RunQueue({ file: x.file, start: async () => { throw new Error('This project already has a team run in progress.') }, getRun: () => null, onRunEvent: () => {}, land: async () => ({ ok: true, message: '' }) })
    add(q, 'blocked')
    q.start()
    await until(() => q.list()[0].status === 'failed')
    expect(q.list()[0].note).toMatch(/already has a team run/)
  })

  it('pause lets the current run finish but starts nothing new; remove and move work on waiting items', async () => {
    const x = rig()
    const q = x.make()
    const a = add(q, 'a')
    const b = add(q, 'b')
    const c = add(q, 'c')
    expect(q.move(c.id, 0)).toBe(true)
    expect(q.list().map((i) => i.goal)).toEqual(['c', 'a', 'b'])
    expect(q.remove(b.id)).toBe(true)
    q.start()
    await until(() => x.started.length === 1)
    expect(x.started).toEqual(['c'])
    expect(q.remove(q.list()[0].id)).toBe(false) // running
    q.pause()
    x.emit('run1', 'awaiting_approval', { final: fin() })
    await until(() => q.list()[0].status === 'ready')
    await sleep(30)
    expect(x.started).toEqual(['c'])
    expect(a.id).toBeTruthy()
  })

  it('keeps the queue across a restart, and survives a corrupt file', async () => {
    const x = rig()
    const q = x.make()
    add(q, 'kept', { autoLand: true, continueOnFail: true, config: { review: 'off' } })
    const y = rig(x.file)
    const items = y.make().list()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ goal: 'kept', autoLand: true, continueOnFail: true, status: 'waiting', config: { review: 'off' } })

    writeFileSync(x.file, '{"items": [{"id": "x", "goal": "no project"}, nope')
    const z = rig(x.file).make()
    expect(z.list()).toEqual([])
    expect(existsSync(x.file + '.corrupt')).toBe(true)
    add(z, 'fresh')
    expect(JSON.parse(readFileSync(x.file, 'utf8')).items).toHaveLength(1)

    writeFileSync(x.file, JSON.stringify({ v: 1, items: [{ id: 'a', goal: 'g', project: '/p', status: 'bogus' }, { id: 'b', goal: 7 }] }))
    expect(rig(x.file).make().list()).toMatchObject([{ id: 'a', status: 'waiting', autoLand: false }])
  })

  it('after a restart an interrupted run holds the queue with a note; resuming the run lets it finish', async () => {
    const x = rig()
    const q = x.make()
    add(q, 'overnight', { autoLand: true })
    add(q, 'next')
    q.start()
    await until(() => x.started.length === 1)
    x.emit('run1', 'running')
    // quit: a new process loads the file; the run is now interrupted
    const y = rig(x.file, { run1: { id: 'run1', status: 'interrupted' } })
    const q2 = y.make()
    expect(q2.active).toBe(false)
    expect(q2.list()[0]).toMatchObject({ status: 'running', runId: 'run1' })
    expect(q2.list()[0].note).toMatch(/Resume it/)
    q2.start()
    await sleep(40)
    expect(y.started).toEqual([]) // nothing new starts while its run is unfinished
    y.emit('run1', 'awaiting_approval', { final: fin() })
    await until(() => y.started.length === 1)
    expect(y.landed).toEqual(['run1'])
    expect(y.started).toEqual(['next'])
  })

  it('on load, an item whose run ended meanwhile is settled, and a vanished run is a failure', async () => {
    const x = rig()
    const q = x.make()
    add(q, 'applied by hand')
    add(q, 'rejected')
    add(q, 'lost')
    q.start()
    await until(() => x.started.length === 1)
    x.emit('run1', 'awaiting_approval', { final: fin() })
    await until(() => q.list()[0].status === 'ready')
    const file = JSON.parse(readFileSync(x.file, 'utf8'))
    file.items[1] = { ...file.items[1], status: 'running', runId: 'run2' }
    file.items[2] = { ...file.items[2], status: 'running', runId: 'gone' }
    writeFileSync(x.file, JSON.stringify(file))
    const y = rig(x.file, { run1: { status: 'done', applied: true }, run2: { status: 'done', applied: false } })
    const q2 = y.make()
    await until(() => q2.list().every((i) => i.status !== 'running'))
    expect(q2.list().map((i) => i.status)).toEqual(['ready', 'skipped', 'failed'])
    // the first was ready and its run is done now: the queue notices the next time the run reports in
    y.runs.set('run1', { status: 'done', applied: true })
    y.emit('run1', 'done')
    await until(() => q2.list()[0].status === 'landed')
    expect(q2.list()[0].note).toMatch(/You landed it/)
  })

  it('writes a morning report with what each item did and what needs the user', async () => {
    const x = rig()
    const q = x.make()
    add(q, 'add dark mode\nwith a toggle', { autoLand: true })
    add(q, 'fix the login bug')
    add(q, 'never reached')
    q.start()
    await until(() => x.started.length === 1)
    x.emit('run1', 'awaiting_approval', { final: fin({ reviewNotes: ['claude: PASS — looks right', 'Security review: PASS — nothing found'] }) })
    await until(() => x.started.length === 2)
    x.emit('run2', 'awaiting_approval', { final: fin({ verifyOk: false, files: [{ path: 'auth.ts', status: 'modified', added: 10, removed: 2 }, { path: 'b.ts', status: 'added', added: 1, removed: 0 }] }) })
    await until(() => q.list()[1].status === 'ready')
    const r = q.morningReport()
    expect(r).toContain('3 goals: 1 landed, 1 waiting for you, 0 failed')
    expect(r).toContain('## 1. add dark mode')
    expect(r).not.toContain('with a toggle')
    expect(r).toMatch(/Status: Landed/)
    expect(r).toContain('Files changed: 1 (+3 -1): a.ts')
    expect(r).toContain('Check: passed')
    expect(r).toContain('Security review: PASS')
    expect(r).toContain('Cost: $0.75')
    expect(r).toContain('Files changed: 2 (+11 -2): auth.ts, b.ts')
    expect(r).toContain('Check: FAILED')
    expect(r).toMatch(/Needs you: The final check failed/)
    expect(r).toMatch(/## 3\. never reached[\s\S]*Status: Not started/)
  })
})
