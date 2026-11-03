import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ChatStore, compact, titleFrom, type TranscriptItem } from './chatStore'

let dir: string
let store: ChatStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-chats-'))
  store = new ChatStore(dir)
})

describe('titleFrom', () => {
  it('collapses whitespace, truncates, falls back', () => {
    expect(titleFrom('  fix   the\nbug ')).toBe('fix the bug')
    expect(titleFrom('x'.repeat(80))).toHaveLength(48)
    expect(titleFrom('x'.repeat(80)).endsWith('…')).toBe(true)
    expect(titleFrom('   ')).toBe('New chat')
  })
})

describe('compact', () => {
  it('merges consecutive deltas only', () => {
    const items: TranscriptItem[] = [
      { type: 'user', text: 'hi' },
      { type: 'delta', text: 'He' },
      { type: 'delta', text: 'llo' },
      { type: 'turn_end' },
      { type: 'delta', text: 'Again' },
    ]
    expect(compact(items)).toEqual([{ type: 'user', text: 'hi' }, { type: 'delta', text: 'Hello' }, { type: 'turn_end' }, { type: 'delta', text: 'Again' }])
  })
})

describe('ChatStore', () => {
  it('saves, loads, and lists newest first', async () => {
    const a = store.create('/p/a')
    a.title = 'first'
    a.transcript.push({ type: 'user', text: 'hello' }, { type: 'delta', text: 'hi' }, { type: 'delta', text: ' there' })
    store.save(a)
    await new Promise((r) => setTimeout(r, 5))
    const b = store.create(null)
    b.title = 'second'
    store.save(b)

    expect(store.list().map((s) => s.title)).toEqual(['second', 'first'])
    expect(store.list()[1]).toMatchObject({ id: a.id, project: '/p/a' })
    expect(store.load(a.id)!.transcript).toEqual([{ type: 'user', text: 'hello' }, { type: 'delta', text: 'hi there' }])
  })

  it('re-saving a chat moves it to the top without duplicating', async () => {
    const a = store.create('/p')
    store.save(a)
    await new Promise((r) => setTimeout(r, 5))
    const b = store.create('/p')
    store.save(b)
    await new Promise((r) => setTimeout(r, 5))
    store.save(a)
    expect(store.list().map((s) => s.id)).toEqual([a.id, b.id])
  })

  it('persists messages and checkpoints so a chat can continue and undo after a restart', () => {
    const a = store.create('/p')
    a.messages.push({ role: 'user', content: 'x' })
    a.checkpoints['1'] = { id: '1', tree: 'abc' }
    store.save(a)
    const again = new ChatStore(dir).load(a.id)!
    expect(again.messages).toEqual([{ role: 'user', content: 'x' }])
    expect(again.checkpoints['1']).toEqual({ id: '1', tree: 'abc' })
  })

  it('delete removes the file and the index entry', () => {
    const a = store.create(null)
    store.save(a)
    store.delete(a.id)
    expect(store.list()).toEqual([])
    expect(store.load(a.id)).toBeNull()
    expect(existsSync(join(dir, `${a.id}.json`))).toBe(false)
  })

  it('refuses ids that could escape the folder', () => {
    expect(() => store.load('../evil')).not.toThrow() // load swallows errors and returns null
    expect(store.load('../evil')).toBeNull()
    expect(() => store.delete('../../etc/passwd')).toThrow('bad chat id')
    expect(() => store.delete('a/b')).toThrow('bad chat id')
  })

  it('survives a corrupt chat file and a corrupt index', () => {
    const a = store.create(null)
    store.save(a)
    writeFileSync(join(dir, `${a.id}.json`), '{ broken')
    expect(store.load(a.id)).toBeNull()
    writeFileSync(join(dir, 'index.json'), 'not json')
    expect(store.list()).toEqual([])
    store.save(store.create(null)) // still usable afterwards
    expect(store.list()).toHaveLength(1)
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).toContain('New chat')
  })
})

describe('pinning and search', () => {
  const make = (id: string, title: string, items: TranscriptItem[], project: string | null = '/p/a') => {
    const c = store.create(project, id)
    c.title = title
    c.transcript = items
    store.save(c)
    return c
  }

  it('pinning keeps the chat\'s place in time and shows in the list', () => {
    const a = make('a', 'first', [])
    make('b', 'second', [])
    const before = store.list().find((s) => s.id === 'a')!.updatedAt
    a.pinned = true
    store.save(a, false)
    const item = store.list().find((s) => s.id === 'a')!
    expect(item.pinned).toBe(true)
    expect(item.updatedAt).toBe(before)
    a.pinned = undefined
    store.save(a, false)
    expect(store.list().find((s) => s.id === 'a')!.pinned).toBeUndefined()
  })

  it('finds chats by title, user and assistant text, needs every word, shows a snippet', () => {
    make('a', 'Flower shop', [{ type: 'user', text: 'please add a checkout page with stripe' }, { type: 'delta', text: 'I created '}, { type: 'delta', text: 'checkout.html for you' }, { type: 'turn_end' }])
    make('b', 'Todo app', [{ type: 'user', text: 'a to-do list' }, { type: 'delta', text: 'Done: dark mode added' }])
    expect(store.search('checkout stripe').map((h) => h.id)).toEqual(['a'])
    expect(store.search('DARK mode').map((h) => h.id)).toEqual(['b'])
    expect(store.search('flower').map((h) => h.snippets[0])).toEqual([{ where: 'title', text: 'Flower shop' }])
    const hit = store.search('checkout')[0]
    expect(hit.snippets.map((s) => s.where)).toEqual(['user', 'assistant'])
    expect(hit.snippets[1].text).toContain('checkout.html')
    expect(store.search('nothing here')).toEqual([])
    expect(store.search('a')).toEqual([]) // one-letter words are ignored
  })
})
