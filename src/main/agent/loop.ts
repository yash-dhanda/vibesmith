import type { Message, Provider } from './provider'
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
Use the tools to inspect and change files. Read a file before editing it. Make small, exact edits.
Do not invent file names or APIs: list_dir and read_file to check. When the task is done, reply with a short summary and stop calling tools.`

const KIND: Record<string, 'read' | 'edit' | 'command'> = { list_dir: 'read', read_file: 'read', edit_file: 'edit', run_command: 'command' }

// The one place autonomy is decided. Unknown tools never execute, so they never need approval.
export function needsApproval(tool: string, mode: Mode): boolean {
  const kind = KIND[tool]
  if (!kind || kind === 'read' || mode === 'full-auto') return false
  return kind === 'edit' ? mode === 'ask-all' : true
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
  const failures = new Map<string, number>()
  let steps = 0
  const done = (reason: 'finished' | 'stopped' | 'stuck' | 'max_steps') => o.emit({ type: 'done', reason, steps })

  try {
    while (steps < max) {
      if (o.signal.aborted) return done('stopped')
      steps++
      const turn = await o.provider.chat(o.messages, toolDefs, (text) => o.emit({ type: 'delta', text }), o.signal)
      o.messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined })
      o.emit({ type: 'turn_end' })
      if (!turn.toolCalls.length) return done('finished')

      for (const call of turn.toolCalls) {
        const id = `${steps}-${Math.random().toString(36).slice(2, 8)}`
        const ask = needsApproval(call.name, o.mode)
        o.emit({ type: 'tool', id, name: call.name, args: call.args, needsApproval: ask })
        let text: string
        if (ask && !(await o.approve(id))) text = 'DENIED: the user rejected this action. Do not retry it; ask what to do instead.'
        else if (o.signal.aborted) return done('stopped')
        else text = await o.tools.run(call.name, call.args)
        const ok = !text.startsWith('ERROR:') && !text.startsWith('DENIED:')
        o.emit({ type: 'tool_result', id, text, ok })
        o.messages.push({ role: 'tool', content: text, toolName: call.name })

        // Same failing call three times: the model is looping, stop and hand back to the user.
        if (!ok) {
          const key = call.name + JSON.stringify(call.args)
          failures.set(key, (failures.get(key) ?? 0) + 1)
          if (failures.get(key)! >= 3) return done('stuck')
        }
      }
    }
    done('max_steps')
  } catch (e) {
    if (o.signal.aborted) return done('stopped')
    o.emit({ type: 'error', message: (e as Error).message })
  }
}
