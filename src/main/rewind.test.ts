import { describe, expect, it } from 'vitest'
import type { Chat } from './chatStore'
import { isUserTurn, rewindChat } from './rewind'

const chat = (): Chat => ({
  id: 'c', title: 't', project: '/p', createdAt: 0, updatedAt: 0,
  transcript: [
    { type: 'user', text: 'first' }, { type: 'delta', text: 'ok' }, { type: 'changes', checkpoint: '100', files: [] }, { type: 'done', reason: 'finished', steps: 1 },
    { type: 'user', text: 'second' }, { type: 'delta', text: 'no change' }, { type: 'done', reason: 'finished', steps: 1 },
    { type: 'user', text: 'third' }, { type: 'changes', checkpoint: '300', files: [] },
  ],
  messages: [
    { role: 'system', content: 'sys' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' },
    { role: 'user', content: '[Forge: before you finish...]' }, { role: 'user', content: 'second' }, { role: 'assistant', content: 'no change' },
    { role: 'user', content: '[The user undid your last changes.]' }, { role: 'user', content: 'third' },
  ],
  checkpoints: { '100': { id: '100', tree: 'a' }, '300': { id: '300', tree: 'c' } },
})

describe('rewindChat', () => {
  it('cuts both histories before the chosen message and returns its text', () => {
    const c = chat()
    const r = rewindChat(c, 1)!
    expect(r.text).toBe('second')
    expect(c.transcript.map((x) => x.type)).toEqual(['user', 'delta', 'changes', 'done'])
    expect(c.messages.map((m) => m.content)).toEqual(['sys', 'first', 'ok', '[Forge: before you finish...]'])
  })
  it('restores to the state before the first changing run at or after the message, and forgets later checkpoints', () => {
    const c = chat()
    const r = rewindChat(c, 1)!
    expect(r.restore).toEqual({ id: '300', tree: 'c' })
    expect(c.checkpoints).toEqual({ '100': { id: '100', tree: 'a' } })
    const c0 = chat()
    expect(rewindChat(c0, 0)!.restore).toEqual({ id: '100', tree: 'a' })
    expect(c0.checkpoints).toEqual({})
    expect(c0.transcript).toEqual([])
    expect(c0.messages.map((m) => m.role)).toEqual(['system'])
  })
  it('returns null for a message that does not exist', () => expect(rewindChat(chat(), 9)).toBeNull())
  it('does not count Forge-injected messages as the user\'s', () => {
    expect(isUserTurn({ role: 'user', content: 'hello' })).toBe(true)
    expect(isUserTurn({ role: 'user', content: 'Verification failed. Command: x' })).toBe(false)
    expect(isUserTurn({ role: 'assistant', content: 'hi' })).toBe(false)
  })
})
