import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { geminiArgs, geminiInput, geminiSettings, runGemini } from './gemini'
import { makeGeminiParser } from './geminiStream'
import { checkGemini, judgeAgy } from './health'
import type { TeamEvent } from './events'

const feed = (lines: object[]): TeamEvent[] => {
  const parse = makeGeminiParser()
  return lines.flatMap((l) => parse(JSON.stringify(l)))
}
const step = (o: object) => ({ event: 'step_update', step_update: { conversation_id: 'C1', ...o } })

describe('agy stream (shapes from the Antigravity CLI headless docs)', () => {
  const run = [
    { event: 'init', conversation_id: 'C1', init: { cwd: '/p', tools: ['run_command'], permission_mode: 'request-review' } },
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Let me ' }),
    step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'look.' }),
    step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test' } } }),
    step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test' }, output: 'ok\r\n' } }),
    step({ step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: '/p/a.txt' }, error: { type: 'DENIED', message: 'denied' } } }),
    step({ step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'All done.\n' }),
    step({ step_index: 5, state: 'DONE', step_type: 'checkpoint' }),
    { event: 'result', result: { conversation_id: 'C1', status: 'SUCCESS', response: 'All done.\n', usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 20, total_tokens: 150 } } },
  ]
  it('turns a run into session, text, tool, usage and done events', () => {
    const ev = feed(run)
    expect(ev[0]).toEqual({ type: 'session', agent: 'gemini', sessionId: 'C1' })
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Let me look.', 'All done.\n'])
    expect(ev.filter((e) => e.type === 'tool').map((e) => [(e as { kind: string }).kind, (e as { summary: string }).summary])).toEqual([['command', 'npm test'], ['edit', '/p/a.txt']]) // the command is announced once, not again when it finishes
    expect(ev.filter((e) => e.type === 'tool_result').map((e) => (e as { ok: boolean }).ok)).toEqual([true, false])
    expect(ev.find((e) => e.type === 'usage')).toEqual({ type: 'usage', agent: 'gemini', input: 100, output: 30, cached: 20 })
    expect(ev.at(-1)).toEqual({ type: 'done', agent: 'gemini', ok: true, text: 'All done.' })
  })
  it('reports a failed run as a classified error and a failed done', () => {
    const ev = feed([{ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', usage: {} } }])
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ kind: 'auth' })
    expect(ev.at(-1)).toMatchObject({ type: 'done', ok: false })
  })
  it('ignores lines it does not know', () => {
    expect(makeGeminiParser()('not json')).toEqual([])
    expect(feed([{ event: 'something_new' }])).toEqual([])
  })
})

describe('agy stream, captured from a real agy 1.5.3 run', () => {
  const real = [
    '{"event":"init","conversation_id":"E0","init":{"cwd":"/p","tools":["write_file","run_command"],"permission_mode":"request-review"}}',
    '{"event":"step_update","step_update":{"conversation_id":"E0","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":4.7,"usage":{"input_tokens":6950,"output_tokens":202,"thinking_tokens":159,"cache_read_tokens":0,"total_tokens":7152}}}',
    '{"event":"step_update","step_update":{"conversation_id":"E0","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_file","tool_info":{"name":"write_file","parameters":{"Path":"/p/hello.js"}}}}',
    '{"event":"step_update","step_update":{"conversation_id":"E0","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_file","tool_info":{"name":"write_file","parameters":{"Path":"/p/hello.js"}}}}',
    '{"event":"step_update","step_update":{"conversation_id":"E0","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"node hello.js"}}}}',
    '{"event":"step_update","step_update":{"conversation_id":"E0","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"node hello.js"},"output":"Command exited with code 0.\\n\\nCommand output:\\nhi\\r\\n"}}}',
    '{"event":"step_update","step_update":{"conversation_id":"E0","step_index":5,"state":"ACTIVE","step_type":"agent_response","text_delta":"Created hello."}}',
    '{"event":"step_update","step_update":{"conversation_id":"E0","step_index":5,"state":"DONE","step_type":"agent_response","text_delta":"js.\\n","usage":{"input_tokens":7362,"output_tokens":159,"thinking_tokens":124,"cache_read_tokens":0,"total_tokens":7521}}}',
    '{"event":"result","result":{"conversation_id":"E0","status":"SUCCESS","response":"Created hello.js.\\n","num_turns":1,"usage":{"input_tokens":21540,"output_tokens":408,"thinking_tokens":291,"cache_read_tokens":0,"total_tokens":21948}}}',
  ]
  it('reads a write, a command and the closing answer', () => {
    const parse = makeGeminiParser()
    const ev = real.flatMap((l) => parse(l))
    expect(ev.filter((e) => e.type === 'tool').map((e) => [(e as { kind: string }).kind, (e as { summary: string }).summary])).toEqual([['edit', '/p/hello.js'], ['command', 'node hello.js']])
    expect(ev.filter((e) => e.type === 'tool_result').map((e) => (e as { ok: boolean }).ok)).toEqual([true, true])
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Created hello.js.\n'])
    expect(ev.at(-1)).toEqual({ type: 'done', agent: 'gemini', ok: true, text: 'Created hello.js.' })
  })
})

describe('agy args', () => {
  it('reads the prompt from stdin as one stream-json message', () => {
    expect(JSON.parse(geminiInput('do "it"\nnow'))).toEqual({ event: 'user', message: { content: 'do "it"\nnow' } })
    expect(geminiInput('x').endsWith('\n')).toBe(true)
  })
  it('takes the model and the conversation to resume, and leaves them out otherwise', () => {
    const w = geminiArgs({ cwd: '.', prompt: 'x', write: true, model: 'm1', resume: 'C0' })
    expect(w).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'accept-edits', '--model', 'm1', '--conversation', 'C0']))
    const r = geminiArgs({ cwd: '.', prompt: 'x', write: false })
    expect(r).not.toContain('--model')
    expect(r).not.toContain('--conversation')
  })
  it('allows build commands and denies push, sudo and deploys, for this session only', () => {
    const s = JSON.parse(geminiSettings(true))
    expect(s.permissions.allow).toContain('command(npm test)')
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['command(git push)', 'command(sudo)', 'command(npm publish)']))
    expect(s.permissions.deny).not.toContain('write_file(*)')
    const ro = JSON.parse(geminiSettings(false)).permissions // reviews and research: no file writes at all, and only read commands
    expect(ro.deny).toContain('write_file(*)')
    expect(ro.allow).not.toContain('command(npm install)')
  })
})

describe('agy sign-in check', () => {
  it('is signed in when the model list comes back, and says to sign in otherwise', () => {
    const ok = judgeAgy('Fetching available models...\ngemini-3.8-flash-medium  Gemini Flash\n- gemini-3.1-pro-high\n', true)
    expect(ok).toMatchObject({ ok: true, models: ['gemini-3.8-flash-medium', 'gemini-3.1-pro-high'] })
    expect(judgeAgy('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.', false).ok).toBe(false)
    expect(judgeAgy('Please sign in to view available models', true).ok).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('agy, as started', () => {
  const fake = (home: string, signedIn = true) => {
    const f = join(home, 'agy')
    writeFileSync(
      f,
      `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='--version'){console.log('1.5.3');process.exit(0)}\nif(a[0]==='models'){${signedIn ? "console.log('Fetching available models...\\ngemini-3.8-flash-medium');process.exit(0)" : "console.error('Error: Please sign in to view available models.');process.exit(1)"}}\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=(m)=>console.log(JSON.stringify(m));o({event:'init',conversation_id:'G1'});o({event:'result',result:{status:'SUCCESS',response:JSON.stringify({argv:a,stdin:s,key:process.env.GEMINI_API_KEY??null}),usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0}}})})\n`,
    )
    chmodSync(f, 0o755)
    return f
  }
  it('sends the prompt on stdin and drops an API key from the environment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-agy-'))
    process.env.GEMINI_API_KEY = 'key-should-not-reach-the-agent'
    try {
      const r = await runGemini({ cwd: home, prompt: 'do the thing\nnow', write: true }, fake(home))
      const seen = JSON.parse(r.text)
      expect(r.ok).toBe(true)
      expect(r.sessionId).toBe('G1')
      expect(JSON.parse(seen.stdin).message.content).toBe('do the thing\nnow')
      expect(seen.argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--mode', 'accept-edits']))
      expect(seen.key).toBeNull()
    } finally {
      delete process.env.GEMINI_API_KEY
    }
  })
  it('is ready when signed in (with its models), and says what to do when not installed or not signed in', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-agy-'))
    expect(await checkGemini(fake(home))).toMatchObject({ agent: 'gemini', ok: true, version: '1.5.3', models: ['gemini-3.8-flash-medium'] })
    expect((await checkGemini(fake(mkdtempSync(join(tmpdir(), 'forge-agy-')), false))).detail).toMatch(/not signed in/)
    expect((await checkGemini(join(home, 'nope'))).detail).toMatch(/not installed/)
  })
})
