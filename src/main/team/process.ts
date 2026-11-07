import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { killTree } from '../agent/commands'
import { resolveCommand } from './bin'
import { classifyError, type AgentName, type ErrorKind, type Parser, type TeamEvent } from './events'

export type RunOpts = {
  cwd: string
  prompt: string
  signal?: AbortSignal
  onEvent?: (e: TeamEvent) => void
  idleMs?: number // no output for this long: the agent is stuck
  maxMs?: number // hard ceiling for the whole run
  hold?: () => boolean // true while something is waiting on the agent's behalf (an approval or question for the user): the idle and total limits do not run
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
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) or mark this process as a child of another Claude session would change that, so they are dropped.
const DROP = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_EFFORT|CLAUDE_PID|ANTHROPIC_.*|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|AGY_ADC_AUTH|AI_AGENT)$/
export function cleanEnv(env: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!DROP.test(k)) out[k] = v
  return { ...out, ...extra }
}

// Asks an agent to stop (SIGTERM), then kills it after a grace period. Claude Code starts its commands detached, in their own process
// groups, so a plain kill of the agent's group would leave them running: the agent's descendants are collected first and stopped with it.
export function stopTree(child: ChildProcess, graceMs = 3000) {
  if (!child.pid) return
  if (process.platform === 'win32') return killTree(child)
  const kids = descendants(child.pid)
  killTree(child, 'SIGTERM')
  for (const pid of kids) signal(pid, 'SIGTERM')
  setTimeout(() => {
    killTree(child)
    for (const pid of kids) signal(pid, 'SIGKILL')
  }, graceMs).unref()
}
const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig)
  } catch {}
}
function descendants(root: number): number[] {
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).split('\n').map((l) => l.trim().split(/\s+/).map(Number))
    const found = new Set<number>()
    for (let grew = true; grew; ) {
      grew = false
      for (const [pid, ppid] of rows) if (!found.has(pid) && (ppid === root || found.has(ppid))) (found.add(pid), (grew = true))
    }
    return [...found]
  } catch {
    return []
  }
}

// The agents' output is not ours to trust: a line that breaks a parser must cost one line, not the whole app.
export const safeParse = (parse: Parser, line: string): TeamEvent[] => {
  try {
    return parse(line)
  } catch {
    return []
  }
}

// Collects normalised events into a RunResult (usage added up, first error kept, done recorded). Shared by every way of running an agent.
export function makeSink(agent: AgentName, onEvent?: (e: TeamEvent) => void) {
  const events: TeamEvent[] = []
  const res: RunResult = { ok: false, text: '', usage: { input: 0, output: 0, cached: 0, costUsd: 0 }, events }
  const sink = {
    res,
    events,
    done: false,
    push(e: TeamEvent) {
      events.push(e)
      if (e.type === 'session') res.sessionId = e.sessionId
      else if (e.type === 'usage') {
        res.usage.input += e.input
        res.usage.output += e.output
        res.usage.cached += e.cached
        res.usage.costUsd += e.costUsd ?? 0
      } else if (e.type === 'error') res.error ??= { kind: e.kind, message: e.message }
      else if (e.type === 'done') {
        sink.done = true
        res.ok = e.ok && !res.error
        res.text = e.text
        res.sessionId = e.sessionId ?? res.sessionId
      }
      onEvent?.(e)
    },
  }
  void agent
  return sink
}

// Runs one agent CLI to completion. The prompt goes in on stdin (no quoting problems, no argument length limit),
// every stdout line becomes normalised events, and the run is killed (whole process tree) when idle, too long, or aborted.
export function runCli(agent: AgentName, bin: string, args: string[], parse: Parser, o: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const sink = makeSink(agent, o.onEvent)
    const { res, events, push } = sink
    let settled = false
    let tail = ''
    let buf = ''

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      clearTimeout(max)
      o.signal?.removeEventListener('abort', onAbort)
      resolve(res)
    }

    const cmd = resolveCommand(bin, args)
    const child = spawn(cmd.cmd, cmd.args, { cwd: o.cwd, env: cleanEnv(process.env, { ...cmd.env, ...o.env }), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    const stop = (kind: ErrorKind, message: string) => {
      if (!res.error) push({ type: 'error', agent, kind, message })
      stopTree(child)
    }
    // An agent waiting for the user (approval, question) prints nothing for as long as the person takes: that is not being stuck.
    const idleMs = o.idleMs ?? 300_000
    const maxMs = o.maxMs ?? 1_800_000
    const onIdle = () => (o.hold?.() ? poke() : stop('timeout', `no output for ${Math.round(idleMs / 1000)}s`))
    let idle = setTimeout(onIdle, idleMs)
    const poke = () => {
      clearTimeout(idle)
      idle = setTimeout(onIdle, idleMs)
    }
    const onMax = () => (o.hold?.() ? (max = setTimeout(onMax, Math.min(maxMs, 60_000))) : stop('timeout', `took longer than ${Math.round(maxMs / 60_000)} minutes`))
    let max = setTimeout(onMax, maxMs)
    const onAbort = () => stop('aborted', 'stopped by user')
    if (o.signal?.aborted) onAbort()
    else o.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8') // a character split across two reads stays whole
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      poke()
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        for (const e of safeParse(parse, line)) {
          push(e)
          if (e.type === 'error' && e.kind === 'auth') stopTree(child) // signed in the wrong way (see claudeStream): nothing more should be spent
        }
      }
    })
    child.stderr.on('data', (d: string) => {
      poke()
      tail = (tail + d).slice(-2000)
    })
    child.stdin.on('error', () => {}) // the process may exit before reading its prompt
    child.stdin.end(o.prompt)

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (!res.error) push({ type: 'error', agent, kind: e.code === 'ENOENT' ? 'missing' : 'other', message: e.code === 'ENOENT' ? `${bin} is not installed or not on PATH` : e.message })
      if (!sink.done) push({ type: 'done', agent, ok: false, text: '' })
      finish()
    })
    child.on('close', (code) => {
      if (buf.trim()) safeParse(parse, buf.trim()).forEach(push)
      if (code !== 0 && !res.error) push({ type: 'error', agent, kind: classifyError(tail), message: (tail.trim() || `exited with code ${code}`).slice(-500) })
      if (!sink.done) push({ type: 'done', agent, ok: false, text: '' })
      finish()
    })
  })
}
