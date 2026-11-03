import { describe, expect, it } from 'vitest'
import { DEFAULT_HOST, getHost, isRemote, normalizeHost, remoteVramGB, setHost } from './ollamaHost'

describe('normalizeHost', () => {
  it('adds the scheme and the default port', () => {
    expect(normalizeHost('192.168.1.20')).toBe('http://192.168.1.20:11434')
    expect(normalizeHost('yashpc:11434')).toBe('http://yashpc:11434')
    expect(normalizeHost('https://gpu.example.com')).toBe('https://gpu.example.com')
  })
  it('strips paths and treats empty as this computer', () => {
    expect(normalizeHost('http://10.0.0.5:11434/api/tags?x=1')).toBe('http://10.0.0.5:11434')
    expect(normalizeHost('  ')).toBe(DEFAULT_HOST)
  })
  it('rejects bad input', () => {
    expect(() => normalizeHost('ftp://x')).toThrow(/http/)
    expect(() => normalizeHost('http://user:pw@host')).toThrow(/username/)
    expect(() => normalizeHost('http://')).toThrow(/valid/)
  })
})

describe('setHost', () => {
  it('switches between remote and this computer and keeps the card size', () => {
    setHost('10.0.0.5', 24)
    expect(isRemote()).toBe(true)
    expect(getHost()).toBe('http://10.0.0.5:11434')
    expect(remoteVramGB()).toBe(24)
    setHost('')
    expect(isRemote()).toBe(false)
  })
})
