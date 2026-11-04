import { describe, expect, it } from 'vitest'
import { effortFor } from './effort'

const cfg = (effortMode: 'fixed' | 'auto' | 'cheap' | undefined, claudeEffort: 'high' | 'low' | 'max' | undefined = 'high', codexEffort: 'high' | undefined = 'high') => ({ effortMode, claudeEffort, codexEffort })

describe('effortFor', () => {
  it('fixed keeps what is configured, for every phase', () => {
    for (const phase of ['work', 'review', 'final-review', 'plan', 'fix'] as const) expect(effortFor({ agent: 'claude', phase, kind: 'build', changedFiles: 1, config: cfg('fixed') })).toBe('high')
    expect(effortFor({ agent: 'codex', phase: 'review', kind: 'build', config: { effortMode: 'fixed' } })).toBeUndefined()
  })
  it('the local model has no effort in any mode', () => {
    for (const m of ['fixed', 'auto', 'cheap'] as const) expect(effortFor({ agent: 'local', phase: 'work', kind: 'build', config: cfg(m) })).toBeUndefined()
  })
  it('auto: build, fix, plan and conflict work keep the configured effort', () => {
    for (const phase of ['work', 'fix', 'plan', 'conflict'] as const) expect(effortFor({ agent: 'claude', phase, kind: 'build', config: cfg('auto', 'max') })).toBe('max')
    expect(effortFor({ agent: 'claude', phase: 'work', kind: 'test', config: cfg(undefined) })).toBe('high') // auto is the default
  })
  it('auto: research and reviews of small diffs drop to medium, big diffs and unknown sizes do not, and nothing goes above the configured value', () => {
    expect(effortFor({ agent: 'codex', phase: 'work', kind: 'research', config: cfg('auto') })).toBe('medium')
    expect(effortFor({ agent: 'claude', phase: 'review', kind: 'build', changedFiles: 3, config: cfg('auto') })).toBe('medium')
    expect(effortFor({ agent: 'claude', phase: 'final-review', kind: 'research', changedFiles: 5, config: cfg('auto', 'max') })).toBe('medium')
    expect(effortFor({ agent: 'claude', phase: 'final-review', kind: 'research', changedFiles: 6, config: cfg('auto', 'max') })).toBe('max')
    expect(effortFor({ agent: 'claude', phase: 'review', kind: 'build', config: cfg('auto') })).toBe('high')
    expect(effortFor({ agent: 'claude', phase: 'review', kind: 'build', changedFiles: 1, config: cfg('auto', 'low') })).toBe('low')
    expect(effortFor({ agent: 'claude', phase: 'review', kind: 'build', changedFiles: 1, config: cfg('auto', undefined) })).toBe('medium')
  })
  it('cheap: low for everything that only reads, medium at most for planning and writing, never above the configured value', () => {
    for (const phase of ['review', 'final-review'] as const) expect(effortFor({ agent: 'claude', phase, kind: 'build', changedFiles: 40, config: cfg('cheap') })).toBe('low')
    expect(effortFor({ agent: 'claude', phase: 'work', kind: 'research', config: cfg('cheap') })).toBe('low')
    for (const phase of ['work', 'fix', 'plan'] as const) expect(effortFor({ agent: 'codex', phase, kind: 'build', config: cfg('cheap') })).toBe('medium')
    expect(effortFor({ agent: 'claude', phase: 'work', kind: 'build', config: cfg('cheap', 'low') })).toBe('low')
  })
})
