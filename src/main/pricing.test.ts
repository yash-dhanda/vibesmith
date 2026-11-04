import { describe, expect, it } from 'vitest'
import { costOf, priceFor } from './pricing'

describe('pricing', () => {
  it('prices a known cloud model per million tokens', () => {
    const p = priceFor('anthropic:claude-sonnet-5-5')!
    expect(costOf(p, 1_000_000, 100_000)).toBeCloseTo(3) // $2 in + $1 out
  })
  it('Haiku bills a prompt over 100K tokens at the higher tier', () => {
    const p = priceFor('anthropic:claude-haiku-5-5')!
    expect(costOf(p, 100_000, 10_000)).toBeCloseTo(0.015) // $0.10 in + $0.50 out per million
    expect(costOf(p, 100_001, 10_000)).toBeCloseTo(0.0750005) // $0.50 in + $2.50 out
  })
  it('has no price for local or unknown models', () => {
    expect(priceFor('ollama:qwen3.5:9b')).toBeNull()
    expect(priceFor('openai:gpt-x')).toBeNull()
  })
})
