import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Provider, Turn } from '../agent/provider'
import { guardedBox, runLocal } from './local'
import { forLocal, parsePlan, planPrompt, workPrompt } from './prompts'
import type { Run, Task } from './types'
import { emptyUsage } from './types'

let dir = ''
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'forge-local-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// A model that answers from a script, then says "Done" to anything else (the loop's self-check turn).
const scripted = (turns: Partial<Turn>[]): Provider => {
  let i = 0
  return { chat: async (_m, _t, onText) => {
    const t = turns[i++] ?? { content: 'Done' }
    if (t.content) onText(t.content)
    return { content: t.content ?? '', toolCalls: t.toolCalls ?? [], usage: { input: 10, output: 5, genMs: 100 } }
  } }
}

describe('local agent', () => {
  it('writes a file in its folder, reports tool and code events, and finishes ok', async () => {
    const events: string[] = []
    const r = await runLocal({
      cwd: dir, prompt: 'make hello', model: 'm', write: true, signal: new AbortController().signal, onEvent: (e) => events.push(e.type),
      provider: scripted([{ toolCalls: [{ id: 'c1', name: 'create_file', args: { path: 'hello.txt', content: 'hi' } }] }, { content: 'Created hello.txt. Done.' }]),
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hi')
    expect(r.text).toContain('Created hello.txt')
    expect(r.usage.input).toBeGreaterThan(0)
    expect(events).toEqual(expect.arrayContaining(['tool', 'code', 'tool_result', 'usage', 'text', 'done']))
  })

  it('cannot change files in a read-only job', async () => {
    const r = await runLocal({
      cwd: dir, prompt: 'review', model: 'm', write: false, signal: new AbortController().signal,
      provider: scripted([{ toolCalls: [{ id: 'c1', name: 'create_file', args: { path: 'x.txt', content: 'no' } }] }, { content: 'I could not change anything. VERDICT: PASS' }]),
    })
    expect(existsSync(join(dir, 'x.txt'))).toBe(false)
    expect(await guardedBox(dir, false).run('create_file', { path: 'y.txt', content: 'z' })).toMatch(/read-only/)
    expect(r.text).toContain('VERDICT')
  })

  it('reports an unreachable model as an error the team can read', async () => {
    const failing: Provider = { chat: async () => { throw new Error('Cannot reach Ollama at http://x. Is "ollama serve" running?') } }
    const r = await runLocal({ cwd: dir, prompt: 'x', model: 'm', write: true, signal: new AbortController().signal, provider: failing })
    expect(r.ok).toBe(false)
    expect(r.error?.kind).toBe('missing')
  })
})

describe('local agent in prompts', () => {
  const task = { id: 't1', title: 'Add x', goal: 'do x', acceptance: ['it runs'], deps: [], files: [], kind: 'build', agent: 'local', summary: '', handoff: '' } as unknown as Task
  const run = { goal: 'goal', tasks: [task], messages: [], decisions: [], usage: { claude: emptyUsage(), codex: emptyUsage() } } as unknown as Run

  it('forLocal removes every mention of the team mailbox tools', () => {
    const p = forLocal(workPrompt(run, task, { brief: '', rules: '', inbox: [], memory: [], deps: [], pastProblems: [], steer: [] }))
    expect(p).not.toMatch(/team_/)
    expect(p).toContain('closing summary')
  })
  it('the planner is told to give the local agent only simple work', () => {
    expect(planPrompt('g', '', ['claude', 'local'])).toMatch(/"local".*simple/s)
    expect(planPrompt('g', '', ['claude'])).not.toMatch(/"local"/)
  })
  it('a plan may assign a task to local, but only when it is available', () => {
    const text = JSON.stringify({ summary: 's', tasks: [{ id: 't1', title: 'a', goal: 'a', agent: 'local' }, { id: 't2', title: 'b', goal: 'b', agent: 'local' }] })
    expect(parsePlan(text, ['claude', 'local']).tasks.map((t) => t.agent)).toEqual(['local', 'local'])
    expect(parsePlan(text, ['claude']).tasks.map((t) => t.agent)).toEqual(['claude', 'claude'])
  })
})
