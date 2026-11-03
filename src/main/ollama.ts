import { getHost } from './ollamaHost'
// Asks the local Ollama server what it has and where it is running. Free of Electron so it can be tested.
type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ json(): Promise<unknown> }>

export type OllamaStatus = {
  up: boolean
  models: string[]
  loaded: { name: string; gpuPercent: number }[] // models in memory right now, and how much of each sits in video memory
}

export async function ollamaStatus(host = getHost(), f: Fetch = (u, i) => fetch(u, i)): Promise<OllamaStatus> {
  try {
    const tags = (await (await f(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) })).json()) as { models?: { name: string }[] }
    let loaded: OllamaStatus['loaded'] = []
    try {
      const ps = (await (await f(`${host}/api/ps`, { signal: AbortSignal.timeout(2000) })).json()) as { models?: { name: string; size: number; size_vram: number }[] }
      loaded = (ps.models ?? []).map((m) => ({ name: m.name, gpuPercent: m.size > 0 ? Math.round((m.size_vram / m.size) * 100) : 0 }))
    } catch {
      // older servers have no /api/ps: the GPU question simply stays unanswered
    }
    return { up: true, models: (tags.models ?? []).map((m) => m.name), loaded }
  } catch {
    return { up: false, models: [], loaded: [] }
  }
}

// True when a model is loaded and none of it is on the GPU: everything will be several times slower than it should be.
export const runsOnCpu = (s: OllamaStatus) => s.loaded.length > 0 && s.loaded.every((m) => m.gpuPercent === 0)
