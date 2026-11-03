import { anthropic, openai, openrouter } from './agent/api'
import { ollama, type Provider } from './agent/provider'
import { getKey, keyStatus, type KeyProvider } from './keys'

export type ModelOption = { id: string; label: string; group: string }

const NAMES: Record<KeyProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter' }
const FACTORY = { anthropic, openai, openrouter }

// Anthropic ids are known. OpenAI and OpenRouter catalogues change too fast to hardcode: the user adds ids in Settings.
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']

// Model ids are "provider:model", e.g. "ollama:qwen3:8b" or "anthropic:claude-sonnet-5-5".
export function makeProvider(id: string): Provider {
  const i = id.indexOf(':')
  const kind = id.slice(0, i)
  const model = id.slice(i + 1)
  if (i < 1 || !model) throw new Error(`Unknown model "${id}"`)
  if (kind === 'ollama') return ollama({ model })
  if (kind in FACTORY) {
    const apiKey = getKey(kind as KeyProvider)
    if (!apiKey) throw new Error(`No ${NAMES[kind as KeyProvider]} API key. Add one in Settings (gear icon).`)
    return FACTORY[kind as KeyProvider]({ apiKey, model })
  }
  throw new Error(`Unknown model "${id}"`)
}

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
