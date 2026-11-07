import { classifyError, json, type Parser, type TeamEvent } from './events'

// `gemini -p ... -o stream-json` (Gemini CLI 0.67): one JSON object per line, read from the CLI's own StreamJsonFormatter.
// init {session_id, model} · message {role, content, delta} · tool_use {tool_name, tool_id, parameters}
// tool_result {tool_id, status, output, error} · result {status, error?, stats {input_tokens, output_tokens, cached, input}}

const KIND: Record<string, 'command' | 'edit' | 'read'> = {
  run_shell_command: 'command',
  write_file: 'edit',
  replace: 'edit',
  read_file: 'read',
  read_many_files: 'read',
  list_directory: 'read',
  glob: 'read',
  search_file_content: 'read',
  grep_search: 'read',
  web_fetch: 'read',
  google_web_search: 'read',
}

const summary = (p: Record<string, unknown> | undefined): string => {
  const v = p?.command ?? p?.file_path ?? p?.absolute_path ?? p?.path ?? p?.dir_path ?? p?.pattern ?? p?.query ?? p?.url ?? p?.prompt
  return String(v ?? JSON.stringify(p ?? {})).slice(0, 200)
}

export function makeGeminiParser(): Parser {
  let pending = '' // the answer being written; it becomes one `text` event when a tool call or the end of the turn closes it
  let last = ''
  const flush = (out: TeamEvent[]) => {
    if (!pending.trim()) return void (pending = '')
    last = pending
    pending = ''
    out.push({ type: 'text', agent: 'gemini', text: last })
  }
  return (line) => {
    const m = json(line)
    if (!m) return []
    const out: TeamEvent[] = []
    if (m.type === 'init' && m.session_id) out.push({ type: 'session', agent: 'gemini', sessionId: String(m.session_id) })
    else if (m.type === 'message' && m.role === 'assistant') {
      const t = String(m.content ?? '')
      pending += t
      if (t) out.push({ type: 'delta', agent: 'gemini', channel: 'text', text: t })
    } else if (m.type === 'tool_use') {
      flush(out)
      const name = String(m.tool_name ?? 'tool')
      out.push({ type: 'tool', agent: 'gemini', id: String(m.tool_id ?? name), kind: KIND[name] ?? 'other', name, summary: summary(m.parameters) })
    } else if (m.type === 'tool_result') out.push({ type: 'tool_result', agent: 'gemini', id: String(m.tool_id ?? ''), ok: m.status === 'success', text: String(m.output ?? m.error?.message ?? '').slice(0, 4000) })
    else if (m.type === 'result') {
      flush(out)
      const s = m.stats ?? {}
      const cached = Number(s.cached ?? 0)
      out.push({ type: 'usage', agent: 'gemini', input: Number(s.input ?? Math.max(0, Number(s.input_tokens ?? 0) - cached)), output: Number(s.output_tokens ?? 0), cached })
      if (m.status === 'error') {
        const msg = String(m.error?.message ?? 'Gemini failed')
        out.push({ type: 'error', agent: 'gemini', kind: classifyError(msg), message: msg.slice(0, 500) })
        out.push({ type: 'done', agent: 'gemini', ok: false, text: last })
      } else out.push({ type: 'done', agent: 'gemini', ok: true, text: last })
    }
    return out
  }
}
