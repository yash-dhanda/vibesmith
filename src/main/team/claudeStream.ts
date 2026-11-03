import { relative } from 'node:path'
import { classifyError, json, partialField, type Parser, type TeamEvent } from './events'

// `claude -p --output-format stream-json --verbose`: one JSON object per line. Only whole messages are read (no partial deltas).
const KIND: Record<string, 'command' | 'edit' | 'read'> = { Bash: 'command', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Read: 'read', Grep: 'read', Glob: 'read' }

const summary = (name: string, input: Record<string, unknown> | undefined, rel: (p: string) => string): string => {
  const i = input ?? {}
  const path = i.file_path ?? i.path
  return String(i.command ?? (path ? rel(String(path)) : undefined) ?? i.pattern ?? i.description ?? JSON.stringify(i)).slice(0, 200)
}

const flat = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('') : ''

const CONTENT_KEY: Record<string, string> = { Write: 'content', Edit: 'new_string' }

export function makeClaudeParser(cwd?: string): Parser {
  const rel = (p: string) => (cwd && p.startsWith(cwd) ? relative(cwd, p) || p : p) // paths shown relative to the agent's own folder
  const blocks = new Map<number, { id: string; name: string; json: string; sent: number }>() // tool calls being written
  return (line) => {
    const m = json(line)
    if (!m) return []
    const out: TeamEvent[] = []
    if (m.type === 'stream_event') {
      const e = m.event ?? {}
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') blocks.set(e.index, { id: e.content_block.id, name: e.content_block.name, json: '', sent: 0 })
      else if (e.type === 'content_block_delta') {
        const d = e.delta ?? {}
        if (d.type === 'text_delta' && d.text) out.push({ type: 'delta', agent: 'claude', channel: 'text', text: d.text })
        else if (d.type === 'thinking_delta' && d.thinking) out.push({ type: 'delta', agent: 'claude', channel: 'thinking', text: d.thinking })
        else if (d.type === 'input_json_delta') {
          const b = blocks.get(e.index)
          const key = b && CONTENT_KEY[b.name]
          if (b && key) {
            b.json += d.partial_json ?? ''
            const text = partialField(b.json, key)
            const path = partialField(b.json, 'file_path')
            if (text !== null && path && text.length - b.sent >= 60) {
              b.sent = text.length
              out.push({ type: 'code', agent: 'claude', id: b.id, path: rel(path), text, kind: 'content', done: false })
            }
          }
        }
      } else if (e.type === 'content_block_stop') {
        const b = blocks.get(e.index)
        const key = b && CONTENT_KEY[b.name]
        if (b && key) {
          const text = partialField(b.json, key)
          const path = partialField(b.json, 'file_path')
          if (text !== null && path) out.push({ type: 'code', agent: 'claude', id: b.id, path: rel(path), text, kind: 'content', done: true })
        }
        blocks.delete(e.index)
      }
      return out
    }
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) out.push({ type: 'session', agent: 'claude', sessionId: m.session_id })
    else if (m.type === 'assistant') {
      if (m.message?.model === '<synthetic>') return [] // Claude Code's own error message; the result line carries it
      const blocks = Array.isArray(m.message?.content) ? m.message.content : []
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) out.push({ type: 'text', agent: 'claude', text: b.text })
        else if (b?.type === 'tool_use') out.push({ type: 'tool', agent: 'claude', id: b.id, kind: KIND[b.name] ?? 'other', name: b.name, summary: summary(b.name, b.input, rel) })
      }
    } else if (m.type === 'user') {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) if (b?.type === 'tool_result') out.push({ type: 'tool_result', agent: 'claude', id: b.tool_use_id, ok: !b.is_error, text: flat(b.content).slice(0, 4000) })
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
