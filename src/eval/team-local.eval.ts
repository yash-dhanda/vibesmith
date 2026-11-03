import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLocal, localModels } from '../main/team/health'
import { TeamOrchestrator } from '../main/team/orchestrator'
import { realRunner } from '../main/team/runner'
import { TeamStore } from '../main/team/store'
import type { RunEvent } from '../main/team/types'

// A whole team run on the local Ollama model alone: plan -> task in a worktree -> review -> merge -> checks -> apply. Free: no subscription is used.
// Run: TEAM_LOCAL=1 npx vitest run --config vitest.eval.config.ts team-local   (TEAM_LOCAL_MODEL=name picks the model)
const LOG = 'eval-results/team-local.log'
mkdirSync('eval-results', { recursive: true })
writeFileSync(LOG, '')
const line = (s: string) => (console.log(s), appendFileSync(LOG, s + '\n'))
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

describe.skipIf(!process.env.TEAM_LOCAL)('team local', () => {
  it('builds a small module with the local model as the whole team', async () => {
    expect((await checkLocal()).ok).toBe(true)
    const models = process.env.TEAM_LOCAL_MODEL ? [process.env.TEAM_LOCAL_MODEL] : await localModels()
    line(`model: ${models[0]}`)
    const proj = mkdtempSync(join(tmpdir(), 'forge-local-p-'))
    sh(proj, 'init', '-q')
    writeFileSync(join(proj, 'README.md'), '# demo\n')
    sh(proj, 'add', '-A')
    sh(proj, 'commit', '-q', '-m', 'init')
    const teamDir = mkdtempSync(join(tmpdir(), 'forge-local-t-'))
    const t0 = Date.now()
    const show = (e: RunEvent) => {
      const s = `[${Math.round((Date.now() - t0) / 1000)}s]`
      if (e.type === 'run') line(`${s} RUN ${e.status} ${e.reason ?? ''}`)
      else if (e.type === 'plan') line(`${s} PLAN ${e.summary}\n${e.tasks.map((t) => `      ${t.id} [${t.agent}] ${t.title}`).join('\n')}`)
      else if (e.type === 'task') line(`${s} TASK ${e.task.id} ${e.task.status}${e.task.phase ? '/' + e.task.phase : ''} ${e.task.error ?? ''}`)
      else if (e.type === 'message') line(`${s} MSG ${e.message.from}->${e.message.to} (${e.message.kind}): ${e.message.body.replace(/\s+/g, ' ').slice(0, 140)}`)
      else if (e.type === 'verify') line(`${s} VERIFY ${e.ok ? 'PASS' : 'FAIL'} ${e.command}`)
      else if (e.type === 'agent' && e.ev.type === 'tool') line(`${s}   ${e.taskId}/${e.phase} ${e.ev.kind}: ${e.ev.summary.slice(0, 90)}`)
      else if (e.type === 'agent' && e.ev.type === 'error') line(`${s}   ERROR ${e.ev.message}`)
    }
    const orch = new TeamOrchestrator({ store: new TeamStore(join(teamDir, 'runs')), teamDir, runner: realRunner, available: async () => ['local'], codexModels: async () => [], localModels: async () => models, emit: show })
    try {
      const run = await orch.start(proj, process.env.TEAM_GOAL ?? 'Create slug.js exporting slugify(text) (lowercase, spaces and punctuation become single dashes, no leading or trailing dashes) with module.exports, and test.js that checks it with node:assert and exits non-zero on failure.', { finalReview: false, verify: 'node test.js' })
      let r = orch.get(run.id)!
      for (let i = 0; i < 1500 && !['awaiting_approval', 'failed', 'cancelled', 'paused'].includes(r.status); i++) {
        await new Promise((res) => setTimeout(res, 1000))
        r = orch.get(run.id)!
        const p = r.approvals.find((a) => a.status === 'pending' && a.kind !== 'final')
        if (p) orch.answerApproval(run.id, p.id, true, 'ok')
      }
      line(`\nFINAL STATUS: ${r.status} ${r.pausedReason ?? ''}`)
      line(`local runs=${r.usage.local?.runs} tokens=${(r.usage.local?.input ?? 0) + (r.usage.local?.output ?? 0)}`)
      line('agents: ' + r.tasks.map((t) => `${t.id}=${t.agent}(fixRounds ${t.fixRounds}, reviews ${t.reviews.map((v) => v.by + ':' + v.verdict).join(',')})`).join('  '))
      expect(r.status).toBe('awaiting_approval')
      const applied = await orch.approveFinal(run.id)
      expect(applied.ok, applied.message).toBe(true)
      expect(existsSync(join(proj, 'slug.js'))).toBe(true)
      execFileSync('node', ['test.js'], { cwd: proj })
      line('PROJECT FILES: ' + sh(proj, 'status', '--short').replace(/\n/g, ' | '))
    } finally {
      orch.shutdown()
    }
  }, 1_500_000)
})
