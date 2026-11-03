import { getHost } from './ollamaHost'
import { buildProvider } from './agent/factory'
import type { Provider } from './agent/provider'
import { getKey, keyStatus } from './keys'
import { sortByQuality } from './catalog'
import { ollamaStatus } from './ollama'

export { ollamaStatus }
export type ModelOption = { id: string; label: string; group: string }

// Anthropic ids are known. OpenAI and OpenRouter catalogues change too fast to hardcode: the user adds ids in Settings.
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']

export const makeProvider = (id: string, numCtx?: number): Provider => buildProvider(id, getKey, { numCtx })

export async function listModels(): Promise<ModelOption[]> {
  const out: ModelOption[] = []
  for (const name of sortByQuality((await ollamaStatus()).models)) out.push({ id: `ollama:${name}`, label: name, group: 'Local (Ollama)' }) // cloud models are listed even when Ollama is not running
  if (keyStatus().anthropic) for (const m of ANTHROPIC_MODELS) out.push({ id: `anthropic:${m}`, label: m, group: 'Anthropic' })
  return out
}

// Can this model look at pictures? Cloud models are assumed to (the provider says so if not); local ones are asked.
const visionCache = new Map<string, boolean>()
export async function modelSupportsVision(id: string): Promise<boolean> {
  if (!id.startsWith('ollama:')) return true
  const name = id.slice('ollama:'.length)
  const hit = visionCache.get(name)
  if (hit !== undefined) return hit
  try {
    const res = await fetch(`${getHost()}/api/show`, { method: 'POST', body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(4000) })
    const j = (await res.json()) as { capabilities?: string[] }
    const ok = !!j.capabilities?.includes('vision')
    visionCache.set(name, ok)
    return ok
  } catch {
    return false
  }
}
