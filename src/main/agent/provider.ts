import { parseTextToolCalls } from './guards'
import type { ToolDef } from './tools'

export type ToolCall = { name: string; args: unknown }
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolName: string }

export interface Provider {
  // Streams text through onText; resolves with the full turn once the model stops.
  chat(messages: Message[], tools: ToolDef[], onText: (t: string) => void, signal: AbortSignal): Promise<{ content: string; toolCalls: ToolCall[] }>
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

type OllamaLine = { message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] }; error?: string }

// Native /api/chat, not the OpenAI-compatible /v1: only the native API accepts num_ctx per request.
export function ollama(opts: { model: string; host?: string; numCtx?: number }): Provider {
  const host = opts.host ?? 'http://127.0.0.1:11434'
  return {
    async chat(messages, tools, onText, signal) {
      const body = {
        model: opts.model,
        stream: true,
        think: false,
        options: { num_ctx: opts.numCtx ?? 8192 },
        tools: tools.map((t) => ({ type: 'function', function: t })),
        messages: messages.map((m) =>
          m.role === 'assistant'
            ? { role: 'assistant', content: m.content, tool_calls: m.toolCalls?.map((c) => ({ function: { name: c.name, arguments: c.args } })) }
            : m.role === 'tool'
              ? { role: 'tool', content: m.content, tool_name: m.toolName }
              : m,
        ),
      }
      let res: Response
      try {
        res = await fetch(`${host}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal })
      } catch (e) {
        if (signal.aborted) throw e
        throw new Error(`Cannot reach Ollama at ${host}. Is "ollama serve" running?`)
      }
      if (!res.ok) {
        const text = await res.text()
        throw new Error(res.status === 404 ? `Model "${opts.model}" not found. Run: ollama pull ${opts.model}` : `Ollama ${res.status}: ${text.slice(0, 200)}`)
      }
      let content = ''
      const toolCalls: ToolCall[] = []
      const decoder = new TextDecoder()
      let buf = ''
      const take = (line: string) => {
        if (!line.trim()) return
        const j = JSON.parse(line) as OllamaLine
        if (j.error) throw new Error(j.error)
        if (j.message?.content) {
          content += j.message.content
          onText(j.message.content)
        }
        for (const c of j.message?.tool_calls ?? []) {
          let args = c.function.arguments
          if (typeof args === 'string') args = safeJson(args)
          toolCalls.push({ name: c.function.name, args })
        }
      }
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        lines.forEach(take)
      }
      take(buf)
      // Some models write the call as text instead of using the tool-call channel.
      if (!toolCalls.length) {
        const t = parseTextToolCalls(content)
        if (t.calls.length) return { content: t.content, toolCalls: t.calls }
      }
      return { content, toolCalls }
    },
  }
}
