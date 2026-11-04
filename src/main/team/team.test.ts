import { describe, expect, it } from 'vitest'
import { claudeArgs, CLAUDE_DENY } from './claude'
import { makeClaudeParser } from './claudeStream'
import { codexArgs } from './codex'
import { codexLeanArgs } from './link'
import { makeCodexParser, unwrapShell } from './codexStream'
import { classifyError, partialField, type TeamEvent } from './events'
import { cleanEnv, runCli } from './process'

const feed = (parse: (l: string) => TeamEvent[], lines: unknown[]) => lines.flatMap((l) => parse(JSON.stringify(l)))

describe('codex parser (shapes captured from codex-cli 0.153)', () => {
  it('turns a file edit + command run into normalised events', () => {
    const cwd = '/work/p'
    const ev = feed(makeCodexParser(cwd), [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'on it' } },
      { type: 'item.started', item: { id: 'i1', type: 'file_change', changes: [{ path: '/work/p/hello.txt', kind: 'add' }], status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [], status: 'completed' } },
      { type: 'item.started', item: { id: 'i2', type: 'command_execution', command: "/usr/bin/zsh -lc 'cat hello.txt'", exit_code: null, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'x', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5, reasoning_output_tokens: 2 } },
    ])
    expect(ev.map((e) => e.type)).toEqual(['session', 'text', 'tool', 'tool_result', 'tool', 'tool_result', 'text', 'usage', 'done'])
    expect(ev[2]).toMatchObject({ kind: 'edit', summary: 'add hello.txt' })
    expect(ev[4]).toMatchObject({ kind: 'command', summary: 'cat hello.txt' })
    expect(ev[5]).toMatchObject({ ok: true, text: 'hi\n' })
    expect(ev.at(-2)).toMatchObject({ type: 'usage', input: 100, output: 7, cached: 40 })
    expect(ev.at(-1)).toMatchObject({ type: 'done', ok: true, text: 'done' })
  })
  it('reports a model the plan does not include as a model error, once', () => {
    const msg = JSON.stringify({ type: 'error', status: 400, error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", code: 'model_not_found' } })
    const ev = feed(makeCodexParser(), [
      { type: 'error', message: msg },
      { type: 'turn.failed', error: { message: msg } },
    ])
    expect(ev.map((e) => e.type)).toEqual(['error', 'done'])
    expect(ev[0]).toMatchObject({ kind: 'model' })
    expect(ev[1]).toMatchObject({ ok: false })
  })
  it('keeps non-fatal warnings as notes and ignores garbage', () => {
    const p = makeCodexParser()
    expect(feed(p, [{ type: 'item.completed', item: { type: 'error', message: 'Model metadata not found' } }])[0]).toMatchObject({ type: 'note' })
    expect(p('not json')).toEqual([])
  })
  it('unwraps the shell wrapper', () => {
    expect(unwrapShell(`/bin/bash -lc 'ls -la'`)).toBe('ls -la')
    expect(unwrapShell('npm test')).toBe('npm test')
  })
})

describe('claude parser', () => {
  it('maps messages, tool use, tool results and the result line', () => {
    const ev = feed(makeClaudeParser(), [
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'ok' }], is_error: false }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'all good', session_id: 's1', total_cost_usd: 0.02, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 7 } },
    ])
    expect(ev.map((e) => e.type)).toEqual(['session', 'text', 'tool', 'tool_result', 'usage', 'done'])
    expect(ev[2]).toMatchObject({ kind: 'command', summary: 'npm test' })
    expect(ev[4]).toMatchObject({ input: 100, cached: 90, output: 7, costUsd: 0.02 })
    expect(ev[5]).toMatchObject({ ok: true, text: 'all good', sessionId: 's1' })
  })
  it('turns the expired-login result into an auth error and hides the synthetic message', () => {
    const ev = feed(makeClaudeParser(), [
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired' }] } },
      { type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', session_id: 's', usage: {} },
    ])
    expect(ev.map((e) => e.type)).toEqual(['usage', 'error', 'done'])
    expect(ev[1]).toMatchObject({ kind: 'auth' })
  })
})

describe('classifyError', () => {
  it('sorts the failures Forge has met', () => {
    expect(classifyError('The model is not supported when using Codex with a ChatGPT account')).toBe('model')
    expect(classifyError('Failed to authenticate: OAuth session expired')).toBe('auth')
    expect(classifyError('You have hit your usage limit')).toBe('limit')
    expect(classifyError('Claude AI usage limit reached|1793000000')).toBe('limit')
    expect(classifyError('429 Too Many Requests')).toBe('busy')
    expect(classifyError('API Error: 529 overloaded')).toBe('busy')
    expect(classifyError('boom')).toBe('other')
  })
})

describe('argument builders', () => {
  it('claude: plan mode when read-only, deny list always, resume and mcp passed through', () => {
    const ro = claudeArgs({ cwd: '/p', prompt: 'x', write: false })
    expect(ro).toContain('plan')
    expect(ro).not.toContain('--allowedTools')
    expect(ro.join(' ')).toContain(CLAUDE_DENY[0])
    const rw = claudeArgs({ cwd: '/p', prompt: 'x', write: true, resume: 'abc', mcpConfig: '/m.json', model: 'sonnet', effort: 'high' })
    expect(rw).toEqual(expect.arrayContaining(['acceptEdits', '--resume', 'abc', '--mcp-config', '/m.json', '--model', 'sonnet', '--effort', 'high', '--allowedTools']))
  })
  it('web research: allowed and live for Claude and Codex when on, and denied for Claude when off', () => {
    const flag = (a: string[], name: string) => a[a.indexOf(name) + 1] ?? ''
    expect(flag(claudeArgs({ cwd: '/p', prompt: 'x', write: true, web: true }), '--allowedTools')).toContain('WebSearch,WebFetch')
    expect(flag(claudeArgs({ cwd: '/p', prompt: 'x', write: true, web: false }), '--disallowedTools')).toContain('WebSearch,WebFetch')
    expect(codexArgs({ cwd: '/p', prompt: 'x', write: true, model: 'm', web: true })).toContain('web_search="live"')
    expect(codexArgs({ cwd: '/p', prompt: 'x', write: true, model: 'm', web: false })).toContain('web_search="disabled"')
  })
  it('claude: may read the skill libraries through --add-dir, and gets no extra folders otherwise', () => {
    const a = claudeArgs({ cwd: '/p', prompt: 'x', write: true, addDirs: ['/skills/a__b'] })
    expect(a.slice(a.indexOf('--add-dir'), a.indexOf('--add-dir') + 2)).toEqual(['--add-dir', '/skills/a__b'])
    expect(claudeArgs({ cwd: '/p', prompt: 'x', write: true })).not.toContain('--add-dir')
  })
  it('codex: passes the chosen reasoning effort, and nothing when none is chosen', () => {
    expect(codexArgs({ cwd: '/p', prompt: 'x', write: true, model: 'm', effort: 'xhigh' })).toContain('model_reasoning_effort="xhigh"')
    expect(codexArgs({ cwd: '/p', prompt: 'x', write: true, model: 'm' }).join(' ')).not.toContain('model_reasoning_effort')
  })
  it('codex: pins the model, reads the prompt from stdin, sandboxes by role', () => {
    const a = codexArgs({ cwd: '/p', prompt: 'x', write: true, model: 'gpt-5.6-luna' })
    const lean = codexLeanArgs()
    expect(lean).toEqual(expect.arrayContaining(['--disable', 'apps', 'plugins', 'computer_use']))
    expect(a).toEqual(['exec', '--json', '-C', '/p', '-s', 'workspace-write', '-m', 'gpt-5.6-luna', '-c', 'approval_policy="never"', ...lean, '-'])
    expect(codexArgs({ cwd: '/p', prompt: 'x', write: false, model: 'm', resume: 't1' })).toEqual(['exec', 'resume', 't1', '--json', '-m', 'm', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', ...lean, '-'])
  })
})

describe('cleanEnv', () => {
  it('drops variables that would change billing or mark a nested session, keeps the rest', () => {
    const e = cleanEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', OPENAI_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c' }, { X: '1' })
    expect(e).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', X: '1' })
  })
})

// A stand-in agent: this same node binary, running a script that speaks codex's JSON lines.
describe('runCli', () => {
  const node = process.execPath
  const script = (body: string) => ['-e', body]
  const p = () => makeCodexParser()
  const base = { cwd: process.cwd() }

  it('passes the prompt on stdin untouched and collects the result', async () => {
    const body = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=(x)=>console.log(JSON.stringify(x));o({type:'thread.started',thread_id:'T'});o({type:'item.completed',item:{id:'a',type:'agent_message',text:s}});o({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}})})`
    const prompt = `quote " and 'single' and\nnewline $HOME \`tick\``
    const r = await runCli('codex', node, script(body), p(), { ...base, prompt })
    expect(r).toMatchObject({ ok: true, text: prompt, sessionId: 'T' })
    expect(r.usage).toMatchObject({ input: 3, output: 2 })
  })
  it('kills a stuck agent after the idle limit', async () => {
    const t = Date.now()
    const r = await runCli('codex', node, script('setInterval(()=>{},1000)'), p(), { ...base, prompt: '', idleMs: 300 })
    expect(r.ok).toBe(false)
    expect(r.error?.kind).toBe('timeout')
    expect(Date.now() - t).toBeLessThan(5000)
  })
  it('stops on abort', async () => {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 200)
    const r = await runCli('codex', node, script('setInterval(()=>{},1000)'), p(), { ...base, prompt: '', signal: ctl.signal })
    expect(r.error?.kind).toBe('aborted')
  })
  it('reports a missing binary and a crash with an auth message', async () => {
    expect((await runCli('codex', 'forge-no-such-agent', [], p(), { ...base, prompt: '' })).error?.kind).toBe('missing')
    const r = await runCli('claude', node, script(`console.error('OAuth session expired');process.exit(1)`), p(), { ...base, prompt: '' })
    expect(r).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })
})

import { resolveCommand, shimTarget } from './bin'
describe('resolveCommand (Windows launch)', () => {
  const shim = 'C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd'
  const text = '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
  it('leaves non-Windows names and absolute paths alone', () => {
    expect(resolveCommand('codex', ['exec'], { platform: 'linux' })).toEqual({ cmd: 'codex', args: ['exec'], env: {} })
    expect(resolveCommand('C:\\x\\claude.exe', ['-p'], { platform: 'win32' }).cmd).toBe('C:\\x\\claude.exe')
  })
  it('prefers a real .exe, else runs the script a .cmd shim points to with the app as node', () => {
    expect(resolveCommand('claude', ['-p'], { platform: 'win32', which: () => ['C:\\b\\claude.cmd', 'C:\\b\\claude.exe'] }).cmd).toBe('C:\\b\\claude.exe')
    const r = resolveCommand('codex', ['exec', '--json'], { platform: 'win32', which: () => [shim], read: () => text, exists: () => true, node: 'C:\\app\\Forge.exe' })
    expect(r.cmd).toBe('C:\\app\\Forge.exe')
    expect(r.args[0]).toMatch(/node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/)
    expect(r.args.slice(1)).toEqual(['exec', '--json'])
    expect(r.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })
  it('falls back to the plain name when nothing can be resolved', () => {
    expect(resolveCommand('codex', ['x'], { platform: 'win32', which: () => [] }).cmd).toBe('codex')
    expect(shimTarget(shim, 'nothing here', () => true)).toBeNull()
  })
})

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamSettingsStore } from './settings'
describe('TeamSettingsStore', () => {
  it('remembers defaults per project', () => {
    const st = new TeamSettingsStore(mkdtempSync(join(tmpdir(), 'forge-set-')))
    st.set('/a', { verify: 'npm test', maxFixRounds: 2 })
    expect(st.get('/a')).toEqual({ verify: 'npm test', maxFixRounds: 2 })
    expect(st.get('/b')).toEqual({})
  })
})

describe('live typing', () => {
  it('reads a string value out of JSON that is still arriving', () => {
    expect(partialField('{"file_path":"a.js","content":"line1\\nline2 \\"q\\" \\u00e9', 'content')).toBe('line1\nline2 "q" é')
    expect(partialField('{"file_path":"a.js","content":"abc', 'content')).toBe('abc')
    expect(partialField('{"file_path":"a.js"', 'content')).toBeNull()
    expect(partialField('{"content":"x\\', 'content')).toBe('x') // cut in the middle of an escape
  })
  it('claude: text deltas and a file growing as the Write call streams in', () => {
    const p = makeClaudeParser('/work/p')
    const se = (event: object) => JSON.stringify({ type: 'stream_event', event })
    const big = 'x'.repeat(80)
    const ev = [
      ...p(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } })),
      ...p(se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu9', name: 'Write', input: {} } })),
      ...p(se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/work/p/src/a.js","content":"' } })),
      ...p(se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: big } })),
      ...p(se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: big + '"}' } })),
      ...p(se({ type: 'content_block_stop', index: 1 })),
    ]
    expect(ev[0]).toMatchObject({ type: 'delta', channel: 'text', text: 'Hi ' })
    const code = ev.filter((e) => e.type === 'code') as Extract<TeamEvent, { type: 'code' }>[]
    expect(code.map((c) => [c.path, c.text.length, c.done])).toEqual([['src/a.js', 80, false], ['src/a.js', 160, false], ['src/a.js', 160, true]])
  })
})

import { judgeClaudeAuth, judgeCodexAuth } from './health'
describe('plan-only sign-in', () => {
  it('accepts a Claude plan or ChatGPT sign-in and refuses API-key billing', () => {
    expect(judgeClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai"}').ok).toBe(true)
    expect(judgeClaudeAuth('{"loggedIn":true,"authMethod":"api_key"}')).toMatchObject({ ok: false, detail: expect.stringMatching(/bills per use/) })
    expect(judgeClaudeAuth('{"loggedIn":false,"authMethod":"none"}').ok).toBe(false)
    expect(judgeClaudeAuth('garbage').fix).toMatch(/claude auth login/)
    expect(judgeCodexAuth('Logged in using ChatGPT').ok).toBe(true)
    expect(judgeCodexAuth('Logged in using an API key')).toMatchObject({ ok: false, fix: expect.stringMatching(/ChatGPT/) })
    expect(judgeCodexAuth('Not logged in').ok).toBe(false)
  })
})

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ensureRepo } from './service'
describe('parsers survive hostile output', () => {
  const claude = makeClaudeParser('/p')
  const codex = makeCodexParser('/p')
  const junk = ['', 'null', '[]', '42', '"str"', '{}', '{"type":null}', '{"type":"assistant"}', '{"type":"assistant","message":null}', '{"type":"assistant","message":{"content":"text"}}', '{"type":"assistant","message":{"content":[null,1,{"type":"tool_use"}]}}', '{"type":"user","message":{"content":[{"type":"tool_result","content":{"a":1}}]}}', '{"type":"result","usage":null}', '{"type":"result","usage":{"input_tokens":"x"},"result":{"a":1}}', '{"type":"stream_event","event":null}', '{"type":"stream_event","event":{"type":"content_block_delta","index":9,"delta":{"type":"input_json_delta","partial_json":5}}}', '{"type":"item.started","item":null}', '{"type":"item.started","item":{"type":"file_change","changes":"nope"}}', '{"type":"item.completed","item":{"type":"command_execution","command":5}}', '{"type":"turn.failed","error":null}', '{"type":"turn.completed","usage":"x"}', '\u0000\u0001']
  it('never throws, whatever a line contains', () => {
    for (const l of junk) {
      expect(() => claude(l), l).not.toThrow()
      expect(() => codex(l), l).not.toThrow()
    }
  })
})
describe('safeParse and ensureRepo', () => {
  it('turns a parser that throws into no events', async () => {
    const { safeParse } = await import('./process')
    expect(safeParse(() => { throw new Error('boom') }, 'x')).toEqual([])
  })
  it('creates a repo in an empty folder and refuses a folder with files and no repo', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'forge-er-'))
    await ensureRepo(empty)
    expect(existsSync(join(empty, '.git'))).toBe(true)
    await ensureRepo(empty) // already a repo: fine
    const full = mkdtempSync(join(tmpdir(), 'forge-er-'))
    writeFileSync(join(full, 'a.txt'), 'x')
    await expect(ensureRepo(full)).rejects.toThrow(/git init/)
    void execFileSync
  })
  it('refuses a folder inside a larger repository and names the top folder', async () => {
    const top = mkdtempSync(join(tmpdir(), 'forge-er-'))
    execFileSync('git', ['init', '-q'], { cwd: top })
    const sub = join(top, 'app')
    mkdirSync(sub)
    writeFileSync(join(sub, 'a.txt'), 'x')
    await expect(ensureRepo(sub)).rejects.toThrow(/top folder of its git repository/)
    await ensureRepo(top)
  })
})
