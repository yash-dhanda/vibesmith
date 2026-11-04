import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HistoryRecorder, historyBlock, historyPath, writeHistory } from './history'
import type { Run, RunEvent, Task } from './types'

const run = { id: 'r1', project: '/p', plan: { summary: 's', plannedBy: 'claude' } } as unknown as Run
const task = (over: Partial<Task>) => ({ id: 't1', title: 'Add login', agent: 'local', status: 'running', phase: 'work', deps: [], changed: [], summary: '', ...over }) as unknown as Task

describe('project history', () => {
  it('creates the file once, hides it from git locally, and only ever appends', () => {
    const p = mkdtempSync(join(tmpdir(), 'hist-'))
    mkdirSync(join(p, '.git', 'info'), { recursive: true })
    writeHistory(p, 'Run r1 started. Goal: login')
    writeHistory(p, ['second', 'third'])
    const text = readFileSync(historyPath(p), 'utf8')
    expect(text.startsWith('WHAT HAPPENED IN THIS PROJECT')).toBe(true)
    expect(text.match(/Run r1 started/g)).toHaveLength(1)
    expect(text.trim().split('\n').slice(-2).map((l) => l.replace(/^\[[^\]]+\] /, ''))).toEqual(['second', 'third'])
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toContain('.forge/')
    writeHistory(p, 'again')
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8').match(/\.forge\//g)).toHaveLength(1)
  })

  it('turns run events into plain lines, once per change', () => {
    const h = new HistoryRecorder()
    const done = task({ status: 'done', phase: null, summary: 'Login form added', changed: [{ path: 'src/login.ts', status: 'added', added: 20, removed: 0 }] })
    expect(h.lines(run, { type: 'task', runId: 'r1', task: task({ status: 'running' }) } as RunEvent)[0]).toContain('Task t1 "Add login" (Local) is running/work')
    expect(h.lines(run, { type: 'task', runId: 'r1', task: task({ status: 'running' }) } as RunEvent)).toEqual([]) // no repeat
    const l = h.lines(run, { type: 'task', runId: 'r1', task: done } as RunEvent)[0]
    expect(l).toContain('is done')
    expect(l).toContain('Login form added')
    expect(l).toContain('src/login.ts')
    expect(h.lines(run, { type: 'approval', runId: 'r1', approval: { id: 'a', kind: 'question', title: 'Which database?', detail: '', status: 'allowed', answer: 'SQLite', at: 1 } } as RunEvent)[0]).toBe('The user answered "Which database?": SQLite')
    expect(h.lines(run, { type: 'verify', runId: 'r1', command: 'npm test', ok: false, output: 'a\nb\nFAIL x' } as RunEvent)[0]).toContain('failed')
  })

  it('does not write secrets, and hands agents the newest lines with the path to the whole file', () => {
    const p = mkdtempSync(join(tmpdir(), 'hist-'))
    expect(historyBlock(p)).toBe('')
    writeHistory(p, Array.from({ length: 60 }, (_, i) => `entry ${i}`))
    writeHistory(p, 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 was used')
    const block = historyBlock(p, 5)
    expect(block).toContain(historyPath(p))
    expect(block).toContain('entry 59')
    expect(block).not.toContain('entry 10')
    expect(readFileSync(historyPath(p), 'utf8')).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')
  })
})
