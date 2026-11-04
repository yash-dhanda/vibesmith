import { describe, expect, it } from 'vitest'
import { dollars, forecastLine, seconds } from './crewStats'

const f = (o: Partial<Parameters<typeof forecastLine>[0]>) => ({ tasksDone: 2, tasksLeft: 3, avgTokensPerTask: 10_000, avgSecondsPerTask: 240, estTokensLeft: 30_000, estMinutesLeft: 12, ...o })

describe('crew stats text', () => {
  it('claims only what the numbers support', () => {
    expect(forecastLine(f({}))).toMatch(/3 remaining tasks: up to about 12 min and about 30k tokens\. This is an estimate/)
    expect(forecastLine(f({}))).not.toMatch(/Codex window/)
    expect(forecastLine(f({ estPlanPctLeft: 40 }))).toContain('~40% of the Codex window left afterwards')
    expect(forecastLine(f({ tasksDone: 0 }))).toMatch(/nothing to base an estimate on/)
    expect(forecastLine(f({ tasksLeft: 0 }))).toBe('Every task is finished.')
    expect(forecastLine(f({ tasksLeft: 0, tasksDone: 0 }))).toBe('')
  })

  it('formats time and cost', () => {
    expect([seconds(0), seconds(42), seconds(125), seconds(3725)]).toEqual(['–', '42s', '2m 05s', '1h 02m'])
    expect([dollars(0), dollars(0.004), dollars(1.234)]).toEqual(['–', '<$0.01', '$1.23'])
  })
})
