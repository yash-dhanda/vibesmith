import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachmentsBlock, cleanAttachments, imagePaths, kindOf, saveAttachments, safeName } from './attach'
import { codexArgs } from './codex'

const b64 = (s: string) => Buffer.from(s).toString('base64')

describe('crew attachments', () => {
  it('stores files outside the project with safe names and sorts them into pictures, videos and files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'att-'))
    const saved = await saveAttachments(root, [{ name: '../../evil name.png', data: b64('png') }, { name: 'notes.pdf', data: b64('pdf') }])
    expect(saved.map((a) => [a.name, a.kind])).toEqual([['evil_name.png', 'image'], ['notes.pdf', 'file']])
    for (const a of saved) { expect(a.path.startsWith(root)).toBe(true); expect(existsSync(a.path)).toBe(true) }
    expect(safeName('a/b\\c d?.txt')).toMatch(/^[\w.-]+$/)
    expect(kindOf('clip.MOV')).toBe('video')
  })

  it('turns a video into still frames', async () => {
    const root = mkdtempSync(join(tmpdir(), 'att-'))
    const src = join(mkdtempSync(join(tmpdir(), 'vid-')), 'a.mp4')
    try { execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=160x120:rate=5', '-pix_fmt', 'yuv420p', src]) } catch { return } // no ffmpeg here: nothing to check
    const [v] = await saveAttachments(root, [{ name: 'a.mp4', data: (await import('node:fs')).readFileSync(src).toString('base64') }])
    expect(v.kind).toBe('video')
    expect(v.frames?.length).toBeGreaterThanOrEqual(2)
    expect(existsSync(v.frames![0])).toBe(true)
  })

  it('refuses too many files', async () => {
    await expect(saveAttachments(mkdtempSync(join(tmpdir(), 'att-')), Array.from({ length: 13 }, (_, i) => ({ name: `f${i}.txt`, data: b64('x') })))).rejects.toThrow(/up to 12/)
  })

  it('only takes back attachments that are inside the attachment folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'att-'))
    mkdirSync(join(root, 'x'))
    writeFileSync(join(root, 'x', 'ok.png'), 'x')
    const outside = join(mkdtempSync(join(tmpdir(), 'out-')), 'secret.png')
    writeFileSync(outside, 'x')
    const got = cleanAttachments(root, [{ id: '1', name: 'ok.png', path: join(root, 'x', 'ok.png'), size: 1 }, { id: '2', name: 'secret.png', path: outside }, { id: '3', name: 'x', path: '/etc/passwd' }, { name: 'gone.png', path: join(root, 'x', 'missing.png') }])
    expect(got.map((a) => a.name)).toEqual(['ok.png'])
  })

  it('tells the agents where the files are, and hands Codex the pictures and video frames', () => {
    const list = [{ id: '1', name: 'bug.png', path: '/a/bug.png', kind: 'image' as const, size: 1 }, { id: '2', name: 'demo.mp4', path: '/a/demo.mp4', kind: 'video' as const, size: 1, frames: ['/a/f1.jpg', '/a/f2.jpg'] }, { id: '3', name: 'spec.pdf', path: '/a/spec.pdf', kind: 'file' as const, size: 1 }]
    const block = attachmentsBlock(list)
    expect(block).toContain('/a/bug.png')
    expect(block).toContain('/a/f2.jpg')
    expect(block).toContain('spec.pdf (file)')
    expect(attachmentsBlock([])).toBe('')
    expect(imagePaths(list)).toEqual(['/a/bug.png', '/a/f1.jpg', '/a/f2.jpg'])
    const args = codexArgs({ cwd: '/p', prompt: 'x', write: true, model: 'm', images: ['/a/bug.png'] })
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/a/bug.png'])
    expect(args.at(-1)).toBe('-')
  })
})
