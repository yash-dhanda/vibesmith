// What every agent CLI (Claude Code, Codex) is reduced to, so the rest of Forge never sees a vendor format.
export type AgentName = 'claude' | 'codex'
export type ErrorKind = 'auth' | 'model' | 'limit' | 'timeout' | 'aborted' | 'missing' | 'protocol' | 'other'

export type TeamEvent =
  | { type: 'session'; agent: AgentName; sessionId: string }
  | { type: 'text'; agent: AgentName; text: string }
  | { type: 'tool'; agent: AgentName; id: string; kind: 'command' | 'edit' | 'read' | 'other'; name: string; summary: string }
  | { type: 'tool_result'; agent: AgentName; id: string; ok: boolean; text: string }
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
  if (/rate limit|usage limit|limit reached|quota|\b429\b|overloaded|too many requests/i.test(msg)) return 'limit'
  if (/authenticat|oauth|not logged in|log ?in|\b401\b|unauthorized|expired/i.test(msg)) return 'auth'
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
