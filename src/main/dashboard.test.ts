import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedOverview, gitInfo, projectOverview, resetOverviewCache, type OverviewDeps } from './dashboard'

const run = (project: string, status: string, updatedAt: number, pendingApprovals = 0) => ({ project, status, updatedAt, pendingApprovals })
const fake = (o: Partial<OverviewDeps>): OverviewDeps => ({ chats: () => [], runs: () => [], exists: () => true, gitInfo: async () => null, ...o })

beforeEach(resetOverviewCache)

describe('project overview', () => {
  it('merges chats, runs and scan hits per folder, ignoring a trailing slash', async () => {
    const out = await projectOverview(fake({
      chats: () => [{ project: '/p/a', updatedAt: 10 }, { project: '/p/a/', updatedAt: 30 }, { project: null, updatedAt: 99 }],
      runs: () => [run('/p/a', 'done', 20), run('/p/a', 'failed', 40)],
      scanned: () => [{ path: '/p/a', mtime: 5 }, { path: '/p/b', mtime: 7 }],
    }))
    const a = out.find((p) => p.path === '/p/a')!
    expect(a).toMatchObject({ name: 'a', chats: 2, lastActivity: 40, runs: { total: 2, active: 0, needsYou: 0, lastStatus: 'failed' } })
    expect(out.find((p) => p.path === '/p/b')).toMatchObject({ chats: 0, lastActivity: 7, runs: { total: 0, lastStatus: null } })
    expect(out).toHaveLength(2)
  })

  it('sorts needs-you, then running, then newest, and puts missing folders last', async () => {
    const out = await projectOverview(fake({
      chats: () => ['/old', '/new', '/gone', '/busy', '/ask'].map((project, i) => ({ project, updatedAt: [1, 9, 100, 5, 2][i] })),
      runs: () => [run('/busy', 'running', 5), run('/ask', 'running', 2, 1), run('/ask', 'done', 1)],
      exists: (p) => p !== '/gone',
    }))
    expect(out.map((p) => p.path)).toEqual(['/ask', '/busy', '/new', '/old', '/gone'])
    expect(out[0].runs).toMatchObject({ total: 2, active: 1, needsYou: 1 })
  })

  it('counts a finished run with a stale approval as not needing you', async () => {
    const [p] = await projectOverview(fake({ runs: () => [run('/p', 'done', 1, 2), run('/p', 'awaiting_approval', 2)] }))
    expect(p.runs).toMatchObject({ active: 1, needsYou: 1, lastStatus: 'awaiting_approval' })
  })

  it('reads git with at most four at a time, skips missing folders, and survives a failing one', async () => {
    let live = 0, peak = 0
    const gitFn = async (path: string) => {
      peak = Math.max(peak, ++live)
      await new Promise((r) => setTimeout(r, 5))
      live--
      if (path === '/p/3') throw new Error('boom')
      return { branch: 'main', dirty: 1, ahead: 0 }
    }
    const out = await projectOverview(fake({ chats: () => Array.from({ length: 10 }, (_, i) => ({ project: `/p/${i}`, updatedAt: i })), gitInfo: gitFn, exists: (p) => p !== '/p/9' }))
    expect(peak).toBe(4)
    expect(out.find((p) => p.path === '/p/3')!.git).toBeNull()
    expect(out.find((p) => p.path === '/p/9')).toMatchObject({ exists: false, git: null })
    expect(out.find((p) => p.path === '/p/0')!.git).toEqual({ branch: 'main', dirty: 1, ahead: 0 })
  })

  it('caches for 15 seconds unless asked for fresh', async () => {
    const chats = vi.fn(() => [{ project: '/p', updatedAt: 1 }])
    const deps = fake({ chats })
    let t = 1000
    await cachedOverview(deps, false, 15_000, () => t)
    t += 14_000
    await cachedOverview(deps, false, 15_000, () => t)
    expect(chats).toHaveBeenCalledTimes(1)
    await cachedOverview(deps, true, 15_000, () => t)
    expect(chats).toHaveBeenCalledTimes(2)
    t += 15_001
    await cachedOverview(deps, false, 15_000, () => t)
    expect(chats).toHaveBeenCalledTimes(3)
  })
})

describe('gitInfo', () => {
  it('reads branch, changed files and commits ahead from one status call; null outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-dash-'))
    expect(await gitInfo(dir)).toBeNull()
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.txt'), 'b')
    expect(await gitInfo(dir)).toEqual({ branch: 'trunk', dirty: 2, ahead: 0 })
  })
})
