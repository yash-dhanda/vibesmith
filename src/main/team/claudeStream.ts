import { classifyError, json, type Parser, type TeamEvent } from './events'

// `claude -p --output-format stream-json --verbose`: one JSON object per line. Only whole messages are read (no partial deltas).
const KIND: Record<string, 'command' | 'edit' | 'read'> = { Bash: 'command', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Read: 'read', Grep: 'read', Glob: 'read' }

const summary = (name: string, input: Record<string, unknown> | undefined): string => {
  const i = input ?? {}
  return String(i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.description ?? JSON.stringify(i)).slice(0, 200)
}

const flat = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('') : ''

export function makeClaudeParser(): Parser {
  return (line) => {
    const m = json(line)
    if (!m) return []
    const out: TeamEvent[] = []
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) out.push({ type: 'session', agent: 'claude', sessionId: m.session_id })
    else if (m.type === 'assistant') {
      if (m.message?.model === '<synthetic>') return [] // Claude Code's own error message; the result line carries it
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text) out.push({ type: 'text', agent: 'claude', text: b.text })
        else if (b.type === 'tool_use') out.push({ type: 'tool', agent: 'claude', id: b.id, kind: KIND[b.name] ?? 'other', name: b.name, summary: summary(b.name, b.input) })
      }
    } else if (m.type === 'user') {
      for (const b of m.message?.content ?? []) if (b?.type === 'tool_result') out.push({ type: 'tool_result', agent: 'claude', id: b.tool_use_id, ok: !b.is_error, text: flat(b.content).slice(0, 4000) })
    } else if (m.type === 'result') {
      const u = m.usage ?? {}
      const cached = u.cache_read_input_tokens ?? 0
      out.push({ type: 'usage', agent: 'claude', input: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cached, ...(typeof m.total_cost_usd === 'number' ? { costUsd: m.total_cost_usd } : {}) })
      const text = String(m.result ?? '')
      if (m.is_error) out.push({ type: 'error', agent: 'claude', kind: classifyError(text), message: text.slice(0, 500) })
      out.push({ type: 'done', agent: 'claude', ok: !m.is_error, text, sessionId: m.session_id })
    }
    return out
  }
}
