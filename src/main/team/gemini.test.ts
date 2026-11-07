import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { geminiArgs, geminiPolicy, runGemini } from './gemini'
import { makeGeminiParser } from './geminiStream'
import { checkGemini, judgeGeminiAuth } from './health'
import type { TeamEvent } from './events'

const feed = (lines: object[]): TeamEvent[] => {
  const parse = makeGeminiParser()
  return lines.flatMap((l) => parse(JSON.stringify(l)))
}

describe('gemini stream', () => {
  const run = [
    { type: 'init', session_id: 'S1', model: 'gemini-2.5-pro' },
    { type: 'message', role: 'user', content: 'do it' },
    { type: 'message', role: 'assistant', content: 'Let me ', delta: true },
    { type: 'message', role: 'assistant', content: 'look.', delta: true },
    { type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'c1', parameters: { command: 'npm test' } },
    { type: 'tool_result', tool_id: 'c1', status: 'success', output: 'ok' },
    { type: 'tool_use', tool_name: 'write_file', tool_id: 'c2', parameters: { file_path: 'a.txt', content: 'x' } },
    { type: 'tool_result', tool_id: 'c2', status: 'error', error: { type: 'X', message: 'denied' } },
    { type: 'message', role: 'assistant', content: 'All done.', delta: true },
    { type: 'result', status: 'success', stats: { input_tokens: 120, output_tokens: 30, cached: 20, input: 100 } },
  ]
  it('turns a run into session, text, tool, usage and done events', () => {
    const ev = feed(run)
    expect(ev[0]).toEqual({ type: 'session', agent: 'gemini', sessionId: 'S1' })
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Let me look.', 'All done.'])
    expect(ev.filter((e) => e.type === 'tool').map((e) => [(e as { kind: string }).kind, (e as { summary: string }).summary])).toEqual([['command', 'npm test'], ['edit', 'a.txt']])
    expect(ev.filter((e) => e.type === 'tool_result').map((e) => (e as { ok: boolean }).ok)).toEqual([true, false])
    expect(ev.find((e) => e.type === 'usage')).toEqual({ type: 'usage', agent: 'gemini', input: 100, output: 30, cached: 20 })
    expect(ev.at(-1)).toEqual({ type: 'done', agent: 'gemini', ok: true, text: 'All done.' })
  })
  it('reports a failed run as an error and a failed done, classified', () => {
    const ev = feed([{ type: 'init', session_id: 'S2' }, { type: 'result', status: 'error', error: { type: 'Error', message: 'Quota exceeded for this plan' }, stats: {} }])
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ kind: 'limit' })
    expect(ev.at(-1)).toMatchObject({ type: 'done', ok: false })
  })
  it('ignores lines it does not know', () => {
    expect(makeGeminiParser()('not json')).toEqual([])
    expect(feed([{ type: 'something_new' }])).toEqual([])
  })
})

describe('gemini args', () => {
  it('reads the prompt from stdin in headless stream mode', () => {
    expect(geminiArgs({ cwd: '.', prompt: 'x', write: true, model: 'gemini-2.5-pro' }, '/p.toml')).toEqual(['-p', ' ', '-o', 'stream-json', '--skip-trust', '--approval-mode', 'auto_edit', '-m', 'gemini-2.5-pro', '--policy', '/p.toml'])
  })
  it('is read-only (plan mode) without write, and takes no policy', () => {
    const a = geminiArgs({ cwd: '.', prompt: 'x', write: false }, '/p.toml')
    expect(a).toContain('plan')
    expect(a).not.toContain('--policy')
    expect(a).not.toContain('-m')
  })
  it('allows build commands and refuses push, sudo and deploys', () => {
    const p = geminiPolicy()
    expect(p).toMatch(/commandPrefix = \[[^\]]*"npm test"/)
    expect(p).toMatch(/decision = "deny"/)
    expect(p).toMatch(/"git push"/)
  })
})

describe('gemini sign-in check', () => {
  it('needs a Google login and refuses API-key billing', () => {
    expect(judgeGeminiAuth(true).ok).toBe(true)
    expect(judgeGeminiAuth(true, 'oauth-personal').ok).toBe(true)
    expect(judgeGeminiAuth(false).ok).toBe(false)
    expect(judgeGeminiAuth(true, 'gemini-api-key').ok).toBe(false)
    expect(judgeGeminiAuth(true, 'vertex-ai').ok).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('gemini, as started', () => {
  const fake = (home: string) => {
    const f = join(home, 'gemini')
    writeFileSync(f, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('0.67.0');process.exit(0)}\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=(m)=>console.log(JSON.stringify(m));o({type:'init',session_id:'G1'});o({type:'message',role:'assistant',content:JSON.stringify({argv:process.argv.slice(2),stdin:s,key:process.env.GEMINI_API_KEY??null})});o({type:'result',status:'success',stats:{input_tokens:1,output_tokens:1,cached:0}})})\n`)
    chmodSync(f, 0o755)
    return f
  }
  it('sends the prompt on stdin and drops an API key from the environment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-gem-'))
    process.env.GEMINI_API_KEY = 'key-should-not-reach-the-agent'
    try {
      const r = await runGemini({ cwd: home, prompt: 'do the thing\nnow', write: true }, fake(home))
      const seen = JSON.parse(r.text)
      expect(r.ok).toBe(true)
      expect(r.sessionId).toBe('G1')
      expect(seen.stdin).toBe('do the thing\nnow')
      expect(seen.argv).toEqual(expect.arrayContaining(['-p', '-o', 'stream-json', '--approval-mode', 'auto_edit']))
      expect(seen.key).toBeNull()
    } finally {
      delete process.env.GEMINI_API_KEY
    }
  })
  it('is ready when the CLI exists and a Google login is saved in ~/.gemini', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-gem-'))
    const bin = fake(home)
    expect((await checkGemini(bin, home)).ok).toBe(false)
    mkdirSync(join(home, '.gemini'))
    writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{}')
    const h = await checkGemini(bin, home)
    expect(h).toMatchObject({ agent: 'gemini', ok: true, version: '0.67.0' })
    expect((await checkGemini(join(home, 'nope'), home)).detail).toMatch(/not installed/)
  })
})
