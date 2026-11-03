import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkClaude, checkCodex, codexModels } from '../main/team/health'
import { TeamOrchestrator } from '../main/team/orchestrator'
import { realRunner } from '../main/team/runner'
import type { AgentRunner } from '../main/team/orchestrator'
import { TeamStore } from '../main/team/store'
import type { RunEvent } from '../main/team/types'

// A whole team run on the real Codex CLI (Claude Code is not signed in on every machine, so the run uses the one agent that is):
// plan -> tasks in worktrees -> review -> merge -> checks -> final report -> apply.
// Uses your ChatGPT subscription (several agent runs). Run: TEAM_LIVE=1 npx vitest run --config vitest.eval.config.ts team-live
const LOG = 'eval-results/team-live.log'
mkdirSync('eval-results', { recursive: true })
writeFileSync(LOG, '')
const line = (s: string) => (console.log(s), appendFileSync(LOG, s + '\n'))
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

describe.skipIf(!process.env.TEAM_LIVE)('team live', () => {
  it('builds a small module end to end with Codex as the whole team', async () => {
    const codex = await checkCodex()
    expect(codex.ok).toBe(true)
    const both = process.env.TEAM_BOTH === '1'
    if (both) expect((await checkClaude()).ok).toBe(true)
    const proj = mkdtempSync(join(tmpdir(), 'forge-live-p-'))
    sh(proj, 'init', '-q')
    writeFileSync(join(proj, 'README.md'), '# demo\n')
    sh(proj, 'add', '-A')
    sh(proj, 'commit', '-q', '-m', 'init')
    const teamDir = mkdtempSync(join(tmpdir(), 'forge-live-t-'))
    const t0 = Date.now()
    const seen: Record<string, number> = {}
    const codeFinal: string[] = []
    const show = (e: RunEvent) => {
      if (e.type === 'agent') {
        const k = `${e.ev.agent}:${e.ev.type}${e.ev.type === 'delta' ? ':' + e.ev.channel : ''}`
        seen[k] = (seen[k] ?? 0) + 1
        if (e.ev.type === 'code' && e.ev.done) codeFinal.push(`${e.ev.agent} ${e.ev.path} (${e.ev.kind}, ${e.ev.text.length} chars)`)
      } else if (e.type === 'live') seen['live'] = (seen['live'] ?? 0) + 1
      const s = `[${Math.round((Date.now() - t0) / 1000)}s]`
      if (e.type === 'run') line(`${s} RUN ${e.status} ${e.reason ?? ''}`)
      else if (e.type === 'plan') line(`${s} PLAN ${e.summary}\n${e.tasks.map((t) => `      ${t.id} [${t.agent}] ${t.title} deps=${t.deps.join(',') || '-'}`).join('\n')}`)
      else if (e.type === 'task') line(`${s} TASK ${e.task.id} ${e.task.status}${e.task.phase ? '/' + e.task.phase : ''} ${e.task.error ?? ''}`)
      else if (e.type === 'message') line(`${s} MSG ${e.message.from}->${e.message.to} (${e.message.kind}): ${e.message.body.replace(/\s+/g, ' ').slice(0, 140)}`)
      else if (e.type === 'approval') line(`${s} APPROVAL ${e.approval.status} ${e.approval.kind}: ${e.approval.title}`)
      else if (e.type === 'verify') line(`${s} VERIFY ${e.ok ? 'PASS' : 'FAIL'} ${e.command}`)
      else if (e.type === 'agent' && e.ev.type === 'tool') line(`${s}   ${e.taskId}/${e.phase} ${e.ev.agent} ${e.ev.kind}: ${e.ev.summary.slice(0, 90)}`)
    }
    // TEAM_FORCE_REVIEW_FAIL=1: the reviewers get an extra requirement the authors were never told, so the first review must FAIL
    // and the author has to fix it from the reviewer's note: this exercises the review -> fix -> re-review loop with the real agents.
    const runner: AgentRunner = process.env.TEAM_FORCE_REVIEW_FAIL
      ? (a, o) => realRunner(a, /You are reviewing/.test(o.prompt) ? { ...o, prompt: o.prompt + '\n\nExtra requirement from the team lead for THIS review: every new source file must contain the exact comment line `// reviewed-by-forge`. If any new source file lacks it, the verdict MUST be FAIL and the issue must say which file lacks that line.' } : o)
      : realRunner
    const models = await codexModels()
    const orch = new TeamOrchestrator({
      store: new TeamStore(join(teamDir, 'runs')), teamDir, runner, available: async () => (both ? ['claude', 'codex'] : ['codex']), codexModels: async () => models, emit: show,
      mcpScript: resolve('out/main/team-mcp.js'),
    })
    try {
      const run = await orch.start(proj, process.env.TEAM_GOAL ?? 'Create slug.js exporting slugify(text) (lowercase, spaces and punctuation become single dashes, no leading/trailing dashes) and test.js that checks it with node:assert and exits non-zero on failure. Two small tasks: the module, then the tests.', { verify: 'node test.js', maxVerifyRounds: 1, maxFixRounds: 1, ...(process.env.TEAM_QUICK ? { review: 'off' as const, finalReview: false } : {}), codexMode: process.env.TEAM_CODEX_MODE === 'exec' ? 'exec' : 'app-server' })
      let r = orch.get(run.id)!
      for (let i = 0; i < 900 && !['awaiting_approval', 'failed', 'paused', 'cancelled'].includes(r.status); i++) {
        await new Promise((res) => setTimeout(res, 1000))
        r = orch.get(run.id)!
        const p = r.approvals.find((a) => a.status === 'pending' && a.kind !== 'final')
        if (p) orch.answerApproval(run.id, p.id, true, 'ok')
      }
      line(`\nSTREAM EVENT COUNTS: ${JSON.stringify(seen)}\nFINISHED CODE EVENTS: ${codeFinal.join('; ')}`)
      line(`\nFINAL STATUS: ${r.status} ${r.pausedReason ?? ''}`)
      line(`usage: codex runs=${r.usage.codex.runs} tokens=${r.usage.codex.input + r.usage.codex.output}; claude runs=${r.usage.claude.runs} tokens=${r.usage.claude.input + r.usage.claude.output} ~$${r.usage.claude.costUsd.toFixed(2)}`)
      expect(r.status).toBe('awaiting_approval')
      expect(r.final?.verifyOk).toBe(true)
      line('\n' + r.final!.report)
      line('agents: ' + r.tasks.map((t) => `${t.id}=${t.agent}(fixRounds ${t.fixRounds}, reviews ${t.reviews.map((v) => v.by + ':' + v.verdict).join(',')})`).join('  '))
      if (process.env.TEAM_FORCE_REVIEW_FAIL) expect(r.tasks.some((t) => t.fixRounds >= 1 && t.reviews.some((v) => v.verdict === 'fail') && t.reviews.at(-1)?.verdict === 'pass')).toBe(true)
      const applied = await orch.approveFinal(run.id)
      expect(applied.ok, applied.message).toBe(true)
      expect(existsSync(join(proj, 'slug.js'))).toBe(true)
      expect(readFileSync(join(proj, 'slug.js'), 'utf8')).toMatch(/slugify/)
      execFileSync('node', ['test.js'], { cwd: proj })
      expect(sh(proj, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
    } finally {
      orch.shutdown()
    }
  }, 900_000)
})
