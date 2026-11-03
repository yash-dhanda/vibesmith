import { relative } from 'node:path'
import { classifyError, json, type Parser, type TeamEvent } from './events'

// `codex exec --json`: one JSON object per line. Shapes below were captured from codex-cli 0.153 (agent_message,
// command_execution, file_change, error, turn.*). Item types that were not seen (mcp_tool_call, web_search) are read defensively.

// "/usr/bin/zsh -lc 'cat hello.txt'" -> "cat hello.txt"
export const unwrapShell = (cmd: string): string => cmd.replace(/^\S*(?:sh|bash|zsh|fish)\s+-l?c\s+(['"])([\s\S]*)\1$/, '$2')

export function makeCodexParser(cwd?: string): Parser {
  let last = ''
  const rel = (p: string) => (cwd && p.startsWith(cwd) ? relative(cwd, p) || p : p)
  return (line) => {
    const m = json(line)
    if (!m) return []
    const out: TeamEvent[] = []
    const it = m.item
    if (m.type === 'thread.started' && m.thread_id) out.push({ type: 'session', agent: 'codex', sessionId: m.thread_id })
    else if (m.type === 'item.completed' && it?.type === 'agent_message') {
      last = String(it.text ?? '')
      out.push({ type: 'text', agent: 'codex', text: last })
    } else if (m.type === 'item.completed' && it?.type === 'error') out.push({ type: 'note', agent: 'codex', text: String(it.message ?? '').slice(0, 300) })
    else if (m.type === 'item.started' && it?.type === 'command_execution') out.push({ type: 'tool', agent: 'codex', id: it.id, kind: 'command', name: 'shell', summary: unwrapShell(String(it.command ?? '')).slice(0, 200) })
    else if (m.type === 'item.completed' && it?.type === 'command_execution') out.push({ type: 'tool_result', agent: 'codex', id: it.id, ok: it.exit_code === 0, text: String(it.aggregated_output ?? '').slice(0, 4000) })
    else if (m.type === 'item.started' && it?.type === 'file_change') {
      const paths = (Array.isArray(it.changes) ? it.changes : []).map((c: { path: string; kind: string }) => `${c.kind} ${rel(c.path)}`).join(', ')
      out.push({ type: 'tool', agent: 'codex', id: it.id, kind: 'edit', name: 'apply_patch', summary: paths.slice(0, 200) })
    } else if (m.type === 'item.completed' && it?.type === 'file_change') out.push({ type: 'tool_result', agent: 'codex', id: it.id, ok: it.status === 'completed', text: '' })
    else if (m.type === 'item.started' && (it?.type === 'mcp_tool_call' || it?.type === 'web_search')) out.push({ type: 'tool', agent: 'codex', id: it.id, kind: it.type === 'web_search' ? 'read' : 'other', name: it.type === 'web_search' ? 'web_search' : `${it.server}.${it.tool}`, summary: String(it.query ?? JSON.stringify(it.arguments ?? {})).slice(0, 200) })
    else if (m.type === 'item.completed' && (it?.type === 'mcp_tool_call' || it?.type === 'web_search')) out.push({ type: 'tool_result', agent: 'codex', id: it.id, ok: it.status !== 'failed', text: JSON.stringify(it.result ?? '').slice(0, 2000) })
    else if (m.type === 'turn.completed') {
      const u = m.usage ?? {}
      out.push({ type: 'usage', agent: 'codex', input: u.input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), cached: u.cached_input_tokens ?? 0 })
      out.push({ type: 'done', agent: 'codex', ok: true, text: last })
    } else if (m.type === 'turn.failed') {
      let msg = String(m.error?.message ?? 'turn failed')
      try {
        msg = JSON.parse(msg)?.error?.message ?? msg // the message is itself a JSON string from the API
      } catch {}
      out.push({ type: 'error', agent: 'codex', kind: classifyError(msg), message: msg.slice(0, 500) })
      out.push({ type: 'done', agent: 'codex', ok: false, text: last })
    }
    return out // top-level {"type":"error"} lines only repeat what turn.failed reports
  }
}
