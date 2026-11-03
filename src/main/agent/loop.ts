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

export const SYSTEM_PROMPT = `You are Forge, a coding agent working inside the user's project folder. The user describes what they want and you do the work yourself with the tools. Do not hand the work back, and do not ask for permission.

- Make something new: create the files with create_file. Never paste a whole program into the chat. Keep each file small, under about 120 lines: split a big program into several files, written one at a time.
- Change something that exists: read_file first, then edit_file with small exact edits.
- If the user wants something written to a file, use create_file or edit_file. The answer belongs in the file, not in the chat.
- After changing code, run the project's tests or build with run_command when one exists, and fix what fails. When a command or test fails, read the files named in its output.
- Match the style of the existing code, for example CommonJS (module.exports, require) versus ES modules (export, import). Do not mix them in one project.
- Do not invent file names or APIs: use list_dir, search and read_file to check.
- Secrets such as API keys and tokens: put placeholders in a .env file and read them from the environment. Never ask the user to paste a secret into the chat.

When you are finished, reply with a short summary of what you did and how to run it, then stop calling tools.
Only when you built something new and still need a value you cannot decide yourself (a name, a token, a choice that changes the result), end your summary with one short list of what you need. Create the files first, with sensible defaults, and mention the defaults. Never ask before creating files.`

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

// The advice depends on what is repeating: re-reading a file it already has is a different mistake from a failing edit.
export function repeatNudge(tool: string, result: string): string {
  if (tool === 'read_file' || tool === 'list_dir' || tool === 'search')
    return '[Forge: you already have this result above. Stop re-reading. Use it: make the change with edit_file (copy old_text exactly from the content above) or create_file.]'
  if (result.startsWith('ERROR:')) return '[Forge: this exact call failed the same way twice. Change your approach: re-read the file and copy the text exactly, or use a different tool.]'
  return '[Forge: same command, same output. Change something before running it again, or explain what is blocking you.]'
}
const MAX_RUN_MS = 30 * 60_000
const MAX_REVIEWS = 4
const MAX_NUDGES = 3

// A reply that describes what it will do next, instead of doing it, is a stall, not an ending.
export function looksUnfinished(text: string): boolean {
  const t = text.trim()
  if (!t || /\?\s*$/.test(t)) return false // empty, or a question for the user
  const tail = t.slice(-500)
  const forward = /\b(let me (?!know)|i['’]ll\b|i will\b|next,? (?:i|we)\b|now,? (?:i|let)\b|let['’]s\b|here['’]s (?:what|my plan)|i (?:need|am going) to\b|i['’]m going to\b)/i
  const finished = /\b(done|complete[d]?|finished|successfully|all set)\b/i
  if (finished.test(t.slice(-300)) && !forward.test(t.slice(-200))) return false
  return forward.test(tail)
}
const UNFINISHED_NUDGE = '[Forge: you described what to do next but did not do it. Do not describe: act now with the tools, one step at a time.]'

// What the user originally asked, for the review. Skips messages Forge itself injected.
export function requestOf(messages: Message[]): string {
  const m = [...messages].reverse().find((x) => x.role === 'user' && !x.content.startsWith('[Forge') && !x.content.startsWith('Verification failed'))
  return m ? m.content.slice(0, 1500) : ''
}
const reviewPrompt = (request: string) =>
  `[Forge: before you finish, compare your work with the request:\n"""\n${request}\n"""\nUse list_dir, read_file or run_command to check each requirement. Anything missing or broken: do it now with the tools. If every requirement is complete, reply with just "Done".]`

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
  maxReviews?: number // how many times it must compare its work with the request before finishing; 0 turns the review off
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
  let reviews = 0
  let nudges = 0
  let editedSinceReview = false
  let holdNext = false
  let lastInput = 0 // real prompt size of the previous model call, when the provider reports it
  let trimNoted = false
  let explore = false // after a repeat, the next call is sampled more freely to escape the loop
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
      const turn = await o.provider.chat(o.messages, toolDefs, (text) => (reflecting ? (held += text) : o.emit({ type: 'delta', text })), o.signal, { explore })
      explore = false
      if (reflecting && (turn.toolCalls.length || held.trim().length > 60)) o.emit({ type: 'delta', text: held })
      const u = turn.usage ?? estimateUsage(o.messages, turn)
      if (!u.estimated) lastInput = u.input
      o.emit({ type: 'usage', input: u.input, output: u.output, tps: u.genMs > 0 ? u.output / (u.genMs / 1000) : 0, ctxLimit: u.ctxLimit, estimated: u.estimated })
      // Resolve near-miss names (read, cat, write_file) BEFORE the gate, so an alias can never dodge approval.
      const calls = turn.toolCalls.map((c, i) => ({ ...c, id: c.id ?? `call_${steps}_${i}`, name: resolveToolName(c.name) ?? c.name }))
      o.messages.push({ role: 'assistant', content: turn.content, toolCalls: calls.length ? calls : undefined })
      o.emit({ type: 'turn_end' })
      if (!calls.length) {
        // A reply that only announces the next step is a stall: make it act.
        if (nudges < MAX_NUDGES && looksUnfinished(turn.content)) {
          nudges++
          o.messages.push({ role: 'user', content: UNFINISHED_NUDGE })
          continue
        }
        // After changes, review the work against the original request before finishing (and again after later changes).
        if (editedSinceReview && reviews < (o.maxReviews ?? MAX_REVIEWS)) {
          reviews++
          editedSinceReview = false
          holdNext = true
          o.messages.push({ role: 'user', content: reviewPrompt(requestOf(o.messages)) })
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
        if (ok && (call.name === 'edit_file' || call.name === 'create_file')) (edited = true), (editedSinceReview = true)

        // The same call returning the same result three times means nothing is changing: the model is looping.
        // Errors, empty searches, a repeated read or an unchanged test run all land here.
        const key = call.name + JSON.stringify(call.args)
        const prev = repeats.get(key)
        const n = prev && prev.result === text ? prev.n + 1 : 1
        repeats.set(key, { result: text, n })
        // Second identical result: say what to change, and let the next call be sampled more freely.
        const shown = n === 2 ? text + '\n' + repeatNudge(call.name, text) : text
        if (n === 2) explore = true

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
