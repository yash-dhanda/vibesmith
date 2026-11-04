import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path },
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (s: string) => Buffer.from(`enc:${s}`), decryptString: (b: Buffer) => b.toString().slice(4) },
}))
import { clearKey, getKey, keyStatus, setKey } from './keys'

beforeEach(() => {
  dir.path = mkdtempSync(join(tmpdir(), 'forge-keys-'))
})

describe('keys', () => {
  it('stores, reads and clears a key', () => {
    setKey('openai', ' sk-1 ')
    expect(getKey('openai')).toBe('sk-1')
    expect(keyStatus()).toEqual({ anthropic: false, openai: true, openrouter: false })
    clearKey('openai')
    expect(getKey('openai')).toBeNull()
  })

  it('a key file that is not valid JSON is moved aside, not silently dropped', () => {
    writeFileSync(join(dir.path, 'keys.json'), '{ nope')
    expect(getKey('openai')).toBeNull()
    setKey('openrouter', 'k')
    expect(getKey('openrouter')).toBe('k')
    const bad = readdirSync(dir.path).filter((f) => f.startsWith('keys.json.bad-'))
    expect(bad).toHaveLength(1)
    expect(readFileSync(join(dir.path, bad[0]), 'utf8')).toBe('{ nope')
  })

  it.skipIf(process.getuid?.() === 0)('a key file that cannot be read is never overwritten by the next setKey', () => {
    setKey('anthropic', 'a')
    const f = join(dir.path, 'keys.json')
    chmodSync(f, 0o000)
    expect(() => setKey('openai', 'o')).toThrow()
    expect(keyStatus().anthropic).toBe(false) // unreadable, but not an exception on the settings screen
    chmodSync(f, 0o600)
    expect(getKey('anthropic')).toBe('a')
  })
})
