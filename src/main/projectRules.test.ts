import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { effectiveRules, MAX_RULES_BYTES, readRules, writeRules } from './projectRules'

const project = () => { const p = mkdtempSync(join(tmpdir(), 'rules-')); mkdirSync(join(p, '.git')); return p }

describe('project rules', () => {
  it('has no rules until written, then round-trips and hides .forge from git', () => {
    const p = project()
    expect(readRules(p)).toBeNull()
    expect(effectiveRules(p, 'old brief rules')).toBe('old brief rules')
    writeRules(p, 'Always run tests.\r\nNever touch dist/.')
    expect(readRules(p)).toBe('Always run tests.\nNever touch dist/.')
    expect(effectiveRules(p, 'old brief rules')).toContain('Never touch')
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toContain('.forge/')
    writeRules(p, '') // cleared on purpose: the old field does not come back
    expect(effectiveRules(p, 'old brief rules')).toBe('')
    expect(existsSync(join(p, '.forge', 'rules.md'))).toBe(true)
  })

  it('refuses text over 64 KB and non-text', () => {
    const p = project()
    expect(() => writeRules(p, 'x'.repeat(MAX_RULES_BYTES + 1))).toThrow(/64 KB/)
    expect(() => writeRules(p, 42)).toThrow()
    expect(() => writeRules(p, 'x'.repeat(MAX_RULES_BYTES))).not.toThrow()
  })

  it('never follows a link for the folder or the file', () => {
    const p = project()
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'))
    symlinkSync(elsewhere, join(p, '.forge'))
    expect(() => writeRules(p, 'x')).toThrow(/link/)
    expect(readRules(p)).toBeNull()
    const q = project()
    mkdirSync(join(q, '.forge'))
    symlinkSync(join(elsewhere, 'target.md'), join(q, '.forge', 'rules.md'))
    expect(() => writeRules(q, 'x')).toThrow(/link/)
    expect(readRules(q)).toBeNull()
    expect(existsSync(join(elsewhere, 'target.md'))).toBe(false)
  })
})
