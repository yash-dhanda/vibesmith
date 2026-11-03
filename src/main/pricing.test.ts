import { describe, expect, it } from 'vitest'
import { costOf, priceFor } from './pricing'

describe('pricing', () => {
  it('prices a known cloud model per million tokens', () => {
    const p = priceFor('anthropic:claude-sonnet-5-5')!
    expect(costOf(p, 1_000_000, 100_000)).toBeCloseTo(3) // $2 in + $1 out
  })
  it('has no price for local or unknown models', () => {
    expect(priceFor('ollama:qwen3.5:9b')).toBeNull()
    expect(priceFor('openai:gpt-x')).toBeNull()
  })
})
