import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => H.dir } }))
import { getVerify, setVerify } from './settings'

beforeEach(() => {
  H.dir = mkdtempSync(join(tmpdir(), 'forge-settings-'))
})

describe('per-project verify command', () => {
  it('is saved per project and trimmed; an empty command clears it', () => {
    setVerify('/p/a', '  npm test ')
    setVerify('/p/b', 'make')
    expect(getVerify('/p/a').configured).toBe('npm test')
    setVerify('/p/a', '  ')
    expect(getVerify('/p/a').configured).toBeNull()
    expect(getVerify('/p/b').configured).toBe('make')
  })

  it('writes through a temp file, so a crash cannot leave projects.json half written', () => {
    setVerify('/p/a', 'x')
    expect(existsSync(join(H.dir, 'projects.json.tmp'))).toBe(false)
    expect(JSON.parse(readFileSync(join(H.dir, 'projects.json'), 'utf8'))['/p/a'].verify).toBe('x')
  })

  it.each(['{"/p/a":{"ver', 'null', '[]'])('an unreadable file (%j) is set aside, not overwritten by the next save', (bad) => {
    writeFileSync(join(H.dir, 'projects.json'), bad)
    setVerify('/p/b', 'make')
    expect(readFileSync(join(H.dir, 'projects.json.corrupt'), 'utf8')).toBe(bad)
    expect(getVerify('/p/b').configured).toBe('make')
  })
})
