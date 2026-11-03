import { anthropic, openai, openrouter } from './api'
import { ollama, type Provider } from './provider'

export type CloudProvider = 'anthropic' | 'openai' | 'openrouter'
export const CLOUD_NAMES: Record<CloudProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter' }
const FACTORY = { anthropic, openai, openrouter }

// Model ids are "provider:model", e.g. "ollama:qwen3:8b" or "anthropic:claude-sonnet-5-5".
// Kept free of Electron so the eval script can use it; the app passes its keychain lookup, the eval passes env vars.
export function buildProvider(id: string, keyOf: (p: CloudProvider) => string | null, opts: { numCtx?: number } = {}): Provider {
  const i = id.indexOf(':')
  const kind = id.slice(0, i)
  const model = id.slice(i + 1)
  if (i < 1 || !model) throw new Error(`Unknown model "${id}"`)
  if (kind === 'ollama') return ollama({ model, numCtx: opts.numCtx })
  if (kind in FACTORY) {
    const apiKey = keyOf(kind as CloudProvider)
    if (!apiKey) throw new Error(`No ${CLOUD_NAMES[kind as CloudProvider]} API key. Add one in Settings (gear icon).`)
    return FACTORY[kind as CloudProvider]({ apiKey, model })
  }
  throw new Error(`Unknown model "${id}"`)
}
