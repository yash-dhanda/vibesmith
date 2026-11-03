import { describe, expect, it } from 'vitest'
import { estimateTokens, trimMessages } from './context'
import type { Message } from './provider'

const big = (n: number, ch = 'x') => ch.repeat(n)
const convo = (): Message[] => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'build me an app' },
  { role: 'assistant', content: 'ok', toolCalls: [{ id: '1', name: 'create_file', args: { path: 'a.js', content: big(8000) } }] },
  { role: 'tool', content: 'created a.js', toolName: 'create_file', toolCallId: '1' },
  { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'read_file', args: { path: 'a.js' } }] },
  { role: 'tool', content: big(8000, 'y'), toolName: 'read_file', toolCallId: '2' },
  { role: 'assistant', content: 'now b', toolCalls: [{ id: '3', name: 'create_file', args: { path: 'b.js', content: 'small' } }] },
  { role: 'tool', content: 'created b.js', toolName: 'create_file', toolCallId: '3' },
  { role: 'user', content: 'recent question' },
  { role: 'assistant', content: 'recent answer' },
]

describe('trimMessages', () => {
  it('does nothing when the conversation already fits', () => {
    const m = convo()
    const before = JSON.stringify(m)
    expect(trimMessages(m, 100_000)).toBe(0)
    expect(JSON.stringify(m)).toBe(before)
  })

  it('shrinks old bulky output and file contents until it fits, oldest first', () => {
    const m = convo()
    const before = estimateTokens(m)
    expect(before).toBeGreaterThan(4000)
    const changed = trimMessages(m, 3000)
    expect(changed).toBeGreaterThan(0)
    expect(estimateTokens(m)).toBeLessThan(3000 * 0.55 + 200)
    const create = m[2] as Extract<Message, { role: 'assistant' }>
    expect((create.toolCalls![0].args as { content: string }).content).toContain('older text trimmed')
    expect((create.toolCalls![0].args as { path: string }).path).toBe('a.js') // structure stays valid
    expect(create.toolCalls![0].id).toBe('1')
    expect((m[5] as { content: string }).content).toContain('older output trimmed')
  })

  it('never touches the system prompt, the first request or the most recent messages', () => {
    const m = convo()
    m[1].content = big(5000, 'q') // the original request is long but must survive intact
    const recent = m.slice(-2).map((x) => JSON.stringify(x))
    trimMessages(m, 500)
    expect(m[0].content).toBe('sys')
    expect(m[1].content).toHaveLength(5000)
    expect(m.slice(-2).map((x) => JSON.stringify(x))).toEqual(recent) // the newest two always stay whole
  })

  it('keeps tool_call ids paired with their results (providers reject a broken pair)', () => {
    const m = convo()
    trimMessages(m, 1000)
    const ids = m.flatMap((x) => (x.role === 'assistant' ? (x.toolCalls ?? []).map((c) => c.id) : []))
    const results = m.flatMap((x) => (x.role === 'tool' ? [x.toolCallId] : []))
    expect(results.every((r) => ids.includes(r))).toBe(true)
    expect(m).toHaveLength(convo().length)
  })

  it('is safe on tiny or empty input', () => {
    expect(trimMessages([], 100)).toBe(0)
    expect(trimMessages([{ role: 'system', content: 's' }], 100)).toBe(0)
  })
})
