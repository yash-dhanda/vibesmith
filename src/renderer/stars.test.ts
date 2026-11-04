import { describe, expect, it } from 'vitest'
import { compactCount } from './stars'

describe('compactCount', () => {
  it('shortens counts', () => {
    expect([0, 999, 1000, 12_400, 99_999, 100_000, 1_250_000].map(compactCount)).toEqual(['0', '999', '1k', '12.4k', '100k', '100k', '1.3M'])
  })
})
