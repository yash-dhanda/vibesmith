import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectVerify, runVerify } from '../main/agent/commands'
import { buildProvider, type CloudProvider } from '../main/agent/factory'
import { runAgent, SYSTEM_PROMPT, type AgentEvent } from '../main/agent/loop'
import type { Message } from '../main/agent/provider'
import { ToolBox } from '../main/agent/tools'
import { setRoot } from '../main/project'
import { TASKS } from './tasks'

// Scores a model on the real agent loop: `EVAL_MODEL=ollama:qwen3:8b npm run eval`
// Cloud keys come from your shell (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY), never from the app's keychain.
const MODEL = process.env.EVAL_MODEL ?? 'ollama:qwen3:8b'
const ONLY = process.env.EVAL_ONLY?.split(',')
const ENV_KEYS: Record<CloudProvider, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' }

type Result = { task: string; pass: boolean; reason: string; steps: number; seconds: number; stop: string }

describe(`eval ${MODEL}`, () => {
  it('runs every task', async () => {
    const provider = buildProvider(MODEL, (p) => process.env[ENV_KEYS[p]] ?? null)
    const results: Result[] = []

    for (const task of TASKS.filter((t) => !ONLY || ONLY.includes(t.name))) {
      const dir = mkdtempSync(join(tmpdir(), 'forge-eval-'))
      for (const [f, text] of Object.entries(task.files)) {
        mkdirSync(dirname(join(dir, f)), { recursive: true })
        writeFileSync(join(dir, f), text)
      }
      setRoot(dir)
      const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: task.goal }]
      const events: AgentEvent[] = []
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 240_000)
      const verifyCmd = detectVerify(dir) // same default the app uses
      const t0 = Date.now()
      await runAgent({
        messages, provider, tools: new ToolBox(dir), mode: 'full-auto', maxSteps: 25,
        emit: (e) => events.push(e), approve: async () => true, signal: ctl.signal,
        verify: verifyCmd ? () => runVerify(verifyCmd, dir, ctl.signal) : undefined,
      })
      clearTimeout(timer)
      const end = events.at(-1)
      const stop = end?.type === 'done' ? end.reason : end?.type === 'error' ? `error: ${end.message.slice(0, 60)}` : 'no end'
      const reason = task.check(dir)
      const r: Result = { task: task.name, pass: reason === null, reason: reason ?? '', steps: end?.type === 'done' ? end.steps : 0, seconds: Math.round((Date.now() - t0) / 1000), stop }
      results.push(r)
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.task.padEnd(22)} ${String(r.steps).padStart(2)} steps ${String(r.seconds).padStart(3)}s  ${r.stop}${r.pass ? '' : '  -> ' + r.reason}`)
    }

    const passed = results.filter((r) => r.pass).length
    console.log(`\n${MODEL}: ${passed}/${results.length} passed, ${results.reduce((n, r) => n + r.seconds, 0)}s total`)
    mkdirSync('eval-results', { recursive: true })
    writeFileSync(join('eval-results', `${MODEL.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`), JSON.stringify({ model: MODEL, passed, total: results.length, results }, null, 2))
    expect(results.length).toBeGreaterThan(0)
  }, 3_600_000)
})
