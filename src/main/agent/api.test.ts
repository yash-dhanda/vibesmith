import { describe, expect, it } from 'vitest'
import { anthropic, openai, openrouter, toAnthropic, toOpenAI } from './api'
import type { Message } from './provider'
import { toolDefs } from './tools'

const sseRes = (events: unknown[], chunkSize = 40) => {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
  const enc = new TextEncoder().encode(text)
  // deliver in small odd-sized pieces so events are split across chunks
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < enc.length; i += chunkSize) c.enqueue(enc.slice(i, i + chunkSize))
        c.close()
      },
    }),
    { status: 200 },
  )
}

const signal = new AbortController().signal
const history: Message[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'fix it' },
  { role: 'assistant', content: 'looking', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.js' } }, { id: 'c2', name: 'list_dir', args: { path: '.' } }] },
  { role: 'tool', content: 'code', toolName: 'read_file', toolCallId: 'c1' },
  { role: 'tool', content: 'a.js', toolName: 'list_dir', toolCallId: 'c2' },
]

describe('message conversion', () => {
  it('anthropic: system hoisted, tool results merged into one user message', () => {
    const r = toAnthropic(history)
    expect(r.system).toBe('sys')
    expect(r.messages).toEqual([
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.js' } }, { type: 'tool_use', id: 'c2', name: 'list_dir', input: { path: '.' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'code' }, { type: 'tool_result', tool_use_id: 'c2', content: 'a.js' }] },
    ])
  })
  it('openai: tool calls carry JSON string arguments, results carry the call id', () => {
    const r = toOpenAI(history) as { role: string; tool_calls?: { id: string; function: { arguments: string } }[]; tool_call_id?: string }[]
    expect(r[2].tool_calls![0]).toMatchObject({ id: 'c1', function: { arguments: '{"path":"a.js"}' } })
    expect(r[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'code' })
  })
})

describe('anthropic provider', () => {
  const events = [
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"a.js"}' } },
    { type: 'message_stop' },
  ]

  it('streams text and assembles tool calls; sends key in header only', async () => {
    let req: { url: string; init: RequestInit } | null = null
    const p = anthropic({ apiKey: 'sk-ant-secret', model: 'claude-sonnet-5-5', fetchFn: async (url, init) => ((req = { url, init }), sseRes(events)) })
    const seen: string[] = []
    const turn = await p.chat(history, toolDefs, (t) => seen.push(t), signal)
    expect(seen.join('')).toBe('Let me check.')
    expect(turn).toEqual({ content: 'Let me check.', toolCalls: [{ id: 'toolu_1', name: 'read_file', args: { path: 'a.js' } }] })
    expect(req!.url).toBe('https://api.anthropic.com/v1/messages')
    const headers = req!.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-secret')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(req!.init.body as string)
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', stream: true, system: 'sys' })
    expect(body.tools[0]).toMatchObject({ name: 'list_dir', input_schema: { type: 'object' } })
    expect(req!.init.body as string).not.toContain('sk-ant-secret')
  })

  it('maps 401 to a key message and stream errors to errors', async () => {
    const bad = anthropic({ apiKey: 'k', model: 'm', fetchFn: async () => new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 }) })
    await expect(bad.chat(history, toolDefs, () => {}, signal)).rejects.toThrow(/API key was rejected/)
    const mid = anthropic({ apiKey: 'k', model: 'm', fetchFn: async () => sseRes([{ type: 'error', error: { message: 'Overloaded' } }]) })
    await expect(mid.chat(history, toolDefs, () => {}, signal)).rejects.toThrow(/Anthropic: Overloaded/)
  })

  it('reports an unreachable network without leaking details', async () => {
    const p = anthropic({ apiKey: 'k', model: 'm', fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND') } })
    await expect(p.chat(history, toolDefs, () => {}, signal)).rejects.toThrow('Cannot reach Anthropic. Check your connection.')
  })
})

describe('openai-compatible providers', () => {
  const events = [
    { choices: [{ delta: { role: 'assistant', content: 'Re' } }] },
    { choices: [{ delta: { content: 'ading' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'search', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pattern":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"foo"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_10', function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }] },
    '[DONE]',
  ]

  it('assembles streamed text and parallel tool calls', async () => {
    let url = ''
    let auth = ''
    const p = openrouter({
      apiKey: 'or-key', model: 'some/model',
      fetchFn: async (u, init) => ((url = u), (auth = (init.headers as Record<string, string>).authorization), sseRes(events, 25)),
    })
    const seen: string[] = []
    const turn = await p.chat(history, toolDefs, (t) => seen.push(t), signal)
    expect(seen.join('')).toBe('Reading')
    expect(turn.toolCalls).toEqual([
      { id: 'call_9', name: 'search', args: { pattern: 'foo' } },
      { id: 'call_10', name: 'list_dir', args: { path: '.' } },
    ])
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(auth).toBe('Bearer or-key')
  })

  it('openai targets api.openai.com and survives malformed tool arguments', async () => {
    let url = ''
    const p = openai({
      apiKey: 'k', model: 'm',
      fetchFn: async (u) => ((url = u), sseRes([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'read_file', arguments: '{"path": ' } }] } }] }, '[DONE]'])),
    })
    const turn = await p.chat(history, toolDefs, () => {}, signal)
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(turn.toolCalls).toEqual([{ id: 'x', name: 'read_file', args: {} }]) // bad JSON becomes empty args; the tool then reports the missing argument
  })

  it('maps 429 and other errors to readable messages', async () => {
    const limited = openai({ apiKey: 'k', model: 'm', fetchFn: async () => new Response('{}', { status: 429 }) })
    await expect(limited.chat(history, toolDefs, () => {}, signal)).rejects.toThrow(/rate limited or out of credit/)
    const broken = openai({ apiKey: 'k', model: 'nope', fetchFn: async () => new Response('{"error":{"message":"The model does not exist"}}', { status: 404 }) })
    await expect(broken.chat(history, toolDefs, () => {}, signal)).rejects.toThrow('OpenAI 404: The model does not exist')
  })

  it('passes an abort through instead of reporting a network error', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const p = openai({ apiKey: 'k', model: 'm', fetchFn: async (_u, init) => { if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError'); return sseRes([]) } })
    await expect(p.chat(history, toolDefs, () => {}, ctl.signal)).rejects.toThrow(/abort/i)
  })
})
