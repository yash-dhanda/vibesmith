import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

  it('skips a call when the ledger cannot be written instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-usage-'))
    const s = new UsageStore(dir)
    mkdirSync(join(dir, 'usage.json.tmp')) // the temp name is taken by a folder, so the write fails
    expect(() => s.record('m', { input: 1, output: 1, genMs: 0 }, NOW)).not.toThrow()
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

describe('UsageStore: damaged or unreadable ledger', () => {
  const seeded = () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-usage-'))
    const st = new UsageStore(dir)
    st.record('m', { input: 30_000_000, output: 0, genMs: 0 }, daysAgo(5))
    return { dir, st, file: join(dir, 'usage.json') }
  }

  it.skipIf(process.getuid?.() === 0)('a read that fails for any reason but "no file" never overwrites the history', () => {
    const { st, file } = seeded()
    chmodSync(file, 0o000)
    st.record('m', { input: 10, output: 0, genMs: 0 }, NOW) // cannot read: must skip, not write {} + this call
    expect(st.summary(NOW).allTime.calls).toBe(0) // and the summary does not throw
    chmodSync(file, 0o600)
    expect(st.summary(NOW).allTime).toEqual({ input: 30_000_000, output: 0, calls: 1 })
  })

  it('a corrupt file is kept aside as .bad-* and a fresh ledger starts', () => {
    const { dir, st, file } = seeded()
    writeFileSync(file, '{ nope')
    st.record('m', { input: 1, output: 0, genMs: 0 }, NOW)
    expect(st.summary(NOW).allTime.calls).toBe(1)
    const bad = readdirSync(dir).filter((f) => f.startsWith('usage.json.bad-'))
    expect(bad).toHaveLength(1)
    expect(readFileSync(join(dir, bad[0]), 'utf8')).toBe('{ nope')
  })

  it('valid JSON of the wrong shape does not break the summary', () => {
    for (const body of ['null', '[1]', '{"2026-11-03":null,"2026-11-02":{"m":null},"2026-11-01":{"m":{"input":5,"output":1,"calls":1,"genMs":0,"genTokens":0}}}']) {
      const { st, file } = seeded()
      writeFileSync(file, body)
      const s = st.summary(NOW)
      expect(s.byDay).toHaveLength(14)
      expect(s.allTime.calls).toBe(body.includes('"calls":1') ? 1 : 0)
      expect(() => st.record('m', { input: 1, output: 0, genMs: 0 }, NOW)).not.toThrow()
      expect(existsSync(file)).toBe(true)
    }
  })
})

describe('UsageStore: daylight-saving changes', () => {
  it.each([
    ['America/New_York', [2026, 2, 9, 0, 30]],
    ['America/New_York', [2026, 10, 2, 23, 30]],
    ['Europe/Berlin', [2026, 9, 26, 23, 30]],
  ])('%s: every one of the last 14 days appears once, and the week adds up', (tz, [y, mo, d, h, mi]) => {
    const old = process.env.TZ
    process.env.TZ = tz
    try {
      const at = (i: number, hh: number, m = 0) => new Date(y, mo, d - i, hh, m)
      const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const now = at(0, h, mi).getTime()
      const st = new UsageStore(mkdtempSync(join(tmpdir(), 'forge-usage-')))
      for (let i = 0; i < 20; i++) st.record('m', { input: 100, output: 0, genMs: 0 }, at(i, 12).getTime())
      const s = st.summary(now)
      expect(s.byDay.map((d) => d.day)).toEqual(Array.from({ length: 14 }, (_, k) => key(at(13 - k, 12))))
      expect(s.last7.input).toBe(700)
    } finally {
      if (old === undefined) delete process.env.TZ
      else process.env.TZ = old
    }
  })
})
