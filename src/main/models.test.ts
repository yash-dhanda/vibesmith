import { describe, expect, it } from 'vitest'
import { CATALOG, rank } from './catalog'
import { searchHF } from './hf'
import { PullTracker } from './pull'
import { fitFor, parseNvidiaSmi } from './system'

const laptop = { ramGB: 30, gpu: { name: 'RTX 5070 Laptop', vramGB: 8, freeGB: 5.82 } }
const desktop = { ramGB: 48, gpu: { name: 'RTX 3090 Ti', vramGB: 24, freeGB: 23 } }
const noGpu = { ramGB: 16, gpu: null }

describe('parseNvidiaSmi', () => {
  it('reads name, total and free memory; with several GPUs takes the one with the most free memory', () => {
    const g = parseNvidiaSmi('NVIDIA GeForce RTX 5070 Laptop GPU, 8151, 5957\nNVIDIA RTX 3090 Ti, 24564, 23000\n')
    expect(g?.name).toBe('NVIDIA RTX 3090 Ti')
    expect(g!.vramGB).toBeCloseTo(23.99, 1)
    expect(g!.freeGB).toBeCloseTo(22.46, 1)
  })
  it('returns null for no GPU or an error message', () => {
    expect(parseNvidiaSmi('')).toBeNull()
    expect(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")).toBeNull()
  })
})

describe('fitFor', () => {
  it('matches what really happened: the 5.2 GB qwen3:8b ran fully on the GPU with 5.8 GB free', () => {
    expect(fitFor(5.2, laptop)).toBe('gpu')
    expect(fitFor(3.3, laptop)).toBe('gpu')
  })
  it('bigger models spill to the CPU, and the biggest are refused', () => {
    expect(fitFor(6.6, laptop)).toBe('partial')
    expect(fitFor(17, laptop)).toBe('partial')
    expect(fitFor(22, laptop)).toBe('too-big')
    expect(fitFor(17, desktop)).toBe('gpu')
    expect(fitFor(22, desktop)).toBe('partial')
  })
  it('without a supported GPU everything runs on the CPU, if the memory is there', () => {
    expect(fitFor(2, noGpu)).toBe('cpu')
    expect(fitFor(9, noGpu)).toBe('cpu')
    expect(fitFor(14, noGpu)).toBe('too-big')
  })
})

describe('catalog', () => {
  it('is well formed: unique ids, real sizes, a blurb, a quality rank', () => {
    const ids = CATALOG.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of CATALOG) {
      expect(m.sizeGB).toBeGreaterThan(0.5)
      expect(m.q).toBeGreaterThanOrEqual(1)
      expect(m.q).toBeLessThanOrEqual(10)
      expect(m.blurb.length).toBeGreaterThan(10)
      expect(m.blurb).not.toMatch(/!/) // plain copy, no exclamation marks
    }
  })
  it('recommends what actually fits this PC: the 8B for the laptop, a 27B-class model for the big card', () => {
    const l = rank(laptop)
    expect(l[0].fit).toBe('gpu')
    expect(l.filter((m) => m.best).map((m) => m.id)).toContain('qwen3:8b')
    expect(l.filter((m) => m.best).every((m) => m.fit === 'gpu')).toBe(true)
    const d = rank(desktop)
    expect(d.filter((m) => m.best).some((m) => /27b|35b|30b/.test(m.id))).toBe(true)
    expect(d.find((m) => m.id === 'qwen3.6:27b')!.fit).toBe('gpu')
  })
  it('puts models that cannot run here last, and never marks them best', () => {
    const r = rank(noGpu)
    expect(r.at(-1)!.fit).toBe('too-big')
    expect(r.filter((m) => m.fit === 'too-big').some((m) => m.best)).toBe(false)
    expect(r.filter((m) => m.best)).toHaveLength(1) // on a CPU-only PC only one small model is recommended
  })
})

describe('PullTracker', () => {
  const L = (o: object) => JSON.stringify(o)
  it('adds up layers into one percentage and a recent speed', () => {
    const t = new PullTracker()
    t.update(L({ status: 'pulling manifest' }), 0)
    t.update(L({ status: 'pulling aaa', digest: 'aaa', total: 1000, completed: 0 }), 1000)
    t.update(L({ status: 'pulling bbb', digest: 'bbb', total: 1000, completed: 0 }), 1000)
    const mid = t.update(L({ status: 'pulling aaa', digest: 'aaa', total: 1000, completed: 500 }), 3000)!
    expect(mid).toMatchObject({ completed: 500, total: 2000, percent: 25, done: false })
    expect(mid.bytesPerSec).toBeCloseTo(500 / 3, 0) // 500 bytes over the 3 s the window covers
    const end = t.update(L({ status: 'success' }), 4000)!
    expect(end).toMatchObject({ done: true, percent: 100 })
  })
  it('reports errors from the server and ignores junk lines', () => {
    const t = new PullTracker()
    expect(t.update('not json')).toBeNull()
    expect(t.update('')).toBeNull()
    expect(t.update(L({ error: 'pull model manifest: file does not exist' }))).toMatchObject({ done: true, error: 'pull model manifest: file does not exist' })
  })
  it('never reports 100% before the server says it is done', () => {
    const t = new PullTracker()
    expect(t.update(L({ status: 'pulling x', digest: 'x', total: 10, completed: 10 }), 0)!.percent).toBe(99)
  })
})

describe('searchHF', () => {
  const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body })
  it('turns results into pull names and drops malformed entries', async () => {
    const r = await searchHF('qwen coder', ok([{ id: 'bartowski/Qwen3-Coder-GGUF', downloads: 120000, likes: 340 }, { id: 'no-slash' }, { downloads: 5 }, { id: 'a/b', downloads: 1 }]))
    expect(r).toEqual([
      { id: 'bartowski/Qwen3-Coder-GGUF', pullName: 'hf.co/bartowski/Qwen3-Coder-GGUF', downloads: 120000, likes: 340 },
      { id: 'a/b', pullName: 'hf.co/a/b', downloads: 1, likes: 0 },
    ])
  })
  it('asks for GGUF repositories sorted by downloads, with the query escaped', async () => {
    let url = ''
    await searchHF('a b&c', async (u) => ((url = u), { ok: true, status: 200, json: async () => [] }))
    expect(url).toContain('search=a%20b%26c')
    expect(url).toContain('filter=gguf')
    expect(url).toContain('sort=downloads')
  })
  it('is empty for an empty query, and explains a failing server', async () => {
    expect(await searchHF('  ', ok([]))).toEqual([])
    await expect(searchHF('x', async () => ({ ok: false, status: 503, json: async () => ({}) }))).rejects.toThrow('503')
  })
})
