import { patientFetch } from '../net'
import { parseTextToolCalls } from './guards'
import type { ToolDef } from './tools'
import { getHost } from '../ollamaHost'
import { imageB64, type ImageRef } from './images'

export type ToolCall = { name: string; args: unknown; id?: string }
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ImageRef[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolName: string; toolCallId?: string }

// What one model call cost. genMs is the time spent generating (not loading or reading the prompt), so output/genMs is tokens per second.
export type Usage = { input: number; output: number; genMs: number; ctxLimit?: number; estimated?: boolean }
// truncated: the model ran into its output limit, so any tool call in this turn is cut off mid-way.
export type Turn = { content: string; toolCalls: ToolCall[]; usage?: Usage; truncated?: boolean }

export interface Provider {
  // Streams text through onText; resolves with the full turn once the model stops.
  // hints.explore asks for a more varied answer, used to break a loop where the model repeats itself.
  chat(messages: Message[], tools: ToolDef[], onText: (t: string) => void, signal: AbortSignal, hints?: { explore?: boolean }): Promise<Turn>
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

type OllamaLine = {
  message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] }
  error?: string
  prompt_eval_count?: number
  eval_count?: number
  eval_duration?: number // nanoseconds
}

// Native /api/chat, not the OpenAI-compatible /v1: only the native API accepts num_ctx per request.
export function ollama(opts: { model: string; host?: string; numCtx?: number; temperature?: number; fetchFn?: (url: string, init: RequestInit) => Promise<Response> }): Provider {
  const host = opts.host ?? getHost()
  const f = opts.fetchFn ?? patientFetch
  const numCtx = opts.numCtx ?? 8192
  return {
    async chat(messages, tools, onText, signal, hints) {
      const body = {
        model: opts.model,
        stream: true,
        think: false,
        options: { num_ctx: numCtx, num_predict: 8192, temperature: hints?.explore ? 0.9 : (opts.temperature ?? 0.3) }, // num_predict: a runaway answer ends instead of burning an hour // low: an agent needs the same answer to the same question, not variety
        tools: tools.map((t) => ({ type: 'function', function: t })),
        messages: messages.map((m) =>
          m.role === 'assistant'
            ? { role: 'assistant', content: m.content, tool_calls: m.toolCalls?.map((c) => ({ function: { name: c.name, arguments: c.args } })) }
            : m.role === 'tool'
              ? { role: 'tool', content: m.content, tool_name: m.toolName }
              : m.role === 'user' && m.images?.length
                ? { role: 'user', content: m.content, images: m.images.map(imageB64) }
                : { role: m.role, content: m.content },
        ),
      }
      let res: Response
      try {
        res = await f(`${host}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal })
      } catch (e) {
        if (signal.aborted) throw e
        throw new Error(`Cannot reach Ollama at ${host}. Is "ollama serve" running?`)
      }
      if (!res.ok) {
        const text = await res.text()
        throw new Error(res.status === 404 ? `Model "${opts.model}" not found. Run: ollama pull ${opts.model}` : `Ollama ${res.status}: ${text.slice(0, 200)}`)
      }
      let content = ''
      let usage: Usage | undefined
      const toolCalls: ToolCall[] = []
      const decoder = new TextDecoder()
      let buf = ''
      const take = (line: string) => {
        if (!line.trim()) return
        const j = JSON.parse(line) as OllamaLine
        if (j.error) throw new Error(j.error)
        if (j.eval_count !== undefined) usage = { input: j.prompt_eval_count ?? 0, output: j.eval_count, genMs: (j.eval_duration ?? 0) / 1e6, ctxLimit: numCtx }
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
        if (t.calls.length) return { content: t.content, toolCalls: t.calls, usage }
      }
      return { content, toolCalls, usage }
    },
  }
}
