// What a cloud model costs, so the screen can show spend. Prices are US dollars per million tokens, from Anthropic's published
// rates as of `PRICES_AS_OF`. They are estimates: a model we have no price for shows no cost rather than a guess.
// ponytail: only the Claude models are priced (Forge lists those three); OpenAI/OpenRouter models show no cost until someone adds a verified row.
export const PRICES_AS_OF = '2026-10-06'
export type Price = { input: number; output: number }

const PRICES: Record<string, Price> = {
  'anthropic:claude-sonnet-5-5': { input: 2, output: 10 },
  'anthropic:claude-opus-5-5': { input: 4, output: 20 },
  'anthropic:claude-haiku-5-5': { input: 0.1, output: 0.5 }, // above 100K prompt tokens it is 0.5 / 2.5: not modelled, Forge trims well below that
}

export const priceFor = (model: string): Price | null => PRICES[model] ?? null

export const costOf = (p: Price, input: number, output: number): number => (input * p.input + output * p.output) / 1e6
