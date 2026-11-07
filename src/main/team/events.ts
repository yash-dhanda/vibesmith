// What every agent (Claude Code, Codex, Gemini CLI, a local Ollama model) is reduced to, so the rest of Forge never sees a vendor format.
export type AgentName = 'claude' | 'codex' | 'gemini' | 'local'
export const AGENTS: AgentName[] = ['claude', 'codex', 'gemini', 'local']
export const isAgent = (v: unknown): v is AgentName => v === 'claude' || v === 'codex' || v === 'gemini' || v === 'local'
export type ErrorKind = 'auth' | 'model' | 'limit' | 'timeout' | 'stalled' | 'aborted' | 'missing' | 'protocol' | 'busy' | 'other'

export type TeamEvent =
  | { type: 'session'; agent: AgentName; sessionId: string }
  | { type: 'text'; agent: AgentName; text: string }
  | { type: 'tool'; agent: AgentName; id: string; kind: 'command' | 'edit' | 'read' | 'other'; name: string; summary: string }
  | { type: 'tool_result'; agent: AgentName; id: string; ok: boolean; text: string }
  // Live typing. `delta` is text as it is generated (channel: the answer, the agent's reasoning summary, or a command's output); the
  // whole message follows later as a `text` event, which replaces the deltas. `code` is a file being written or changed, sent as it grows:
  // `text` is the whole content (or diff) so far, not a piece, so the screen just replaces what it showed for that `id`.
  | { type: 'delta'; agent: AgentName; channel: 'text' | 'thinking' | 'output'; id?: string; text: string }
  | { type: 'code'; agent: AgentName; id: string; path: string; text: string; kind: 'content' | 'diff'; done: boolean }
  | { type: 'prompt'; agent: AgentName; text: string } // exactly what this agent was handed for this run (the shared context it received)
  | { type: 'usage'; agent: AgentName; input: number; output: number; cached: number; costUsd?: number }
  | { type: 'note'; agent: AgentName; text: string } // warnings that do not stop the run
  // How much of the subscription's allowance is used (Codex app-server reports it): percent of the short window (5h) and the weekly one.
  | { type: 'limits'; agent: AgentName; primaryPct: number; primaryResetsAt?: number; secondaryPct?: number; secondaryResetsAt?: number }
  | { type: 'error'; agent: AgentName; kind: ErrorKind; message: string }
  | { type: 'done'; agent: AgentName; ok: boolean; text: string; sessionId?: string }

export type Parser = (line: string) => TeamEvent[]

// Order matters: a codex "model not supported on this account" message also mentions the account, which is not an auth problem.
export function classifyError(msg: string): ErrorKind {
  if (/model[_ ]not[_ ]found|not supported when using|unknown model|invalid model/i.test(msg)) return 'model'
  if (/usage limit|limit reached|out of (extra )?usage|5-hour|weekly limit|plan limit|quota|hit your [\w -]*limit|usage credit limit/i.test(msg)) return 'limit' // the plan's allowance: waiting minutes will not help
  if (/rate limit|\b429\b|overloaded|too many requests|temporarily unavailable|\b529\b/i.test(msg)) return 'busy' // a short-lived rejection: trying again soon works
  if (/authenticat|oauth|auth method|not logged in|log ?in|\b401\b|unauthorized|expired/i.test(msg)) return 'auth'
  return 'other'
}

export const json = (line: string): Record<string, any> | null => {
  try {
    const v = JSON.parse(line)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

// Reads the string value of `"key": "..."` from JSON that may still be arriving. Returns what has arrived so far, unescaped.
export function partialField(json: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json)
  if (!m) return null
  let out = ''
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i]
    if (c === '"') break
    if (c !== '\\') {
      out += c
      continue
    }
    const n = json[++i]
    if (n === undefined) break
    if (n === 'u') {
      const h = json.slice(i + 1, i + 5)
      if (h.length < 4) break
      out += String.fromCharCode(parseInt(h, 16))
      i += 4
    } else out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[n] ?? n
  }
  return out
}
