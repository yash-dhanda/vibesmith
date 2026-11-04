// What a cloud model costs, so the screen can show spend. Prices are US dollars per million tokens, from Anthropic's published
// rates as of `PRICES_AS_OF`. They are estimates: a model we have no price for shows no cost rather than a guess.
// ponytail: only the Claude models are priced (Forge lists those three); OpenAI/OpenRouter models show no cost until someone adds a verified row.
export const PRICES_AS_OF = '2026-10-06'
// `tier`: a prompt longer than `above` tokens is billed, whole, at the tier's rates.
export type Price = { input: number; output: number; tier?: { above: number; input: number; output: number } }

const PRICES: Record<string, Price> = {
  'anthropic:claude-sonnet-5-5': { input: 2, output: 10 },
  'anthropic:claude-opus-5-5': { input: 4, output: 20 },
  'anthropic:claude-haiku-5-5': { input: 0.1, output: 0.5, tier: { above: 100_000, input: 0.5, output: 2.5 } }, // cloud runs trim at 75% of the model's window (150K for Claude), so calls over 100K do happen
}

export const priceFor = (model: string): Price | null => PRICES[model] ?? null

export const costOf = (p: Price, input: number, output: number): number => {
  const r = p.tier && input > p.tier.above ? p.tier : p
  return (input * r.input + output * r.output) / 1e6
}
