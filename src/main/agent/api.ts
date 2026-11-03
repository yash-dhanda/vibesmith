import type { Message, Provider, ToolCall } from './provider'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>
type Turn = { content: string; toolCalls: ToolCall[] }

// ---- shared ----
async function* sse(res: Response): AsyncGenerator<string> {
  const dec = new TextDecoder()
  let buf = ''
  const take = function* (final: boolean) {
    buf = buf.replace(/\r\n/g, '\n')
    let i: number
    while ((i = buf.indexOf('\n\n')) !== -1 || (final && buf.trim() && (i = buf.length))) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
      if (data) yield data
    }
  }
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true })
    yield* take(false)
  }
  yield* take(true)
}

async function httpError(res: Response, who: string): Promise<Error> {
  if (res.status === 401 || res.status === 403) return new Error(`${who}: the API key was rejected. Check it in Settings.`)
  if (res.status === 429) return new Error(`${who}: rate limited or out of credit. Try again later.`)
  let msg = ''
  try {
    const j = (await res.json()) as { error?: { message?: string } | string; message?: string }
    msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? ''
  } catch {}
  return new Error(`${who} ${res.status}: ${msg.slice(0, 300)}`)
}

const parseArgs = (s: string): unknown => {
  try {
    return s.trim() ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

async function post(f: FetchFn, who: string, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  let res: Response
  try {
    res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal })
  } catch (e) {
    if (signal.aborted) throw e
    throw new Error(`Cannot reach ${who}. Check your connection.`)
  }
  if (!res.ok) throw await httpError(res, who)
  return res
}

// ---- Anthropic Messages API ----
type AnthropicBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; tool_use_id: string; content: string }
type AnthropicMsg = { role: 'user' | 'assistant'; content: string | AnthropicBlock[] }

export function toAnthropic(messages: Message[]): { system: string; messages: AnthropicMsg[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const out: AnthropicMsg[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id ?? '', name: c.name, input: c.args })
      out.push({ role: 'assistant', content: blocks.length ? blocks : '(no output)' })
    } else if (m.role === 'user') out.push({ role: 'user', content: m.content })
    else {
      // consecutive tool results must share one user message
      const block: AnthropicBlock = { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }
      const last = out.at(-1)
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block)
      else out.push({ role: 'user', content: [block] })
    }
  }
  return { system, messages: out }
}

export function anthropic(opts: { apiKey: string; model: string; fetchFn?: FetchFn; maxTokens?: number }): Provider {
  const f = opts.fetchFn ?? fetch
  return {
    async chat(messages, tools, onText, signal): Promise<Turn> {
      const { system, messages: msgs } = toAnthropic(messages)
      const res = await post(
        f, 'Anthropic', 'https://api.anthropic.com/v1/messages',
        { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: opts.model, max_tokens: opts.maxTokens ?? 8192, stream: true, system, messages: msgs,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        },
        signal,
      )
      let content = ''
      const blocks = new Map<number, { id: string; name: string; json: string }>()
      for await (const data of sse(res)) {
        const e = JSON.parse(data) as {
          type: string; index?: number; error?: { message?: string }
          content_block?: { type: string; id?: string; name?: string }
          delta?: { type: string; text?: string; partial_json?: string }
        }
        if (e.type === 'error') throw new Error(`Anthropic: ${e.error?.message ?? 'stream error'}`)
        if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') blocks.set(e.index!, { id: e.content_block.id ?? '', name: e.content_block.name ?? '', json: '' })
        if (e.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta' && e.delta.text) {
            content += e.delta.text
            onText(e.delta.text)
          } else if (e.delta?.type === 'input_json_delta') {
            const b = blocks.get(e.index!)
            if (b) b.json += e.delta.partial_json ?? ''
          }
        }
      }
      return { content, toolCalls: [...blocks.values()].map((b) => ({ id: b.id, name: b.name, args: parseArgs(b.json) })) }
    },
  }
}

// ---- OpenAI-compatible chat completions: OpenAI, OpenRouter, and most local servers ----
export function toOpenAI(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant')
      return {
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length && { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }),
      }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    return m
  })
}

export function openaiCompat(opts: { who: string; baseUrl: string; apiKey: string; model: string; fetchFn?: FetchFn }): Provider {
  const f = opts.fetchFn ?? fetch
  return {
    async chat(messages, tools, onText, signal): Promise<Turn> {
      const res = await post(
        f, opts.who, `${opts.baseUrl}/chat/completions`,
        { authorization: `Bearer ${opts.apiKey}` },
        { model: opts.model, stream: true, messages: toOpenAI(messages), tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) },
        signal,
      )
      let content = ''
      const calls = new Map<number, { id: string; name: string; json: string }>()
      for await (const data of sse(res)) {
        if (data === '[DONE]') break
        const j = JSON.parse(data) as {
          error?: { message?: string }
          choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]
        }
        if (j.error) throw new Error(`${opts.who}: ${j.error.message ?? 'stream error'}`)
        const d = j.choices?.[0]?.delta
        if (d?.content) {
          content += d.content
          onText(d.content)
        }
        for (const tc of d?.tool_calls ?? []) {
          const c = calls.get(tc.index) ?? { id: '', name: '', json: '' }
          if (tc.id) c.id = tc.id
          if (tc.function?.name) c.name += tc.function.name
          if (tc.function?.arguments) c.json += tc.function.arguments
          calls.set(tc.index, c)
        }
      }
      return { content, toolCalls: [...calls.values()].map((c) => ({ id: c.id || undefined, name: c.name, args: parseArgs(c.json) })) }
    },
  }
}

export const openai = (o: { apiKey: string; model: string; fetchFn?: FetchFn }) => openaiCompat({ who: 'OpenAI', baseUrl: 'https://api.openai.com/v1', ...o })
export const openrouter = (o: { apiKey: string; model: string; fetchFn?: FetchFn }) => openaiCompat({ who: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', ...o })
