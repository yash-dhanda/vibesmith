import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachmentsBlock, cleanAttachments, imagePaths, kindOf, saveAttachments, safeName, sweepAttachments } from './attach'
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

  it('spreads the stills over the whole video and says how far apart they are', async () => {
    const root = mkdtempSync(join(tmpdir(), 'att-'))
    const src = join(mkdtempSync(join(tmpdir(), 'vid-')), 'long.mp4')
    try { // 30 s black, then 30 s white
      execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x48:r=2:d=30', '-f', 'lavfi', '-i', 'color=white:s=64x48:r=2:d=30', '-filter_complex', 'concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', src])
    } catch { return } // no ffmpeg here: nothing to check
    const [v] = await saveAttachments(root, [{ name: 'long.mp4', data: readFileSync(src).toString('base64') }])
    expect(v.frames).toHaveLength(12)
    expect([v.duration, v.frameEvery]).toEqual([60, 5])
    const grey = (f: string) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])[0]
    expect(grey(v.frames![0])).toBeLessThan(60)
    expect(grey(v.frames!.at(-1)!)).toBeGreaterThan(200) // the last still is from the end of the video, not from second 22
    expect(attachmentsBlock([v])).toContain('about 5 seconds apart, covering all 60 seconds')
    expect(cleanAttachments(root, [v])[0].frameEvery).toBe(5)
  })

  it('records the length of a clip shorter than a second', async () => {
    const root = mkdtempSync(join(tmpdir(), 'att-'))
    const src = join(mkdtempSync(join(tmpdir(), 'vid-')), 'short.mp4')
    try { execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x48:r=10:d=0.4', '-pix_fmt', 'yuv420p', src]) } catch { return }
    const [v] = await saveAttachments(root, [{ name: 'short.mp4', data: readFileSync(src).toString('base64') }])
    expect(v.duration).toBeGreaterThan(0)
    expect(attachmentsBlock([v])).toContain(`covering all ${v.duration} seconds`)
  })

  it('deletes old uploads that no run uses and keeps the rest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'att-'))
    const [used] = await saveAttachments(root, [{ name: 'used.png', data: b64('x') }])
    const [fresh] = await saveAttachments(root, [{ name: 'fresh.png', data: b64('x') }])
    const [stale] = await saveAttachments(root, [{ name: 'stale.png', data: b64('x') }])
    const old = new Date(Date.now() - 3 * 24 * 3600_000)
    for (const a of [used, stale]) utimesSync(join(a.path, '..'), old, old)
    sweepAttachments(root, [used])
    expect([used, fresh, stale].map((a) => existsSync(a.path))).toEqual([true, true, false])
  })
})
