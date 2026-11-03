import type { Message } from './provider'

// A long run keeps adding file contents and command output to the conversation. A small model has a small memory and
// silently forgets the start once it is full (a common cause of "hallucination"). Old bulky output is shrunk first:
// the files are on disk, so the model can read them again when it needs them.
export const estimateTokens = (messages: Message[]): number =>
  Math.ceil(messages.reduce((n, m) => n + m.content.length + (m.role === 'assistant' && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0) / 4)

const cut = (s: string, keep: number, what: string) => (s.length > keep + 80 ? `${s.slice(0, keep)}\n[${what}]` : s)

function shrinkArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) }
  for (const k of ['content', 'old_text', 'new_text']) if (typeof out[k] === 'string') out[k] = cut(out[k] as string, 160, 'older text trimmed')
  return out
}

// Shrinks the oldest messages in place until the estimate fits. Returns how many messages changed.
// Never touches the system prompt or the first user message. Recent messages are spared first, then less and less,
// but the last two (the newest tool result and what it answers) always stay intact so the model can act on them.
export function trimMessages(messages: Message[], limitTokens: number): number {
  const target = limitTokens * 0.55
  let changed = 0
  for (const keepRecent of [8, 4, 2]) {
    if (estimateTokens(messages) <= target) break
    const end = Math.max(0, messages.length - keepRecent)
    let seenFirstUser = false
    for (let i = 0; i < end && estimateTokens(messages) > target; i++) {
      const m = messages[i]
      if (m.role === 'system') continue
      if (m.role === 'user' && !seenFirstUser) {
        seenFirstUser = true
        continue
      }
      if (m.role === 'tool') {
        const next = cut(m.content, 240, 'older output trimmed to save space')
        if (next !== m.content) (m.content = next), changed++
      } else if (m.role === 'assistant') {
        const content = cut(m.content, 400, 'older text trimmed')
        const calls = m.toolCalls?.map((c) => ({ ...c, args: shrinkArgs(c.args) }))
        if (content !== m.content || JSON.stringify(calls) !== JSON.stringify(m.toolCalls)) {
          m.content = content
          if (calls) m.toolCalls = calls
          changed++
        }
      } else if (m.role === 'user') {
        const next = cut(m.content, 600, 'older message trimmed') // e.g. a long failing-check output sent back to the model
        if (next !== m.content) (m.content = next), changed++
      }
    }
  }
  return changed
}
