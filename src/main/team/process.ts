import { spawn } from 'node:child_process'
import { killTree } from '../agent/commands'
import { classifyError, type AgentName, type ErrorKind, type Parser, type TeamEvent } from './events'

export type RunOpts = {
  cwd: string
  prompt: string
  signal?: AbortSignal
  onEvent?: (e: TeamEvent) => void
  idleMs?: number // no output for this long: the agent is stuck
  maxMs?: number // hard ceiling for the whole run
  env?: Record<string, string>
}
export type RunResult = {
  ok: boolean
  text: string
  sessionId?: string
  usage: { input: number; output: number; cached: number; costUsd: number }
  error?: { kind: ErrorKind; message: string }
  events: TeamEvent[]
}

// The agent CLIs must run as the user signed in with their own subscription. Variables that switch them to API billing
// (ANTHROPIC_API_KEY, OPENAI_API_KEY) or mark this process as a child of another Claude session would change that, so they are dropped.
const DROP = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_EFFORT|CLAUDE_PID|ANTHROPIC_.*|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|AI_AGENT)$/
export function cleanEnv(env: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!DROP.test(k)) out[k] = v
  return { ...out, ...extra }
}

// Runs one agent CLI to completion. The prompt goes in on stdin (no quoting problems, no argument length limit),
// every stdout line becomes normalised events, and the run is killed (whole process tree) when idle, too long, or aborted.
export function runCli(agent: AgentName, bin: string, args: string[], parse: Parser, o: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const events: TeamEvent[] = []
    const res: RunResult = { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events }
    let done = false
    let settled = false
    let tail = ''
    let buf = ''

    const push = (e: TeamEvent) => {
      events.push(e)
      if (e.type === 'session') res.sessionId = e.sessionId
      else if (e.type === 'usage') {
        res.usage.input += e.input
        res.usage.output += e.output
        res.usage.cached += e.cached
        res.usage.costUsd += e.costUsd ?? 0
      } else if (e.type === 'error') res.error ??= { kind: e.kind, message: e.message }
      else if (e.type === 'done') {
        done = true
        res.ok = e.ok && !res.error
        res.text = e.text
        res.sessionId = e.sessionId ?? res.sessionId
      }
      o.onEvent?.(e)
    }

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      clearTimeout(max)
      o.signal?.removeEventListener('abort', onAbort)
      resolve(res)
    }

    const child = spawn(bin, args, { cwd: o.cwd, env: cleanEnv(process.env, o.env), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    const stop = (kind: ErrorKind, message: string) => {
      if (!res.error) push({ type: 'error', agent, kind, message })
      killTree(child)
    }
    let idle = setTimeout(() => stop('timeout', `no output for ${Math.round((o.idleMs ?? 300_000) / 1000)}s`), o.idleMs ?? 300_000)
    const poke = () => {
      clearTimeout(idle)
      idle = setTimeout(() => stop('timeout', `no output for ${Math.round((o.idleMs ?? 300_000) / 1000)}s`), o.idleMs ?? 300_000)
    }
    const max = setTimeout(() => stop('timeout', `took longer than ${Math.round((o.maxMs ?? 1_800_000) / 60_000)} minutes`), o.maxMs ?? 1_800_000)
    const onAbort = () => stop('aborted', 'stopped by user')
    if (o.signal?.aborted) onAbort()
    else o.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (d: Buffer) => {
      poke()
      buf += d.toString()
      let i: number
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) for (const e of parse(line)) push(e)
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      poke()
      tail = (tail + d.toString()).slice(-2000)
    })
    child.stdin.on('error', () => {}) // the process may exit before reading its prompt
    child.stdin.end(o.prompt)

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (!res.error) push({ type: 'error', agent, kind: e.code === 'ENOENT' ? 'missing' : 'other', message: e.code === 'ENOENT' ? `${bin} is not installed or not on PATH` : e.message })
      if (!done) push({ type: 'done', agent, ok: false, text: '' })
      finish()
    })
    child.on('close', (code) => {
      if (buf.trim()) for (const e of parse(buf.trim())) push(e)
      if (code !== 0 && !res.error) push({ type: 'error', agent, kind: classifyError(tail), message: (tail.trim() || `exited with code ${code}`).slice(-500) })
      if (!done) push({ type: 'done', agent, ok: false, text: '' })
      finish()
    })
  })
}
