import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanAttachments } from './team/attach'
import { addReference, getAutoAttach, listReferences, MAX_REF_BYTES, MAX_REFS, referenceAttachments, referencePath, referencesBlock, removeReference, setAutoAttach, setReferenceNote } from './references'

const project = () => { const p = mkdtempSync(join(tmpdir(), 'refs-')); mkdirSync(join(p, '.git')); return p }
const b64 = (s: string) => Buffer.from(s).toString('base64')

describe('reference library', () => {
  it('keeps pictures, files and links with notes, and hides the folder from git', () => {
    const p = project()
    const a = addReference(p, { name: '../../Home page.png', data: b64('png'), note: ' the hero  ' })
    const b = addReference(p, { name: 'Home page.png', data: b64('png2') })
    addReference(p, { name: 'brief.pdf', data: b64('pdf') })
    const l = addReference(p, { url: 'https://example.com/design', note: 'colours' })
    expect([a.name, b.name]).toEqual(['Home_page.png', 'Home_page-2.png'])
    const list = listReferences(p)
    expect(list.map((r) => r.kind).sort()).toEqual(['file', 'image', 'image', 'link'])
    expect(list.find((r) => r.id === a.id)?.note).toBe('the hero')
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toContain('.forge/')
    setReferenceNote(p, l.id, 'brand colours')
    setReferenceNote(p, 'brief.pdf', 'the brief')
    expect(listReferences(p).find((r) => r.id === l.id)?.note).toBe('brand colours')
    removeReference(p, l.id)
    removeReference(p, 'brief.pdf')
    expect(listReferences(p).map((r) => r.kind)).toEqual(expect.not.arrayContaining(['link']))
    expect(listReferences(p)).toHaveLength(2)
    expect(() => removeReference(p, '../x')).toThrow()
    expect(() => setReferenceNote(p, 'nope.png', 'x')).toThrow()
  })

  it('refuses bad links, videos, empty and oversize files, reserved names and a full library', () => {
    const p = project()
    expect(() => addReference(p, { url: 'javascript:alert(1)' })).toThrow(/http/)
    expect(() => addReference(p, { url: 'not a url' })).toThrow()
    expect(() => addReference(p, { name: 'a.mp4', data: b64('x') })).toThrow(/Videos/)
    expect(() => addReference(p, { name: 'a.png', data: '' })).toThrow()
    expect(() => addReference(p, { name: 'a.bin', data: 'A'.repeat(Math.ceil((MAX_REF_BYTES * 4) / 3) + 8) })).toThrow(/too big/)
    expect(addReference(p, { name: 'links.json', data: b64('{}') }).name).toBe('file-links.json')
    expect(listReferences(p)).toHaveLength(1)
    for (let i = 1; i < MAX_REFS; i++) addReference(p, { url: `https://example.com/${i}` })
    expect(() => addReference(p, { url: 'https://example.com/more' })).toThrow(/up to 100/)
  })

  it('remembers the attach switch and gives attachments the agents are allowed to read', () => {
    const p = project()
    expect(getAutoAttach(p)).toBe(false)
    setAutoAttach(p, true)
    expect(getAutoAttach(p)).toBe(true)
    addReference(p, { name: 'shot.png', data: b64('png') })
    addReference(p, { name: 'spec.txt', data: b64('text') })
    const root = mkdtempSync(join(tmpdir(), 'att-'))
    const all = referenceAttachments(p, { root })
    expect(all.map((a) => a.kind).sort()).toEqual(['file', 'image'])
    expect(cleanAttachments(root, all)).toHaveLength(2) // the same check team.start applies
    expect(readFileSync(all.find((a) => a.name === 'shot.png')!.path, 'utf8')).toBe('png')
    expect(referenceAttachments(p, { root, kinds: ['image'] }).map((a) => a.name)).toEqual(['shot.png'])
    expect(referenceAttachments(p, { root, limit: 1 })).toHaveLength(1)
    expect(referencesBlock(p)).toBe('')
    setReferenceNote(p, 'shot.png', 'login screen')
    expect(referencesBlock(p)).toContain('shot.png: login screen')
    expect(referencePath(p, 'shot.png')).toBe(join(p, '.forge', 'references', 'shot.png'))
    expect(referencePath(p, '../x')).toBeNull()
  })

  it('ignores a library folder that is a link, and entries that are links', () => {
    const p = project()
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'))
    writeFileSync(join(elsewhere, 'secret.png'), 'secret')
    mkdirSync(join(p, '.forge'))
    symlinkSync(elsewhere, join(p, '.forge', 'references'))
    expect(listReferences(p)).toEqual([])
    expect(() => addReference(p, { name: 'a.png', data: b64('x') })).toThrow(/link/)
    expect(referenceAttachments(p, { root: elsewhere })).toEqual([])
    const q = project()
    addReference(q, { name: 'ok.png', data: b64('x') })
    symlinkSync(join(elsewhere, 'secret.png'), join(q, '.forge', 'references', 'leak.png'))
    expect(listReferences(q).map((r) => r.name)).toEqual(['ok.png'])
    expect(existsSync(join(elsewhere, 'secret.png'))).toBe(true)
  })
})
