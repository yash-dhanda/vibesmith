import { describe, expect, it } from 'vitest'
import { classifyError } from './events'

describe('classifyError: Claude Code plan-limit wording', () => {
  it('treats every "You\'ve hit your ... limit" message as the plan running out, not a failure to retry', () => {
    for (const m of ["You've hit your session limit · resets 7pm", "You've hit your weekly limit", "You've hit your Opus limit", "You've hit your Sonnet limit", "You've hit your Fable limit", "You've hit your usage credit limit", "You've hit your limit · resets 7pm", "You've hit your 5-hour limit"]) expect(classifyError(m), m).toBe('limit')
    expect(classifyError('boom')).toBe('other')
  })
})
