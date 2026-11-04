// How many tokens a cloud model can take, so the shrinker (context.ts, which already keeps headroom) trims at the right point.
// Ordered: a number the user set in Settings, a number the provider reported, a conservative table by model id, then DEFAULT.
export const DEFAULT_WINDOW = 128_000

// First match wins. Only numbers we are sure of; anything else falls to DEFAULT.
const TABLE: [RegExp, number][] = [
  [/(^|[^a-z0-9])1m($|[^a-z0-9])/, 1_000_000], // an id that says 1m, e.g. "claude-sonnet-4-5[1m]"
  [/^claude/, 200_000],
  [/^gpt-4o/, 128_000], // gpt-4o and gpt-4o-mini
  [/^gpt-4\.1/, 1_000_000], // really 1,047,576: rounded down
  [/^gpt-5/, 400_000],
  [/^(o[34](-|$)|o1(-pro)?$)/, 200_000], // o1, o3, o4-mini; o1-mini and o1-preview (128K) fall to the default
  [/^gemini/, 1_000_000],
]

const num = (n: unknown) => (typeof n === 'number' && isFinite(n) && n > 0 ? n : 0)

export function contextWindowFor(modelId: string, known?: number, override?: number): number {
  let n = num(override) || num(known)
  if (!n) {
    // "openrouter:openai/gpt-4o:online" -> "gpt-4o:online"; "anthropic:claude-x" -> "claude-x"
    const id = String(modelId ?? '').toLowerCase().replace(/^(anthropic|openai|openrouter):/, '').replace(/^.*\//, '')
    n = TABLE.find(([re]) => re.test(id))?.[1] ?? DEFAULT_WINDOW
  }
  return Math.min(2_000_000, Math.max(8_000, Math.round(n)))
}
