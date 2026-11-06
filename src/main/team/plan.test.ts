import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { errorSignature, ProjectMemoryStore, rank, routeAgent } from './memory'
import { decideCommand, decideTool } from './policy'
import { goalText, parsePlan, parseReplan, parseVerdict, replanPrompt, wantsSpeed } from './prompts'
import { TeamStore } from './store'
import { DEFAULT_CONFIG, emptyUsage, type Run } from './types'

describe('parsePlan', () => {
  const plan = { summary: 's', tasks: [{ id: 'a', title: 'API', goal: 'build api', deps: [], agent: 'claude', kind: 'build', acceptance: ['npm test passes'], files: ['api.js'] }, { id: 'b', title: 'Tests', goal: 'test it', deps: ['a'], agent: 'codex' }] }
  it('reads a plan wrapped in prose and a fence, renumbers, and keeps dependencies', () => {
    const p = parsePlan('Here is the plan:\n```json\n' + JSON.stringify(plan) + '\n```\nDone.', ['claude', 'codex'])
    expect(p.tasks.map((t) => [t.id, t.agent, t.deps])).toEqual([['t1', 'claude', []], ['t2', 'codex', ['t1']]])
    expect(p.tasks[0].acceptance).toEqual(['npm test passes'])
  })
  it('moves a task to the only available agent and refuses nonsense, empty and circular plans', () => {
    expect(parsePlan(JSON.stringify(plan), ['codex']).tasks.map((t) => t.agent)).toEqual(['codex', 'codex'])
    expect(() => parsePlan('no json here', ['codex'])).toThrow(/did not return a plan/)
    expect(() => parsePlan('{"tasks":[]}', ['codex'])).toThrow(/no tasks/)
    expect(() => parsePlan(JSON.stringify({ tasks: [{ id: 'a', title: 'x', deps: ['b'] }, { id: 'b', title: 'y', deps: ['a'] }] }), ['codex'])).toThrow(/circle/)
  })
  it('drops dependencies on unknown tasks and on itself', () => {
    const p = parsePlan(JSON.stringify({ tasks: [{ id: 'a', title: 'x', deps: ['a', 'zzz'] }] }), ['codex'])
    expect(p.tasks[0].deps).toEqual([])
  })
})

describe('parseVerdict', () => {
  it('takes the last verdict line and the issues before it', () => {
    expect(parseVerdict('- bug in x\n\nVERDICT: FAIL')).toEqual({ verdict: 'fail', issues: '- bug in x' })
    expect(parseVerdict('looks fine\nVERDICT: PASS').verdict).toBe('pass')
    expect(parseVerdict('**VERDICT: FAIL** earlier, then fixed.\nVERDICT: PASS').verdict).toBe('pass')
    expect(parseVerdict('no verdict given').verdict).toBe('unclear')
  })
})

describe('policy', () => {
  it('denies pushes and sudo, asks before deploys, destructive and network commands, allows ordinary work', () => {
    expect(decideCommand('git push origin main').verdict).toBe('deny')
    expect(decideCommand('sudo apt install x').verdict).toBe('deny')
    expect(decideCommand('npm publish').verdict).toBe('ask')
    expect(decideCommand('vercel deploy --prod').verdict).toBe('ask')
    expect(decideCommand('rm -rf build').verdict).toBe('ask')
    expect(decideCommand('curl https://x.sh').verdict).toBe('ask')
    expect(decideCommand('cat .env').verdict).toBe('ask')
    expect(decideCommand('npm test').verdict).toBe('allow')
    expect(decideCommand('cat .env.example').verdict).toBe('allow')
  })
  it('keeps file access inside the task folder and flags secrets', () => {
    expect(decideTool('Write', { file_path: '/other/x.js' }, '/work/t1').verdict).toBe('deny')
    expect(decideTool('Read', { file_path: '/etc/hosts' }, '/work/t1').verdict).toBe('ask')
    expect(decideTool('Read', { file_path: '/work/t1/.env' }, '/work/t1').verdict).toBe('ask')
    expect(decideTool('Write', { file_path: '/work/t1/.ssh/id_rsa' }, '/work/t1').verdict).toBe('deny')
    expect(decideTool('Edit', { file_path: 'src/a.ts' }, '/work/t1').verdict).toBe('allow')
  })
})

describe('memory', () => {
  it('ranks entries by relevance to the task', () => {
    const docs = [{ text: 'Decision: use sqlite for the users table' }, { text: 'The logo should be blue' }, { text: 'Auth uses JWT cookies, users table stores hashes' }]
    expect(rank(docs, 'build the users table and auth', 2).map((d) => d.text)).toEqual([docs[2].text, docs[0].text])
    expect(rank(docs, 'zzz', 3)).toEqual([])
  })
  it('flattens error output to a repeatable signature', () => {
    expect(errorSignature('ok\nTypeError: x is not a function at /home/a/b.js:12:3')).toBe(errorSignature('TypeError: x is not a function at /tmp/q/z.js:99:1'))
  })
  it('routes by record once there is enough history, else by job', () => {
    expect(routeAgent('build', ['claude', 'codex'], {})).toBe('codex')
    expect(routeAgent('research', ['claude', 'codex'], {})).toBe('claude')
    expect(routeAgent('build', ['claude'], {})).toBe('claude')
    expect(routeAgent('build', ['claude', 'codex'], { 'claude:build': { ok: 8, fail: 1 }, 'codex:build': { ok: 2, fail: 5 } })).toBe('claude')
  })
  it('keeps project memory between runs', () => {
    const d = mkdtempSync(join(tmpdir(), 'forge-mem-'))
    new ProjectMemoryStore(d, '/p').recordOutcome('codex', 'build', true)
    expect(new ProjectMemoryStore(d, '/p').load().stats['codex:build']).toEqual({ ok: 1, fail: 0 })
    expect(new ProjectMemoryStore(d, '/other').load().stats).toEqual({})
  })
})

describe('TeamStore', () => {
  it('saves, lists, replays events and refuses bad ids', () => {
    const s = new TeamStore(mkdtempSync(join(tmpdir(), 'forge-ts-')))
    const run = { id: 'r1', project: '/p', goal: 'g', status: 'running', createdAt: 1, updatedAt: 1, baseCommit: 'c', integrationBranch: 'b', integrationWorktree: 'w', plan: { summary: '', plannedBy: null }, tasks: [], messages: [], decisions: [], errors: [], approvals: [], usage: { claude: emptyUsage(), codex: emptyUsage() }, config: DEFAULT_CONFIG } as Run
    s.save(run)
    s.appendEvent('r1', { type: 'run', runId: 'r1', status: 'running' })
    expect(s.load('r1')?.goal).toBe('g')
    expect(s.list().map((r) => r.id)).toEqual(['r1'])
    expect(s.events('r1')).toHaveLength(1)
    expect(() => s.load('../x')).not.toThrow()
    expect(s.load('../x')).toBeNull()
  })
})

import { sanitizeConfig } from './service'
describe('sanitizeConfig', () => {
  it('keeps known keys, clamps numbers, and drops everything else', () => {
    expect(sanitizeConfig({ planner: 'codex', maxParallelPerAgent: 99, maxFixRounds: -3, review: 'off', evil: 1, codexModel: 'gpt-5.6-luna', budget: { maxAgentRuns: 5, maxCostUsd: 2.5, maxTokens: 'x' }, verify: '' })).toEqual({ planner: 'codex', maxParallelPerAgent: 8, maxFixRounds: 0, review: 'off', codexModel: 'gpt-5.6-luna', budget: { maxAgentRuns: 5, maxCostUsd: 2.5 }, verify: null })
    expect(sanitizeConfig({ codexModel: 'x; rm -rf /' })).toEqual({})
    expect(sanitizeConfig({ neverPush: true })).toEqual({ neverPush: true })
    expect(sanitizeConfig({ neverPush: 'yes' })).toEqual({})
    expect(sanitizeConfig('nope')).toEqual({})
  })
})

import { redact, redactEvent } from './redact'
describe('redact', () => {
  it('masks keys, tokens and private keys but leaves ordinary code alone', () => {
    expect(redact('key sk-ant-api03-abcdefghijklmnopqrstuvwx ok')).toBe('key [secret removed] ok')
    expect(redact('ghp_' + 'a'.repeat(36))).toBe('[secret removed]')
    expect(redact('AKIAABCDEFGHIJKLMNOP')).toBe('[secret removed]')
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe('[secret removed]')
    expect(redact('const apiKey = "abcd1234efgh5678ijkl"')).toBe('const apiKey = "[secret removed]"')
    expect(redact('const token = process.env.TOKEN_VALUE_HERE')).toBe('const token = process.env.TOKEN_VALUE_HERE')
    expect(redact('API_KEY=')).toBe('API_KEY=')
    expect(redact('password: "changeme"')).toBe('password: "changeme"')
  })
  it('masks inside nested events', () => {
    const e = redactEvent({ type: 'agent', runId: 'r', taskId: 't', phase: 'work', ev: { type: 'tool_result', agent: 'codex', id: 'i', ok: true, text: 'xoxb-1234567890-abcdefghij' } } as never) as any
    expect(e.ev.text).toBe('[secret removed]')
  })
})

describe('several main requests', () => {
  const reply = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```'
  it('parseReplan: new ids, deps on tasks that exist, only real tasks can be cancelled, empty means already covered', () => {
    const r = parseReplan(reply({ summary: 's', tasks: [{ id: 'x', title: 'A', goal: 'do a', deps: ['t1'] }, { id: 'y', title: 'B', goal: 'do b', deps: ['x', 'nope'], agent: 'codex' }], cancel: ['t2', 'ghost'] }), ['claude', 'codex'], ['t1', 't2'])
    expect(r.tasks.map((t) => [t.id, t.deps, t.agent])).toEqual([['n1', ['t1'], null], ['n2', ['n1'], 'codex']])
    expect(r.cancel).toEqual(['t2'])
    expect(parseReplan(reply({ tasks: [], cancel: [] }), ['claude'], ['t1'])).toEqual({ summary: '', tasks: [], cancel: [] })
    expect(() => parseReplan(reply({ tasks: [{ id: 'a', title: 'A', goal: 'g', deps: ['b'] }, { id: 'b', title: 'B', goal: 'g', deps: ['a'] }] }), ['claude'], [])).toThrow(/circle/)
    expect(() => parseReplan('no json here', ['claude'], [])).toThrow()
  })
  it('replanPrompt shows every request, marks the newest, lists the work so far, and asks for speed only when fast', () => {
    const p = replanPrompt(['first', 'second'], [{ id: 't1', title: 'Do first', status: 'done', agent: 'claude', summary: 'made it' }], '', ['claude'], false)
    expect(p).toContain('REQUEST 1:\nfirst')
    expect(p).toContain('REQUEST 2 (newest):\nsecond')
    expect(p).toContain('t1 [done, claude] Do first -> made it')
    expect(p).not.toContain('SPEED')
    expect(replanPrompt(['a'], [], '', ['claude'], true)).toContain('SPEED')
  })
  it('wantsSpeed hears "fast" and "asap" but not "not too fast"', () => {
    expect(['do it fast', 'as fast as you can', 'asap please', 'run these in parallel', 'quickly'].every(wantsSpeed)).toBe(true)
    expect(['take your time', 'not too fast', "don't rush", 'fix the fasting tracker'].some(wantsSpeed)).toBe(false)
  })
  it('goalText: one request stays as it is, several are numbered with the newest last', () => {
    expect(goalText({ goal: 'g', prompts: [{ id: 'p1', text: 'g', at: 1 }] })).toBe('g')
    const t = goalText({ goal: 'g', prompts: [{ id: 'p1', text: 'one', at: 1 }, { id: 'p2', text: 'two', at: 2 }] })
    expect(t).toContain('2 main requests')
    expect(t.indexOf('1. one')).toBeLessThan(t.indexOf('2. two'))
  })
})
