import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeArgs, runClaude } from './claude'
import { codexArgs, runCodex } from './codex'
import type { TeamEvent } from './events'
import type { TeamLink } from './link'
import { judgeCodexAuth } from './health'

// The adapters run against stand-in binaries that report back exactly how they were started: arguments, environment and prompt.
const bin = (name: string, body: string) => {
  const d = mkdtempSync(join(tmpdir(), 'forge-fake-bin-'))
  const f = join(d, name)
  writeFileSync(f, `#!${process.execPath}\nlet stdin='';process.stdin.on('data',d=>stdin+=d).on('end',()=>{const out=(m)=>console.log(JSON.stringify(m));const env=process.env;const argv=process.argv.slice(2);\n${body}\n})`)
  chmodSync(f, 0o755)
  return f
}
const link: TeamLink = { sock: '/tmp/x.sock', token: 'tok', runId: 'r1', taskId: 't1', agent: 'claude', script: '/app/team-mcp.js', node: '/app/forge' }

// stand-in binaries are shebang scripts: POSIX only
describe.skipIf(process.platform === 'win32')('claude adapter, as started', () => {
  const fake = bin('claude', `
    out({type:'system',subtype:'init',session_id:'S1'});
    out({type:'result',is_error:false,session_id:'S1',result:JSON.stringify({argv,stdin,key:env.ANTHROPIC_API_KEY??null,nested:env.CLAUDECODE??null,fromLink:env.FORGE_TEAM_SOCK??null,electron:env.ELECTRON_RUN_AS_NODE??null,timeout:env.MCP_TOOL_TIMEOUT??null}),usage:{}});`)
  it('sends the prompt on stdin, in print/stream mode, without personal settings, and with the subscription environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-reach-the-agent'
    process.env.CLAUDECODE = '1'
    try {
      const r = await runClaude({ cwd: process.cwd(), prompt: 'do "the" thing\nnow', write: true, resume: 'OLD', effort: 'high', model: 'm1' }, fake)
      const seen = JSON.parse(r.text)
      expect(seen.stdin).toBe('do "the" thing\nnow')
      expect(seen.argv).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--include-partial-messages', '--setting-sources', 'project,local', '--resume', 'OLD', '--effort', 'high', '--model', 'm1', '--permission-mode', 'acceptEdits']))
      expect(seen.key).toBeNull() // an API key in the environment never reaches the agent, so it cannot switch to API billing
      expect(seen.nested).toBeNull()
      expect(r.sessionId).toBe('S1')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDECODE
    }
  })
  it('read-only runs use plan mode and no allow list; with the team link the permission tool and MCP server are attached', async () => {
    const ro = JSON.parse((await runClaude({ cwd: process.cwd(), prompt: 'x', write: false }, fake)).text)
    expect(ro.argv).toContain('plan')
    expect(ro.argv).not.toContain('--allowedTools')
    const cfg = join(mkdtempSync(join(tmpdir(), 'forge-cfg-')), 'mcp.json')
    writeFileSync(cfg, '{}')
    const t = JSON.parse((await runClaude({ cwd: process.cwd(), prompt: 'x', write: true, team: link, mcpConfig: cfg }, fake)).text)
    expect(t.argv).toEqual(expect.arrayContaining(['--permission-prompt-tool', 'mcp__forge_team__team_permission', '--mcp-config', cfg, '--strict-mcp-config']))
    expect(t.argv[t.argv.indexOf('--allowedTools') + 1]).toContain('mcp__forge_team')
    // the hub token and ELECTRON_RUN_AS_NODE live in the MCP server's own config; in Claude's environment every command it runs would inherit them
    expect(t.fromLink).toBeNull()
    expect(t.electron).toBeNull()
    expect(t.argv[t.argv.indexOf('--allowedTools') + 1]).not.toMatch(/Bash\((npm|npx|node|python3|cat) \*\)/) // deploys etc. must reach the policy
    expect(Number(t.timeout)).toBeGreaterThan(3_600_000) // an approval can wait for a person
  })
})

describe.skipIf(process.platform === 'win32')('codex adapter, as started', () => {
  it('exec: pins the model, reads the prompt from stdin, attaches the team server and the lean tool set', async () => {
    const fake = bin('codex', `
      out({type:'thread.started',thread_id:'T9'});
      out({type:'item.completed',item:{id:'i',type:'agent_message',text:JSON.stringify({argv,stdin,key:env.OPENAI_API_KEY??null})}});
      out({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});`)
    process.env.OPENAI_API_KEY = 'sk-nope'
    try {
      const evs: TeamEvent[] = []
      const r = await runCodex({ cwd: process.cwd(), prompt: 'hello', write: true, model: 'gpt-5.6-luna', team: { ...link, agent: 'codex' }, onEvent: (e) => evs.push(e) }, fake)
      const seen = JSON.parse(r.text)
      expect(seen.stdin).toBe('hello')
      expect(seen.key).toBeNull()
      expect(seen.argv.slice(0, 2)).toEqual(['exec', '--json'])
      expect(seen.argv).toEqual(expect.arrayContaining(['-m', 'gpt-5.6-luna', '-s', 'workspace-write', '--disable', 'computer_use', '-']))
      expect(seen.argv.join(' ')).toContain('mcp_servers.forge_team.command="/app/forge"')
      expect(seen.argv.join(' ')).toContain('default_tools_approval_mode="approve"')
      expect(r.sessionId).toBe('T9')
    } finally {
      delete process.env.OPENAI_API_KEY
    }
  })
  it('exec resume: continues the saved thread', async () => {
    const fake = bin('codex', `out({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(argv)}});out({type:'turn.completed',usage:{}});`)
    const r = await runCodex({ cwd: process.cwd(), prompt: 'again', write: false, model: 'm', resume: 'T9' }, fake)
    expect(JSON.parse(r.text).slice(0, 3)).toEqual(['exec', 'resume', 'T9'])
    expect(readFileSync(fake, 'utf8')).toBeTruthy()
  })
})

describe.skipIf(process.platform === 'win32')('runner fixes', () => {
  it('claude: folders added with --add-dir are readable but not writable in a build run', () => {
    const dirs = ['/home/u/skills', '/home/u/proj/.forge']
    const w = claudeArgs({ cwd: '/p', prompt: 'x', write: true, addDirs: dirs })
    const deny = w[w.indexOf('--disallowedTools') + 1]
    for (const d of dirs) for (const tool of ['Edit', 'Write', 'NotebookEdit']) expect(deny).toContain(`${tool}(/${d}/**)`)
    expect(w).toContain('--add-dir')
  })
  it('claude: a project setting that switches billing stops the run before any request', async () => {
    for (const init of [{ apiKeySource: 'ANTHROPIC_API_KEY' }, { apiKeySource: 'apiKeyHelper' }, { apiKeySource: 'none', model: 'us.anthropic.claude-opus-5-5' }]) {
      const fake = bin('claude', `out({type:'system',subtype:'init',session_id:'S1',...${JSON.stringify(init)}}); setInterval(()=>{},1000);`)
      const t = Date.now()
      const r = await runClaude({ cwd: process.cwd(), prompt: 'x', write: true }, fake)
      expect(r).toMatchObject({ ok: false, error: { kind: 'auth' } })
      expect(r.error?.message).toMatch(/settings/)
      expect(Date.now() - t).toBeLessThan(5000)
    }
    const ok = bin('claude', `out({type:'system',subtype:'init',session_id:'S1',apiKeySource:'none',model:'claude-opus-5-5'}); out({type:'result',is_error:false,result:'fine',usage:{}});`)
    expect((await runClaude({ cwd: process.cwd(), prompt: 'x', write: true }, ok)).ok).toBe(true)
  })
  it('codex: Web research off disables the web tool explicitly', () => {
    expect(codexArgs({ cwd: '/p', prompt: 'x', write: true, model: 'm', web: false })).toEqual(expect.arrayContaining(['web_search="disabled"']))
    expect(codexArgs({ cwd: '/p', prompt: 'x', write: false, model: 'm', web: false, resume: 'T' })).toEqual(expect.arrayContaining(['web_search="disabled"']))
    expect(codexArgs({ cwd: '/p', prompt: 'x', write: true, model: 'm', web: true }).join(' ')).not.toContain('disabled')
  })
  it('codex sign-in check reads every line, not just the first', () => {
    const warn = 'WARNING: proceeding, even though we could not create PATH aliases: x\n'
    expect(judgeCodexAuth(warn + 'Logged in using an API key - sk-proj-***ABCD').ok).toBe(false)
    expect(judgeCodexAuth(warn + 'Logged in using ChatGPT').ok).toBe(true)
    expect(judgeCodexAuth(warn + 'Not logged in').ok).toBe(false)
  })
})
