import { describe, expect, it } from 'vitest'
import { FEATURE_IDEAS, featureIdeasFor } from './featureIdeas'

describe('feature ideas', () => {
  it('has unique ids and complete entries', () => {
    expect(FEATURE_IDEAS.length).toBeGreaterThanOrEqual(38)
    expect(new Set(FEATURE_IDEAS.map((f) => f.id)).size).toBe(FEATURE_IDEAS.length)
    for (const f of FEATURE_IDEAS) {
      expect(f.title.length, f.id).toBeGreaterThan(4)
      expect(f.why.split(/[.!?]\s/).length, f.id).toBe(1)
      expect(f.goal.length, f.id).toBeGreaterThan(200)
    }
  })
  it('gives any-stack ideas to every project and stack ideas only to matching ones', () => {
    const ids = (s: string[]) => featureIdeasFor(s).map((f) => f.id)
    expect(ids([])).toContain('ci-pipeline')
    expect(ids([])).not.toContain('auth-sessions')
    expect(ids(['node', 'express'])).toEqual(expect.arrayContaining(['auth-sessions', 'rate-limiting', 'security-headers']))
    expect(ids(['node', 'express'])).not.toContain('dark-mode')
    expect(ids(['react'])).toContain('dark-mode')
    expect(ids(['discord.js'])).toContain('bot-persistence')
    expect(ids(['python', 'flask'])).toContain('csrf')
  })
})
