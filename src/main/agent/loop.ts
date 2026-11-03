import type { Message, Provider, Turn, Usage } from './provider'
import { isAllowlisted } from './commands'
import { estimateTokens, trimMessages } from './context'
import { resolveToolName } from './guards'
import { ToolBox, toolDefs } from './tools'

export type Mode = 'ask-all' | 'auto-edit' | 'full-auto'

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name: string; args: unknown; needsApproval: boolean }
  | { type: 'tool_result'; id: string; text: string; ok: boolean }
  | { type: 'turn_end' }
  | { type: 'usage'; input: number; output: number; tps: number; ctxLimit?: number; estimated?: boolean }
  | { type: 'verify'; command: string; ok: boolean; output: string }
  | { type: 'note'; text: string }
  | { type: 'changes'; checkpoint: string; files: { path: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number }[] }
  | { type: 'done'; reason: 'finished' | 'unverified' | 'stopped' | 'stuck' | 'max_steps'; steps: number }
  | { type: 'error'; message: string }

export const SYSTEM_PROMPT = `You are Forge, a coding agent working inside the user's project folder. The user is not looking at code: they describe what they want and you build it.

When the user asks you to make, build or create something, do it with the tools: create the files in the project folder with create_file. Never paste a whole program into the chat instead of creating the files.
After creating files, reply briefly: what you made and where, how to run it, and anything you still need from the user (names, settings, choices). Ask in one short list, then stop and wait for the answers. When they answer, change the files with edit_file.
Secrets such as API keys and tokens: put placeholders in a .env file, tell the user which file to fill in, and never ask them to paste a secret into the chat.

To change existing files: read_file first, then edit_file with small exact edits. After changing code, run the project's tests or build with run_command when one exists, and fix what fails.
When a command or test fails, read the files named in its output before searching. Do not invent file names or APIs: list_dir and read_file to check. When the task is done, reply with a short summary and stop calling tools.`

const KIND: Record<string, 'read' | 'edit' | 'command'> = { list_dir: 'read', read_file: 'read', edit_file: 'edit', create_file: 'edit', search: 'read', run_command: 'command' }

// The one place autonomy is decided. Unknown tools never execute, so they never need approval.
export function needsApproval(tool: string, mode: Mode, args?: unknown): boolean {
  const kind = KIND[tool]
  if (!kind || kind === 'read' || mode === 'full-auto') return false
  if (kind === 'edit') return mode === 'ask-all'
  // command: auto-edit lets a short allow-list through (tests, builds, git status)
  const cmd = (args as { command?: unknown } | null)?.command
  return !(mode === 'auto-edit' && typeof cmd === 'string' && isAllowlisted(cmd))
}

const MAX_VERIFY_FAILURES = 2
const REFLECT = '[Forge: before you finish, check your work. Use read_file or search to confirm every change is in place and nothing was missed. If something is wrong, fix it. If it is all correct, reply with just "Done".]'
const MAX_RUN_MS = 30 * 60_000

// Providers that report no usage still get a rough number (about 4 characters per token), flagged as an estimate.
export function estimateUsage(messages: Message[], turn: Turn): Usage {
  const chars = messages.reduce((n, m) => n + m.content.length, 0)
  return { input: Math.ceil(chars / 4), output: Math.ceil((turn.content.length + (turn.toolCalls.length ? JSON.stringify(turn.toolCalls).length : 0)) / 4), genMs: 0, estimated: true }
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
  maxMs?: number
  // The model's memory in tokens. When the conversation nears it, old bulky output is shrunk (files are on disk and can be re-read).
  contextLimit?: number
  // The project's own check. Runs when the model says it is done after editing files; a failure goes back to the model.
  verify?: () => Promise<{ command: string; ok: boolean; output: string }>
}

export async function runAgent(o: RunOpts): Promise<void> {
  const max = o.maxSteps ?? 50
  // Per call signature: the last result and how many times in a row it came back identical.
  const repeats = new Map<string, { result: string; n: number }>()
  let steps = 0
  let edited = false
  let verifyFailures = 0
  let reflected = false
  let holdNext = false
  let lastInput = 0 // real prompt size of the previous model call, when the provider reports it
  let trimNoted = false
  const deadline = Date.now() + (o.maxMs ?? MAX_RUN_MS)
  const done = (reason: 'finished' | 'unverified' | 'stopped' | 'stuck' | 'max_steps') => o.emit({ type: 'done', reason, steps })

  try {
    while (steps < max && Date.now() < deadline) {
      if (o.signal.aborted) return done('stopped')
      steps++
      if (o.contextLimit && Math.max(estimateTokens(o.messages), lastInput) > o.contextLimit * 0.75) {
        const n = trimMessages(o.messages, o.contextLimit)
        if (n && !trimNoted) {
          trimNoted = true
          o.emit({ type: 'note', text: "Older steps were shortened to fit the model's memory. It can re-read files when it needs them." })
        }
      }
      // The self-check turn is usually just "Done". Hold its text and only show it when it says something.
      const reflecting = holdNext
      holdNext = false
      let held = ''
      const turn = await o.provider.chat(o.messages, toolDefs, (text) => (reflecting ? (held += text) : o.emit({ type: 'delta', text })), o.signal)
      if (reflecting && (turn.toolCalls.length || held.trim().length > 60)) o.emit({ type: 'delta', text: held })
      const u = turn.usage ?? estimateUsage(o.messages, turn)
      if (!u.estimated) lastInput = u.input
      o.emit({ type: 'usage', input: u.input, output: u.output, tps: u.genMs > 0 ? u.output / (u.genMs / 1000) : 0, ctxLimit: u.ctxLimit, estimated: u.estimated })
      // Resolve near-miss names (read, cat, write_file) BEFORE the gate, so an alias can never dodge approval.
      const calls = turn.toolCalls.map((c, i) => ({ ...c, id: c.id ?? `call_${steps}_${i}`, name: resolveToolName(c.name) ?? c.name }))
      o.messages.push({ role: 'assistant', content: turn.content, toolCalls: calls.length ? calls : undefined })
      o.emit({ type: 'turn_end' })
      if (!calls.length) {
        // Without a project check, one self-review turn catches half-finished work (a misspelling left in one file).
        if (edited && !o.verify && !reflected) {
          reflected = true
          holdNext = true
          o.messages.push({ role: 'user', content: REFLECT })
          continue
        }
        if (!o.verify || !edited) return done('finished')
        const v = await o.verify()
        if (o.signal.aborted) return done('stopped')
        o.emit({ type: 'verify', ...v })
        if (v.ok) return done('finished')
        // "Done" only counts if the project's check passes. Hand the real output back, twice at most.
        if (++verifyFailures > MAX_VERIFY_FAILURES) return done('unverified')
        o.messages.push({ role: 'user', content: `Verification failed. Command: ${v.command}\n${v.output}\nFix the cause, then finish.` })
        continue
      }

      for (const call of calls) {
        const id = `${steps}-${Math.random().toString(36).slice(2, 8)}`
        const ask = needsApproval(call.name, o.mode, call.args)
        o.emit({ type: 'tool', id, name: call.name, args: call.args, needsApproval: ask })
        let text: string
        if (ask && !(await o.approve(id))) text = 'DENIED: the user rejected this action. Do not retry it; ask what to do instead.'
        else if (o.signal.aborted) return done('stopped')
        else text = await o.tools.run(call.name, call.args, o.signal)
        const ok = !text.startsWith('ERROR:') && !text.startsWith('DENIED:')
        if (ok && (call.name === 'edit_file' || call.name === 'create_file')) edited = true

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
