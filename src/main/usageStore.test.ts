import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { UsageStore } from './usageStore'

let store: UsageStore
const NOW = new Date(2026, 10, 3, 15, 0).getTime()
const daysAgo = (n: number) => NOW - n * 86_400_000
beforeEach(() => {
  store = new UsageStore(mkdtempSync(join(tmpdir(), 'forge-usage-')))
})

describe('UsageStore', () => {
  it('is empty at first', () => {
    const s = store.summary(NOW)
    expect(s.allTime).toEqual({ input: 0, output: 0, calls: 0 })
    expect(s.byModel).toEqual([])
    expect(s.byDay).toHaveLength(14)
  })

  it('adds up tokens across calls, days and models', () => {
    store.record('ollama:qwen3:8b', { input: 1000, output: 200, genMs: 5000 }, NOW)
    store.record('ollama:qwen3:8b', { input: 3000, output: 300, genMs: 5000 }, NOW)
    store.record('anthropic:claude-sonnet-5-5', { input: 10_000, output: 1000, genMs: 10_000 }, daysAgo(2))
    store.record('ollama:qwen3:8b', { input: 500, output: 50, genMs: 1000 }, daysAgo(20))
    const s = store.summary(NOW)
    expect(s.allTime).toEqual({ input: 14_500, output: 1550, calls: 4 })
    expect(s.today).toEqual({ input: 4000, output: 500 })
    expect(s.last7).toEqual({ input: 14_000, output: 1500 }) // the 20-day-old call is outside the week
    expect(s.byModel.map((m) => m.model)).toEqual(['anthropic:claude-sonnet-5-5', 'ollama:qwen3:8b'])
    expect(s.byDay.at(-1)).toEqual({ day: '2026-11-03', tokens: 4500 })
    expect(s.byDay.find((d) => d.day === '2026-11-01')!.tokens).toBe(11_000)
  })

  it('tokens per second is generated tokens over generation time, ignoring calls with no timing', () => {
    store.record('m', { input: 100, output: 400, genMs: 10_000 }, NOW) // 40 tok/s
    store.record('m', { input: 100, output: 100, genMs: 5000 }, NOW) // 20 tok/s
    store.record('m', { input: 100, output: 9999, genMs: 0 }, NOW) // estimate: must not skew the rate
    expect(store.summary(NOW).byModel[0].avgTps).toBeCloseTo(500 / 15, 5)
  })

  it('survives a restart and a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-usage-'))
    new UsageStore(dir).record('m', { input: 1, output: 2, genMs: 0 }, NOW)
    expect(new UsageStore(dir).summary(NOW).allTime.input).toBe(1)
    require('node:fs').writeFileSync(join(dir, 'usage.json'), '{ nope')
    expect(new UsageStore(dir).summary(NOW).allTime.calls).toBe(0)
  })

  it('splits today by agent: Crew work and Solo local models', () => {
    store.record('crew:claude', { input: 1000, output: 100, genMs: 0 }, NOW)
    store.record('crew:codex', { input: 2000, output: 200, genMs: 0 }, NOW)
    store.record('crew:codex', { input: 50, output: 50, genMs: 0 }, daysAgo(3))
    store.record('ollama:qwen3:8b', { input: 10, output: 5, genMs: 0 }, NOW)
    const by = Object.fromEntries(store.summary(NOW).byAgent.map((a) => [a.agent, a]))
    expect(by.claude).toMatchObject({ today: 1100, allTime: 1100 })
    expect(by.codex).toMatchObject({ today: 2200, last7: 2300, allTime: 2300 })
    expect(by.local).toMatchObject({ today: 15 })
  })
})
