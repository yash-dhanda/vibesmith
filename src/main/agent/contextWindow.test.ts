import { describe, expect, it } from 'vitest'
import { DEFAULT_WINDOW, contextWindowFor as w } from './contextWindow'

describe('contextWindowFor', () => {
  it('knows the families, with or without a provider or vendor prefix', () => {
    expect(w('anthropic:claude-sonnet-5-5')).toBe(200_000)
    expect(w('openrouter:anthropic/claude-haiku-5-5')).toBe(200_000)
    expect(w('openai:gpt-4o')).toBe(128_000)
    expect(w('openai:gpt-4o-mini')).toBe(128_000)
    expect(w('openrouter:openai/gpt-4.1-mini')).toBe(1_000_000)
    expect(w('openai:o3')).toBe(200_000)
    expect(w('openai:o4-mini')).toBe(200_000)
    expect(w('openai:gpt-5-mini')).toBe(400_000)
    expect(w('openrouter:google/gemini-2.5-pro')).toBe(1_000_000)
  })
  it('treats Claude as 1M only when the id says so', () => {
    expect(w('anthropic:claude-sonnet-4-5')).toBe(200_000)
    expect(w('anthropic:claude-sonnet-4-5[1m]')).toBe(1_000_000)
    expect(w('openrouter:anthropic/claude-sonnet-4-1m')).toBe(1_000_000)
  })
  it('falls back to the default for unknown or unsure models', () => {
    expect(w('openrouter:meta-llama/llama-3.1-70b')).toBe(DEFAULT_WINDOW)
    expect(w('openai:o1-preview')).toBe(DEFAULT_WINDOW)
    expect(w('openai:omni-x')).toBe(DEFAULT_WINDOW)
  })
  it('prefers the user setting, then a reported number, over the table', () => {
    expect(w('openai:gpt-4o', 32_000)).toBe(32_000)
    expect(w('openai:gpt-4o', 32_000, 64_000)).toBe(64_000)
    expect(w('openai:gpt-4o', 32_000, 0)).toBe(32_000) // 0 = automatic
  })
  it('clamps to 8k..2M and never throws on garbage', () => {
    expect(w('x', 100)).toBe(8_000)
    expect(w('x', 9e9)).toBe(2_000_000)
    expect(w('x', NaN, -5)).toBe(DEFAULT_WINDOW)
    expect(w('x', Infinity)).toBe(DEFAULT_WINDOW)
    expect(w(undefined as unknown as string, 'abc' as unknown as number)).toBe(DEFAULT_WINDOW)
    expect(w('')).toBe(DEFAULT_WINDOW)
  })
})
