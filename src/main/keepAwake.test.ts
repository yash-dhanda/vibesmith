import { describe, expect, it } from 'vitest'
import { makeKeepAwake } from './keepAwake'

describe('keep awake', () => {
  it('blocks sleep while any run works, once, and lets go when the last one stops', () => {
    const log: string[] = []
    const k = makeKeepAwake({ start: () => (log.push('start'), 7), stop: (id) => log.push(`stop ${id}`) })
    k.set('a', true); k.set('b', true); k.set('a', true)
    expect(log).toEqual(['start']) // one blocker for any number of runs
    k.set('a', false)
    expect(log).toEqual(['start'])
    k.set('b', false)
    expect(log).toEqual(['start', 'stop 7'])
    k.set('c', true); k.stop()
    expect(log).toEqual(['start', 'stop 7', 'start', 'stop 7'])
    expect(k.count()).toBe(0)
  })
})
