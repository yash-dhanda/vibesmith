import { classifyError, json, type Parser, type TeamEvent } from './events'

// `agy --output-format stream-json` (Antigravity CLI 1.5): one JSON object per line, from Google's headless docs.
// {"event":"init","conversation_id"} · {"event":"step_update","step_update":{conversation_id, step_index, state: ACTIVE|DONE, step_type: user_input|agent_response|tool|checkpoint,
//   text_delta, tool_name, tool_info {name, parameters, output, error {type, message}}}} · {"event":"result","result":{status, response, error, usage {input_tokens, output_tokens, cache_read_tokens}}}

const kindOf = (name: string): 'command' | 'edit' | 'read' | 'other' =>
  /command|shell|terminal/i.test(name) ? 'command' : /write|replace|edit|create|delete|patch/i.test(name) ? 'edit' : /view|read|list|grep|find|search|url|fetch/i.test(name) ? 'read' : 'other'

const summary = (p: Record<string, unknown> | undefined): string => {
  const v = p?.CommandLine ?? p?.TargetFile ?? p?.AbsolutePath ?? p?.FilePath ?? p?.Path ?? p?.SearchPath ?? p?.DirectoryPath ?? p?.Query ?? p?.Pattern ?? p?.Url ?? p?.URL
  return String(v ?? JSON.stringify(p ?? {})).slice(0, 200)
}

export function makeGeminiParser(): Parser {
  let pending = '' // the answer being written; it becomes one `text` event when a tool call or the end of the turn closes it
  let last = ''
  const started = new Set<string>()
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
    if (m.event === 'init' && m.conversation_id) out.push({ type: 'session', agent: 'gemini', sessionId: String(m.conversation_id) })
    else if (m.event === 'step_update' && m.step_update) {
      const s = m.step_update
      if (s.step_type === 'agent_response') {
        const t = String(s.text_delta ?? '')
        pending += t
        if (t) out.push({ type: 'delta', agent: 'gemini', channel: 'text', text: t })
        if (s.state === 'DONE') flush(out)
      } else if (s.step_type === 'tool') {
        flush(out)
        const id = `${s.conversation_id ?? ''}:${s.step_index}`
        const info = s.tool_info ?? {}
        const name = String(info.name ?? s.tool_name ?? 'tool')
        if (!started.has(id)) {
          started.add(id)
          out.push({ type: 'tool', agent: 'gemini', id, kind: kindOf(name), name, summary: summary(info.parameters) })
        }
        if (s.state === 'DONE') out.push({ type: 'tool_result', agent: 'gemini', id, ok: !info.error, text: String(info.error?.message ?? info.output ?? '').slice(0, 4000) })
      }
    } else if (m.event === 'result' && m.result) {
      flush(out)
      const r = m.result
      const u = r.usage ?? {}
      const cached = Number(u.cache_read_tokens ?? 0)
      out.push({ type: 'usage', agent: 'gemini', input: Math.max(0, Number(u.input_tokens ?? 0) - cached), output: Number(u.output_tokens ?? 0), cached })
      const text = String(r.response ?? '').trim() || last
      if (r.status === 'SUCCESS') out.push({ type: 'done', agent: 'gemini', ok: true, text })
      else {
        const msg = String(r.error || `The run ended with status ${r.status ?? 'unknown'}`)
        out.push({ type: 'error', agent: 'gemini', kind: classifyError(msg), message: msg.slice(0, 500) })
        out.push({ type: 'done', agent: 'gemini', ok: false, text })
      }
    }
    return out
  }
}
