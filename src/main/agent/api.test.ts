import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anthropic, openai, openrouter, toAnthropic, toOpenAI } from './api'
import { ollama } from './provider'
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
    { type: 'message_start', message: { usage: { input_tokens: 1200, cache_read_input_tokens: 300 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"a.js"}' } },
    { type: 'message_delta', usage: { output_tokens: 87 } },
    { type: 'message_stop' },
  ]

  it('streams text and assembles tool calls; sends key in header only', async () => {
    let req: { url: string; init: RequestInit } | null = null
    const p = anthropic({ apiKey: 'sk-ant-secret', model: 'claude-sonnet-5-5', fetchFn: async (url, init) => ((req = { url, init }), sseRes(events)) })
    const seen: string[] = []
    const turn = await p.chat(history, toolDefs, (t) => seen.push(t), signal)
    expect(seen.join('')).toBe('Let me check.')
    expect(turn.content).toBe('Let me check.')
    expect(turn.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', args: { path: 'a.js' } }])
    expect(turn.usage).toMatchObject({ input: 1500, output: 87 }) // cached input tokens count as input
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
    { choices: [], usage: { prompt_tokens: 640, completion_tokens: 55 } },
    '[DONE]',
  ]

  it('leaves out tools when there are none (OpenAI refuses an empty list)', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchFn = async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(init.body as string)), sseRes(events))
    await openrouter({ apiKey: 'k', model: 'm', fetchFn }).chat(history, [], () => {}, signal)
    await anthropic({ apiKey: 'k', model: 'm', fetchFn }).chat(history, [], () => {}, signal).catch(() => {})
    expect(bodies).toHaveLength(2)
    for (const b of bodies) expect('tools' in b).toBe(false)
  })

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
    expect(turn.usage).toMatchObject({ input: 640, output: 55 })
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

describe('ollama provider usage', () => {
  const ndjson = (lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  it('reads token counts and generation time from the final line, and sends num_ctx', async () => {
    let body: { options: { num_ctx: number } } | null = null
    const p = ollama({
      model: 'qwen3:8b', numCtx: 16_384,
      fetchFn: async (_u, init) => ((body = JSON.parse(init.body as string)), ndjson([{ message: { content: 'Hi' } }, { message: { content: '!' }, done: true, prompt_eval_count: 812, eval_count: 40, eval_duration: 1_000_000_000 }])),
    })
    const turn = await p.chat(history, toolDefs, () => {}, signal)
    expect(turn.content).toBe('Hi!')
    expect(turn.usage).toEqual({ input: 812, output: 40, genMs: 1000, ctxLimit: 16_384 })
    expect(body!.options.num_ctx).toBe(16_384)
  })
  it('explains an unreachable Ollama and a missing model', async () => {
    const down = ollama({ model: 'm', fetchFn: async () => { throw new Error('ECONNREFUSED') } })
    await expect(down.chat(history, toolDefs, () => {}, signal)).rejects.toThrow(/Cannot reach Ollama/)
    const missing = ollama({ model: 'ghost', fetchFn: async () => new Response('{}', { status: 404 }) })
    await expect(missing.chat(history, toolDefs, () => {}, signal)).rejects.toThrow(/ollama pull ghost/)
  })
})

describe('ollama provider over a real connection', () => {
  it('streams from a local server through the patient connection (no idle timeout)', async () => {
    const http = await import('node:http')
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      setTimeout(() => res.end(JSON.stringify({ message: { content: 'hi there' }, done: true, prompt_eval_count: 5, eval_count: 2, eval_duration: 1_000_000_000 }) + '\n'), 150)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const turn = await ollama({ model: 'm', host: `http://127.0.0.1:${port}` }).chat(history, toolDefs, () => {}, signal)
      expect(turn.content).toBe('hi there')
      expect(turn.usage).toMatchObject({ input: 5, output: 2 })
    } finally {
      server.close()
    }
  })
})

describe('pictures in messages', () => {
  const png = Buffer.from([137, 80, 78, 71])
  const withImage = (): Message[] => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-img-'))
    const path = join(dir, 'a.png')
    writeFileSync(path, png)
    return [{ role: 'user', content: 'what is this?', images: [{ mime: 'image/png', path }] }]
  }
  const b64 = png.toString('base64')
  it('OpenAI-compatible: text plus an image_url data URL', () => {
    expect(toOpenAI(withImage())).toEqual([{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }])
  })
  it('Anthropic: image block before the text', () => {
    expect(toAnthropic(withImage()).messages).toEqual([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }, { type: 'text', text: 'what is this?' }] }])
  })
  it('Ollama: base64 images on the user message, and no file paths leak into the request', async () => {
    let body = ''
    const p = ollama({ model: 'm', fetchFn: async (_u, init) => ((body = String(init.body)), new Response('{"message":{"content":"x"},"done":true,"eval_count":1}\n')) })
    await p.chat(withImage(), [], () => {}, new AbortController().signal)
    const sent = JSON.parse(body).messages[0]
    expect(sent).toEqual({ role: 'user', content: 'what is this?', images: [b64] })
  })
})

describe('onlyLatestImages', () => {
  it('keeps pictures on the newest message that has them only', async () => {
    const { onlyLatestImages } = await import('./images')
    const img = [{ mime: 'image/png', path: '/x.png' }]
    const out = onlyLatestImages([{ role: 'user', content: 'a', images: img }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'b', images: img }, { role: 'user', content: 'c' }])
    expect(out.map((m) => !!(m as { images?: unknown }).images)).toEqual([false, false, true, false])
  })
})
