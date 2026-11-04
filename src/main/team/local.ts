import { runAgent, SYSTEM_PROMPT, type AgentEvent } from '../agent/loop'
import { ollama, type Provider } from '../agent/provider'
import { describeTool } from '../agent/narrate'
import { ToolBox } from '../agent/tools'
import type { TeamEvent } from './events'
import type { ApprovalAsk } from './codexServer'
import { decideTool } from './policy'
import { makeSink, type RunResult } from './process'

// The third team member: a model running on this computer through Ollama, driven by Forge's own agent loop (the one the chat uses).
// It costs nothing and uses no subscription. It cannot use the team mailbox, so its hand-over is its closing summary.

const KIND: Record<string, 'command' | 'edit' | 'read'> = { run_command: 'command', create_file: 'edit', edit_file: 'edit', list_dir: 'read', read_file: 'read', search: 'read', update_plan: 'read' }
const LOCAL_NUM_CTX = 16_384 // enough for a task and a few files; a bigger window would crowd out the GPU memory the model needs
const MAX_STEPS = 60

export type LocalOpts = {
  cwd: string
  prompt: string
  model: string
  write: boolean
  signal: AbortSignal
  onEvent?: (e: TeamEvent) => void
  provider?: Provider // tests pass a scripted model
  ask?: (a: ApprovalAsk) => Promise<boolean> // decides commands the policy would ask about; without it they are refused
}

// A read-only run (planning, review) may look but never change a file, so it also runs no commands: a command can write anywhere.
// A build run's commands go through the same policy as the other agents (no push, no writes outside the folder, deploys and the like asked first).
export function guardedBox(cwd: string, write: boolean, ask?: LocalOpts['ask']): ToolBox {
  const box = new ToolBox(cwd)
  const run = box.run.bind(box)
  const readOnly = 'ERROR: this is a read-only job. Do not change files or run commands; read files and report what you found instead.'
  box.run = async (name, args, signal) => {
    if (!write && (name === 'create_file' || name === 'edit_file' || name === 'run_command')) return readOnly
    if (name === 'run_command') {
      const command = String((args as { command?: unknown })?.command ?? '')
      const v = decideTool('Bash', { command }, cwd)
      if (v.verdict === 'deny') return `ERROR: not allowed: ${v.reason}.`
      if (v.verdict === 'ask' && !(await ask?.({ kind: 'command', title: `The local model wants to run: ${command.slice(0, 200)}`, detail: v.reason, command }))) return `ERROR: not allowed: ${v.reason}`
    }
    return run(name, args, signal)
  }
  return box
}

function errorKind(message: string) {
  if (/cannot reach ollama/i.test(message)) return 'missing' as const
  if (/not found/i.test(message)) return 'model' as const
  return 'other' as const
}

export async function runLocal(o: LocalOpts): Promise<RunResult> {
  const sink = makeSink('local', o.onEvent)
  const agent = 'local' as const
  const provider = o.provider ?? ollama({ model: o.model, numCtx: LOCAL_NUM_CTX })
  const tools = guardedBox(o.cwd, o.write, o.ask)
  let typed = '' // the answer being written, shown live and replaced by the whole text at the end of the turn
  let last = ''
  let reason: Extract<AgentEvent, { type: 'done' }>['reason'] | null = null
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: o.prompt },
  ]
  const endTurn = () => {
    if (typed.trim()) sink.push({ type: 'text', agent, text: typed.trim() }), (last = typed.trim())
    typed = ''
  }
  await runAgent({
    messages,
    mode: 'full-auto',
    provider,
    tools,
    signal: o.signal,
    maxSteps: MAX_STEPS,
    maxReviews: 1,
    contextLimit: LOCAL_NUM_CTX,
    approve: async () => true,
    emit: (ev) => {
      if (ev.type === 'delta') (typed += ev.text), sink.push({ type: 'delta', agent, channel: 'text', text: ev.text })
      else if (ev.type === 'turn_end') endTurn()
      else if (ev.type === 'tool') {
        endTurn()
        const kind = KIND[ev.name] ?? 'other'
        sink.push({ type: 'tool', agent, id: ev.id, kind, name: ev.name, summary: ev.label ?? describeTool(ev.name, ev.args) })
        const a = (ev.args ?? {}) as { path?: unknown; content?: unknown; old_text?: unknown; new_text?: unknown }
        if (ev.name === 'create_file' && typeof a.path === 'string' && typeof a.content === 'string') sink.push({ type: 'code', agent, id: ev.id, path: a.path, text: a.content, kind: 'content', done: true })
        else if (ev.name === 'edit_file' && typeof a.path === 'string' && typeof a.old_text === 'string' && typeof a.new_text === 'string') {
          const side = (mark: string, t: string) => t.split('\n').map((x) => mark + x).join('\n')
          sink.push({ type: 'code', agent, id: ev.id, path: a.path, text: `@@ edit @@\n${side('-', a.old_text)}\n${side('+', a.new_text)}`, kind: 'diff', done: true })
        }
      } else if (ev.type === 'tool_result') sink.push({ type: 'tool_result', agent, id: ev.id, ok: ev.ok, text: ev.text.slice(0, 4000) })
      else if (ev.type === 'usage') sink.push({ type: 'usage', agent, input: ev.input, output: ev.output, cached: 0, costUsd: 0 })
      else if (ev.type === 'note') sink.push({ type: 'note', agent, text: ev.text })
      else if (ev.type === 'error') sink.push({ type: 'error', agent, kind: errorKind(ev.message), message: ev.message })
      else if (ev.type === 'done') reason = ev.reason
    },
  })
  endTurn()
  if (!sink.res.error && reason && reason !== 'finished' && reason !== 'unverified')
    sink.push({ type: 'error', agent, kind: o.signal.aborted ? 'aborted' : 'other', message: reason === 'stopped' ? 'The local model was stopped.' : `The local model gave up (${reason === 'stuck' ? 'it kept repeating itself' : 'too many steps'}).` })
  sink.push({ type: 'done', agent, ok: !sink.res.error, text: last })
  return sink.res
}
