import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runClaude } from '../main/team/claude'
import { runCodex } from '../main/team/codex'
import type { TeamEvent } from '../main/team/events'
import { checkTeamTools, codexModels } from '../main/team/health'
import { TeamHub } from '../main/team/hub'
import { resolve } from 'node:path'

// Phase 0 of team mode: drive the real Claude Code and Codex CLIs through Forge's adapters and print one normalised timeline.
// Uses your signed-in subscriptions (a few thousand tokens). Run: TEAM_SPIKE=1 npx vitest run --config vitest.eval.config.ts team-spike
const LOG = 'eval-results/team-spike.log'
mkdirSync('eval-results', { recursive: true })
writeFileSync(LOG, '')
const line = (s: string) => {
  console.log(s)
  appendFileSync(LOG, s + '\n')
}
const show = (e: TeamEvent) => {
  const t = e.type
  if (t === 'text') line(`  [${e.agent}] says: ${e.text.replace(/\s+/g, ' ').slice(0, 140)}`)
  else if (t === 'tool') line(`  [${e.agent}] ${e.kind}: ${e.summary}`)
  else if (t === 'tool_result') line(`  [${e.agent}]   -> ${e.ok ? 'ok' : 'FAILED'} ${e.text.replace(/\s+/g, ' ').slice(0, 80)}`)
  else if (t === 'usage') line(`  [${e.agent}] tokens in=${e.input} (cached ${e.cached}) out=${e.output}${e.costUsd ? ` ~$${e.costUsd.toFixed(4)}` : ''}`)
  else if (t === 'note') line(`  [${e.agent}] note: ${e.text}`)
  else if (t === 'error') line(`  [${e.agent}] ERROR(${e.kind}): ${e.message}`)
  else if (t === 'done') line(`  [${e.agent}] done ok=${e.ok}`)
}

describe.skipIf(!process.env.TEAM_SPIKE)('team spike', () => {
  it('runs one Codex task, resumes it, and has Claude review the result', async () => {
    const [claude, codex] = await checkTeamTools()
    for (const h of [claude, codex]) line(`${h.agent}: ${h.ok ? 'OK' : 'NOT READY'} ${h.version ?? ''} ${h.detail}${h.fix ? `  FIX: ${h.fix}` : ''}`)
    expect(codex.ok).toBe(true)

    const models = await codexModels()
    line(`codex models for this account: ${models.join(', ')}`)
    const model = process.env.TEAM_CODEX_MODEL ?? models.find((m) => /luna/.test(m)) ?? models[0]
    line(`using codex model: ${model}`)

    const dir = mkdtempSync(join(tmpdir(), 'forge-team-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@l', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@l' } })

    line('\n== task 1: Codex builds (workspace-write) ==')
    const built = await runCodex({ cwd: dir, model, write: true, onEvent: show, prompt: "Create greet.js exporting greet(name) that returns 'Hello, ' + name + '!'. Create check.js that requires greet.js and asserts greet('Ada') === 'Hello, Ada!'. Run node check.js. Reply with one sentence." })
    expect(built.error).toBeUndefined()
    expect(built.ok).toBe(true)
    expect(existsSync(join(dir, 'greet.js'))).toBe(true)
    expect(built.sessionId).toBeTruthy()

    line('\n== task 2: Codex resumes its own thread ==')
    const again = await runCodex({ cwd: dir, model, write: false, resume: built.sessionId, onEvent: show, prompt: 'Which two files did you create? Names only.' })
    expect(again.ok).toBe(true)
    expect(again.text).toMatch(/greet\.js/)

    line('\n== task 3: Claude reviews (plan mode, read-only) ==')
    if (!claude.ok) {
      line(`SKIPPED: ${claude.detail} ${claude.fix ?? ''}`)
      return
    }
    const review = await runClaude({ cwd: dir, write: false, onEvent: show, prompt: 'Review greet.js and check.js in this folder. Reply with PASS or FAIL and one sentence why. Do not change anything.' })
    expect(review.ok, review.error?.message).toBe(true)
    line(`\nreview verdict: ${review.text.replace(/\s+/g, ' ').slice(0, 200)}`)
  })

  it('Codex reaches the team MCP server: inbox, post, handoff, approval', async () => {
    const calls: { op: string; args: any; agent: string }[] = []
    const hub = new TeamHub(async (op, args, ctx) => {
      calls.push({ op, args, agent: ctx.agent })
      if (op === 'inbox') return [{ from: 'claude', kind: 'finding', body: 'the secret word is TANGERINE' }]
      if (op === 'request_approval') return 'allowed'
      return 'ok'
    })
    const sock = await hub.start()
    const models = await codexModels()
    const model = process.env.TEAM_CODEX_MODEL ?? models.find((m) => /luna/.test(m)) ?? models[0]
    const dir = mkdtempSync(join(tmpdir(), 'forge-team-mcp-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const link = { sock, token: hub.token, runId: 'r1', taskId: 't1', agent: 'codex' as const, script: resolve('out/main/team-mcp.js'), node: process.execPath }
    line('\n== codex + team MCP server ==')
    const r = await runCodex({ cwd: dir, model, write: true, team: link, onEvent: show, prompt: 'Use your forge_team tools: 1) call team_inbox and read it; 2) call team_post to "claude" with kind "finding" and a body that repeats the secret word from the inbox; 3) call team_request_approval with title "deploy test"; 4) call team_handoff with notes "done"; then reply with the secret word.' })
    hub.stop()
    line(`hub saw: ${calls.map((c) => c.op).join(', ')}`)
    expect(r.ok, r.error?.message).toBe(true)
    expect(calls.map((c) => c.op)).toEqual(expect.arrayContaining(['inbox', 'post', 'request_approval', 'handoff']))
    expect(calls.every((c) => c.agent === 'codex')).toBe(true)
    expect(r.text).toMatch(/TANGERINE/i)
  })
})
