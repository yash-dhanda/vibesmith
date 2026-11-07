import { describe, expect, it } from 'vitest'
import type { RunEvent, Task } from '../main/team/types'
import { replayRun } from './teamReplay'
import { reduceTeamView, replayTeamView, type TeamViewState } from './teamReducer'

const base = (): TeamViewState => ({ run: structuredClone(replayRun('planning').run), log: [], liveFiles: new Map() })
const agent = (ev: Extract<RunEvent, { type: 'agent' }>['ev'], taskId = 'task', phase: Extract<RunEvent, { type: 'agent' }>['phase'] = 'work'): RunEvent => ({ type: 'agent', runId: 'replay-team-run', taskId, phase, ev })
const task = (id: string): Task => ({ ...replayRun('running').run.tasks[0], id, title: id, deps: [] })

describe('Team UI reducer', () => {
  it('merges text deltas and replaces them with the final message', () => {
    let state = base()
    state = reduceTeamView(state, agent({ type: 'delta', agent: 'codex', channel: 'text', id: 'a', text: 'Hello ' }), 1)
    state = reduceTeamView(state, agent({ type: 'delta', agent: 'codex', channel: 'text', id: 'a', text: 'world' }), 2)
    expect((state.log[0].ev as any).ev.text).toBe('Hello world')
    state = reduceTeamView(state, agent({ type: 'text', agent: 'codex', text: 'Hello world.' }), 3)
    expect(state.log.some(item => item.ev.type === 'agent' && item.ev.ev.type === 'delta' && item.ev.ev.channel === 'text')).toBe(false)
    expect((state.log.at(-1)!.ev as any).ev.text).toBe('Hello world.')
  })

  it('replaces growing code by id and clears live files when a task finishes', () => {
    let state = base()
    state = reduceTeamView(state, agent({ type: 'code', agent: 'claude', id: 'file', path: 'a.ts', text: 'a', kind: 'content', done: false }), 1)
    state = reduceTeamView(state, agent({ type: 'code', agent: 'claude', id: 'file', path: 'a.ts', text: 'abc', kind: 'content', done: true }), 2)
    expect(state.log).toHaveLength(1)
    expect((state.log[0].ev as any).ev.text).toBe('abc')
    state = reduceTeamView(state, { type: 'live', runId: state.run.id, taskId: 'task', files: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0 }] })
    expect(state.liveFiles.get('task')).toHaveLength(1)
    const done = { ...task('task'), status: 'done' as const }
    state = reduceTeamView(state, { type: 'task', runId: state.run.id, task: done })
    expect(state.liveFiles.has('task')).toBe(false)
  })

  it('a status change says when this planning, work or check began, as the orchestrator does (the Background tasks clock)', () => {
    let state = reduceTeamView(base(), { type: 'run', runId: 'replay-team-run', status: 'verifying' }, 500)
    expect(state.run.activeSince).toBe(500)
    state = reduceTeamView(state, { type: 'run', runId: 'replay-team-run', status: 'paused', reason: 'Paused by you' }, 900)
    expect(state.run.activeSince).toBeUndefined()
  })

  it('keeps one exact prompt per task and phase', () => {
    let state = reduceTeamView(base(), agent({ type: 'prompt', agent: 'claude', text: 'first' }), 1)
    state = reduceTeamView(state, agent({ type: 'prompt', agent: 'claude', text: 'corrected' }), 2)
    expect(state.log).toHaveLength(1)
    expect((state.log[0].ev as any).ev.text).toBe('corrected')
  })

  it('accepts a task before the plan and ignores unknown events', () => {
    const early = reduceTeamView(base(), { type: 'task', runId: 'replay-team-run', task: task('early') })
    expect(early.run.tasks[0].id).toBe('early')
    const planned = reduceTeamView(early, { type: 'plan', runId: 'replay-team-run', summary: 'Now planned', tasks: [task('early'), task('later')] })
    expect(planned.run.tasks.map(item => item.id)).toEqual(['early', 'later'])
    expect(reduceTeamView(planned, { type: 'future-event', runId: 'replay-team-run' })).toBe(planned)
  })

  it('deduplicates messages and caps lane history', () => {
    let state = base()
    const message = { id: 'm', from: 'claude' as const, to: 'all' as const, kind: 'note' as const, body: 'once', at: 1, readBy: [] }
    state = reduceTeamView(state, { type: 'message', runId: state.run.id, message })
    state = reduceTeamView(state, { type: 'message', runId: state.run.id, message })
    expect(state.run.messages).toHaveLength(1)
    for (let i = 0; i < 300; i++) state = reduceTeamView(state, agent({ type: 'tool', agent: 'codex', id: String(i), kind: 'read', name: 'Read', summary: String(i) }), i)
    expect(state.log.filter(item => item.ev.type === 'agent' && item.ev.ev.agent === 'codex').length).toBe(240)
  })

  it('replaying timestamped events produces the same state as live ordered delivery', () => {
    const initial = base()
    const events = [
      { t: 3, ev: agent({ type: 'text', agent: 'codex', text: 'Done' }) },
      { t: 1, ev: { type: 'task', runId: 'replay-team-run', task: task('task') } as RunEvent },
      { t: 2, ev: agent({ type: 'delta', agent: 'codex', channel: 'text', id: 'x', text: 'Doing' }) },
    ]
    const replayed = replayTeamView(initial.run, events)
    const live = [...events].sort((a, b) => a.t - b.t).reduce((state, item) => reduceTeamView(state, item.ev, item.t), initial)
    expect(replayed.run).toEqual(live.run)
    expect(replayed.log).toEqual(live.log)
  })
})
