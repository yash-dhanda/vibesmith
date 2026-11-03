import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AttachmentStore, inlineText } from './attachments'

const store = () => new AttachmentStore(mkdtempSync(join(tmpdir(), 'forge-att-')))
const bytes = (s: string) => new TextEncoder().encode(s)

describe('AttachmentStore', () => {
  it('stores pictures and text files, finds them by id, and cleans names', () => {
    const s = store()
    const [img, txt] = s.add('chat1', [{ name: '../shot one.PNG', data: new Uint8Array([1, 2, 3]) }, { name: 'notes.md', data: bytes('# hi') }])
    expect(img).toMatchObject({ name: 'shot_one.PNG', kind: 'image', mime: 'image/png', size: 3 })
    expect(txt).toMatchObject({ name: 'notes.md', kind: 'text' })
    const f = s.find('chat1', txt.id)!
    expect(f.name).toBe('notes.md')
    expect(s.text(f)).toEqual({ text: '# hi', cut: false })
    expect(s.dataUrl(s.find('chat1', img.id)!)).toBe('data:image/png;base64,AQID')
  })
  it('refuses binary files that are not pictures, huge files and too many files, storing nothing', () => {
    const s = store()
    expect(() => s.add('c', [{ name: 'a.png', data: bytes('ok') }, { name: 'tool.exe', data: new Uint8Array([0, 1, 2]) }])).toThrow(/not a picture or a text file/)
    expect(s.find('c', 'anything')).toBeNull()
    expect(() => s.add('c', [{ name: 'big.txt', data: new Uint8Array(1024 * 1024 + 1).fill(97) }])).toThrow(/too big/)
    expect(() => s.add('c', Array.from({ length: 9 }, () => ({ name: 'a.txt', data: bytes('x') })))).toThrow(/up to 8/)
  })
  it('keeps one chat out of another and rejects bad ids', () => {
    const s = store()
    const [a] = s.add('c1', [{ name: 'a.txt', data: bytes('x') }])
    expect(s.find('c2', a.id)).toBeNull()
    expect(s.find('c1', '../x')).toBeNull()
    expect(() => s.add('../evil', [{ name: 'a.txt', data: bytes('x') }])).toThrow(/bad chat id/)
  })
  it('removes a chat\'s files', () => {
    const s = store()
    const [a] = s.add('c1', [{ name: 'a.txt', data: bytes('x') }])
    s.removeChat('c1')
    expect(s.find('c1', a.id)).toBeNull()
  })
  it('inlines a text file for the model, marking a cut', () => {
    expect(inlineText('a.js', 'x=1', false)).toBe('\n\n[Attached file: a.js]\n```\nx=1\n```')
    expect(inlineText('a.js', 'x=1', true)).toContain('[cut: the file is longer]')
  })
})
