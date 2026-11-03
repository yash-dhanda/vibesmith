import { buildProvider } from './agent/factory'
import type { Provider } from './agent/provider'
import { getKey, keyStatus } from './keys'

export type ModelOption = { id: string; label: string; group: string }

// Anthropic ids are known. OpenAI and OpenRouter catalogues change too fast to hardcode: the user adds ids in Settings.
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']

export const makeProvider = (id: string): Provider => buildProvider(id, getKey)

export async function listModels(): Promise<ModelOption[]> {
  const out: ModelOption[] = []
  try {
    const j = (await (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })).json()) as { models: { name: string }[] }
    for (const m of j.models) out.push({ id: `ollama:${m.name}`, label: m.name, group: 'Local (Ollama)' })
  } catch {
    // Ollama not running: cloud models can still be listed
  }
  if (keyStatus().anthropic) for (const m of ANTHROPIC_MODELS) out.push({ id: `anthropic:${m}`, label: m, group: 'Anthropic' })
  return out
}
