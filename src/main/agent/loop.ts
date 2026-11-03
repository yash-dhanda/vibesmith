import type { Message, Provider } from './provider'
import { isAllowlisted } from './commands'
import { resolveToolName } from './guards'
import { ToolBox, toolDefs } from './tools'

export type Mode = 'ask-all' | 'auto-edit' | 'full-auto'

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name: string; args: unknown; needsApproval: boolean }
  | { type: 'tool_result'; id: string; text: string; ok: boolean }
  | { type: 'turn_end' }
  | { type: 'done'; reason: 'finished' | 'stopped' | 'stuck' | 'max_steps'; steps: number }
  | { type: 'error'; message: string }

export const SYSTEM_PROMPT = `You are Forge, a coding agent working inside the user's project folder.
Use the tools to inspect and change files and to run commands. Read a file before editing it. Make small, exact edits.
After changing code, run the project's tests or build with run_command when one exists, and fix what fails.
When a command or test fails, read the files named in its output before searching. Do not invent file names or APIs: list_dir and read_file to check. When the task is done, reply with a short summary and stop calling tools.`

const KIND: Record<string, 'read' | 'edit' | 'command'> = { list_dir: 'read', read_file: 'read', edit_file: 'edit', search: 'read', run_command: 'command' }

// The one place autonomy is decided. Unknown tools never execute, so they never need approval.
export function needsApproval(tool: string, mode: Mode, args?: unknown): boolean {
  const kind = KIND[tool]
  if (!kind || kind === 'read' || mode === 'full-auto') return false
  if (kind === 'edit') return mode === 'ask-all'
  // command: auto-edit lets a short allow-list through (tests, builds, git status)
  const cmd = (args as { command?: unknown } | null)?.command
  return !(mode === 'auto-edit' && typeof cmd === 'string' && isAllowlisted(cmd))
}

export type RunOpts = {
  messages: Message[] // conversation so far, ending with the new user message; mutated in place
  mode: Mode
  provider: Provider
  tools: ToolBox
  emit: (e: AgentEvent) => void
  approve: (id: string) => Promise<boolean>
  signal: AbortSignal
  maxSteps?: number
}

export async function runAgent(o: RunOpts): Promise<void> {
  const max = o.maxSteps ?? 50
  // Per call signature: the last result and how many times in a row it came back identical.
  const repeats = new Map<string, { result: string; n: number }>()
  let steps = 0
  const done = (reason: 'finished' | 'stopped' | 'stuck' | 'max_steps') => o.emit({ type: 'done', reason, steps })

  try {
    while (steps < max) {
      if (o.signal.aborted) return done('stopped')
      steps++
      const turn = await o.provider.chat(o.messages, toolDefs, (text) => o.emit({ type: 'delta', text }), o.signal)
      // Resolve near-miss names (read, cat, write_file) BEFORE the gate, so an alias can never dodge approval.
      const calls = turn.toolCalls.map((c, i) => ({ ...c, id: c.id ?? `call_${steps}_${i}`, name: resolveToolName(c.name) ?? c.name }))
      o.messages.push({ role: 'assistant', content: turn.content, toolCalls: calls.length ? calls : undefined })
      o.emit({ type: 'turn_end' })
      if (!calls.length) return done('finished')

      for (const call of calls) {
        const id = `${steps}-${Math.random().toString(36).slice(2, 8)}`
        const ask = needsApproval(call.name, o.mode, call.args)
        o.emit({ type: 'tool', id, name: call.name, args: call.args, needsApproval: ask })
        let text: string
        if (ask && !(await o.approve(id))) text = 'DENIED: the user rejected this action. Do not retry it; ask what to do instead.'
        else if (o.signal.aborted) return done('stopped')
        else text = await o.tools.run(call.name, call.args, o.signal)
        const ok = !text.startsWith('ERROR:') && !text.startsWith('DENIED:')

        // The same call returning the same result three times means nothing is changing: the model is looping.
        // Errors, empty searches, a repeated read or an unchanged test run all land here.
        const key = call.name + JSON.stringify(call.args)
        const prev = repeats.get(key)
        const n = prev && prev.result === text ? prev.n + 1 : 1
        repeats.set(key, { result: text, n })
        // Second identical result: small models often just need to be told to change approach.
        const shown = n === 2 ? text + '\n[Forge: you made this exact call twice and got the same result. Do something different: read the file the output points to with read_file, or explain what is blocking you.]' : text

        o.emit({ type: 'tool_result', id, text: shown, ok })
        o.messages.push({ role: 'tool', content: shown, toolName: call.name, toolCallId: call.id })
        if (n >= 3) return done('stuck')
      }
    }
    done('max_steps')
  } catch (e) {
    if (o.signal.aborted) return done('stopped')
    o.emit({ type: 'error', message: (e as Error).message })
  }
}
