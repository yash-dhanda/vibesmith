import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createCheckpoint, initRepo, savePaths } from './checkpoint'
import { listRestorePoints, restoreDiff, restoreTo } from './restorePoints'

let dir: string
const w = (f: string, t: string) => {
  mkdirSync(join(dir, f, '..'), { recursive: true })
  writeFileSync(join(dir, f), t)
}
const r = (f: string) => readFileSync(join(dir, f), 'utf8')
const tick = () => new Promise((res) => setTimeout(res, 3)) // checkpoint ids are milliseconds

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-restore-'))
  await initRepo(dir)
  w('keep.txt', 'keep\n')
  w('edit.txt', 'one\ntwo\n')
  w('gone.txt', 'bye\n')
})

describe('restore points', () => {
  it('lists the points newest first with what changed since, and guesses what made them', async () => {
    expect(await listRestorePoints(mkdtempSync(join(tmpdir(), 'forge-plain-')))).toEqual([])
    const a = await createCheckpoint(dir)
    await tick()
    w('edit.txt', 'one\nTWO\nthree\n')
    const b = await createCheckpoint(dir)
    await savePaths(dir, b.id, ['edit.txt'])
    await tick()
    rmSync(join(dir, 'gone.txt'))
    w('fresh.txt', 'x\n')
    const list = await listRestorePoints(dir, { [a.id]: 'Solo: fix the header' })
    expect(list.map((p) => p.id)).toEqual([b.id, a.id])
    expect(list[0]).toMatchObject({ label: 'Crew landing', filesChanged: 2, additions: 1, deletions: 1 })
    expect(list[1]).toMatchObject({ label: 'Solo: fix the header', filesChanged: 3 })
  })

  it('shows the files and the diff since a point, without the contents of secrets', async () => {
    w('.env', 'KEY=1\n')
    const cp = await createCheckpoint(dir)
    w('.env', 'KEY=2\n')
    w('edit.txt', 'one\nTWO\n')
    const d = await restoreDiff(dir, cp.id)
    expect(d.files.map((f) => f.path).sort()).toEqual(['.env', 'edit.txt'])
    expect(d.diff).toContain('+TWO')
    expect(d.diff).not.toContain('KEY=')
    await expect(restoreDiff(dir, '1')).rejects.toThrow('no longer exists')
    await expect(restoreDiff(dir, '../x')).rejects.toThrow()
  })

  it('restores chosen files only, takes a new point first, and can be undone', async () => {
    const cp = await createCheckpoint(dir)
    await tick()
    w('edit.txt', 'changed\n')
    w('keep.txt', 'changed too\n')
    const res = await restoreTo(dir, cp.id, { files: ['edit.txt', '../../etc/passwd'] })
    expect(res.restored).toEqual(['edit.txt'])
    expect(r('edit.txt')).toBe('one\ntwo\n')
    expect(r('keep.txt')).toBe('changed too\n')
    const list = await listRestorePoints(dir)
    expect(list.find((p) => p.id === res.checkpoint)?.label).toBe('Before a restore')
    await restoreTo(dir, res.checkpoint!)
    expect(r('edit.txt')).toBe('changed\n')
  })

  it('without a file list it brings back edited and deleted files but keeps files created since', async () => {
    const cp = await createCheckpoint(dir)
    w('edit.txt', 'changed\n')
    rmSync(join(dir, 'gone.txt'))
    w('mine.txt', 'written after\n')
    const res = await restoreTo(dir, cp.id)
    expect(res.restored.sort()).toEqual(['edit.txt', 'gone.txt'])
    expect(r('gone.txt')).toBe('bye\n')
    expect(r('mine.txt')).toBe('written after\n')
    // naming the new file removes it
    await restoreTo(dir, cp.id, { files: ['mine.txt'] })
    expect(existsSync(join(dir, 'mine.txt'))).toBe(false)
  })

  it('does nothing, and takes no new point, when nothing differs', async () => {
    const cp = await createCheckpoint(dir)
    expect(await restoreTo(dir, cp.id)).toEqual({ restored: [], checkpoint: null })
    expect((await listRestorePoints(dir)).length).toBe(1)
  })
})
