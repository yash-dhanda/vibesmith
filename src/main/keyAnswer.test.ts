import { describe, expect, it } from 'vitest'
import { keyLines, splitKeyAnswer, withoutKey } from './keyAnswer'

describe('keyAnswer', () => {
  it('pulls KEY lines out of a reply, deduped and capped', () => {
    const t = 'Done.\nKEY: Admin login: id admin, password Xk3-9\n**KEY:** URL http://localhost:3000/admin\nkey: URL http://localhost:3000/admin\nBye'
    expect(keyLines(t)).toEqual(['Admin login: id admin, password Xk3-9', 'URL http://localhost:3000/admin'])
    expect(withoutKey(t)).toBe('Done.\nBye')
    expect(keyLines(Array.from({ length: 20 }, (_, i) => `KEY: v${i}`).join('\n'))).toHaveLength(8)
  })
  it('ignores prose that merely mentions the word', () => {
    expect(keyLines('The key point is speed.\nA monkey: bananas')).toEqual([])
  })
  it('splits the report section back out', () => {
    const r = '# Goal\n\nsummary\n\n## Key answer\n- id admin\n- pass x\n\n## What the team did\n- a'
    expect(splitKeyAnswer(r)).toEqual({ key: ['id admin', 'pass x'], rest: '# Goal\n\nsummary\n\n## What the team did\n- a' })
    expect(splitKeyAnswer('# no key')).toEqual({ key: [], rest: '# no key' })
  })
})
