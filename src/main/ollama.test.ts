import { describe, expect, it } from 'vitest'
import { ollamaStatus, runsOnCpu } from './ollama'

const server = (routes: Record<string, unknown>) => async (url: string) => {
  const path = new URL(url).pathname
  if (!(path in routes)) throw new Error('404')
  return { json: async () => routes[path] }
}

describe('ollamaStatus', () => {
  it('lists models and how much of each loaded model is on the GPU', async () => {
    const s = await ollamaStatus('http://x', server({ '/api/tags': { models: [{ name: 'qwen3:8b' }, { name: 'llama3:8b' }] }, '/api/ps': { models: [{ name: 'qwen3:8b', size: 6_000, size_vram: 3_000 }] } }))
    expect(s).toEqual({ up: true, models: ['qwen3:8b', 'llama3:8b'], loaded: [{ name: 'qwen3:8b', gpuPercent: 50 }] })
    expect(runsOnCpu(s)).toBe(false)
  })
  it('flags a model that runs entirely on the CPU', async () => {
    const s = await ollamaStatus('http://x', server({ '/api/tags': { models: [{ name: 'm' }] }, '/api/ps': { models: [{ name: 'm', size: 6_100, size_vram: 0 }] } }))
    expect(s.loaded[0].gpuPercent).toBe(0)
    expect(runsOnCpu(s)).toBe(true)
  })
  it('says nothing about the GPU when no model is loaded, or the server has no /api/ps', async () => {
    expect(runsOnCpu(await ollamaStatus('http://x', server({ '/api/tags': { models: [] }, '/api/ps': { models: [] } })))).toBe(false)
    const old = await ollamaStatus('http://x', server({ '/api/tags': { models: [{ name: 'm' }] } }))
    expect(old).toEqual({ up: true, models: ['m'], loaded: [] })
  })
  it('reports a server that is not running', async () => {
    expect(await ollamaStatus('http://x', server({}))).toEqual({ up: false, models: [], loaded: [] })
  })
})
