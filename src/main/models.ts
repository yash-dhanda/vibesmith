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
