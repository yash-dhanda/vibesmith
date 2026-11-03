import { fitFor, type Fit, type SystemInfo } from './system'

// Models that can use tools (read and edit files, run commands), which is what Forge needs. Sizes are the download size
// from ollama.com (default quantisation); the real number shows while downloading.
export type CatalogModel = { id: string; name: string; sizeGB: number; q: number; tags: string[]; blurb: string } // q: rough quality for agent work, 1 to 10

export const CATALOG: CatalogModel[] = [
  { id: 'qwen3.5:4b', q: 4, name: 'Qwen 3.5 4B', sizeGB: 3.3, tags: ['fast', 'vision'], blurb: 'Small and quick. Good on laptops without a strong graphics card.' },
  { id: 'qwen3.5:9b', q: 6, name: 'Qwen 3.5 9B', sizeGB: 6.6, tags: ['general', 'vision'], blurb: 'Strong all-rounder for an 8 GB or larger graphics card.' },
  { id: 'qwen3.5:27b', q: 8, name: 'Qwen 3.5 27B', sizeGB: 17, tags: ['general', 'coding'], blurb: 'Much stronger at following long instructions. Needs a 24 GB card.' },
  { id: 'qwen3.5:35b', q: 8, name: 'Qwen 3.5 35B (MoE)', sizeGB: 22, tags: ['general', 'coding'], blurb: 'Large mixture-of-experts model. Fast for its size if it fits in memory.' },
  { id: 'qwen3.6:27b', q: 9, name: 'Qwen 3.6 27B', sizeGB: 18, tags: ['coding', 'general'], blurb: 'Latest 27B. A top pick for building software on a 24 GB card.' },
  { id: 'qwen3.6:27b-coding', q: 9, name: 'Qwen 3.6 27B Coding', sizeGB: 18, tags: ['coding'], blurb: 'The 27B tuned for code.' },
  { id: 'qwen3.6:35b', q: 9, name: 'Qwen 3.6 35B (MoE)', sizeGB: 23, tags: ['coding', 'general'], blurb: 'Large mixture-of-experts model for 24 GB+ setups.' },
  { id: 'qwen3-coder:30b', q: 8, name: 'Qwen3 Coder 30B', sizeGB: 19, tags: ['coding'], blurb: 'Built for coding agents. Needs about 20 GB of memory.' },
  { id: 'qwen3:4b', q: 3, name: 'Qwen3 4B', sizeGB: 2.5, tags: ['fast'], blurb: 'Tiny and fast. Fine for simple edits.' },
  { id: 'qwen3:8b', q: 5, name: 'Qwen3 8B', sizeGB: 5.2, tags: ['general'], blurb: 'Reliable 8B that fits most 8 GB graphics cards.' },
  { id: 'qwen3:14b', q: 6, name: 'Qwen3 14B', sizeGB: 9.3, tags: ['general', 'coding'], blurb: 'Noticeably better than 8B. Needs a 12 GB card.' },
  { id: 'qwen2.5-coder:7b', q: 5, name: 'Qwen2.5 Coder 7B', sizeGB: 4.7, tags: ['coding', 'fast'], blurb: 'Compact coding model.' },
  { id: 'qwen2.5-coder:14b', q: 6, name: 'Qwen2.5 Coder 14B', sizeGB: 9.0, tags: ['coding'], blurb: 'Mid-size coding model for 12 GB cards.' },
  { id: 'qwen2.5-coder:32b', q: 7, name: 'Qwen2.5 Coder 32B', sizeGB: 20, tags: ['coding'], blurb: 'Large coding model. Needs 24 GB.' },
  { id: 'gemma4:e4b', q: 5, name: 'Gemma 4 E4B', sizeGB: 6.6, tags: ['general', 'vision'], blurb: "Google's efficient 4B-class model with image input." },
  { id: 'gemma4:12b', q: 6, name: 'Gemma 4 12B', sizeGB: 8.0, tags: ['general', 'vision'], blurb: 'Mid-size Gemma with a long 256K context.' },
  { id: 'gemma4:26b', q: 7, name: 'Gemma 4 26B', sizeGB: 18, tags: ['general', 'vision'], blurb: 'Large Gemma for 24 GB cards.' },
  { id: 'gpt-oss:20b', q: 7, name: 'gpt-oss 20B', sizeGB: 14, tags: ['general', 'thinking'], blurb: "OpenAI's open model. Strong reasoning, around 16 GB." },
  { id: 'llama3.2:3b', q: 2, name: 'Llama 3.2 3B', sizeGB: 2.0, tags: ['fast'], blurb: 'Very small and quick, for low-end computers.' },
  { id: 'llama3.1:8b', q: 4, name: 'Llama 3.1 8B', sizeGB: 4.9, tags: ['general'], blurb: "Meta's popular 8B." },
  { id: 'mistral-nemo', q: 5, name: 'Mistral Nemo 12B', sizeGB: 7.1, tags: ['general'], blurb: 'Capable 12B from Mistral.' },
]

export type Ranked = CatalogModel & { fit: Fit; best: boolean }

const WEIGHT: Record<Fit, number> = { gpu: 3, partial: 2, cpu: 1, 'too-big': 0 }

// Fits-on-the-GPU first, then the strongest that fits, with a few marked as the best picks for this PC.
export function rank(s: Pick<SystemInfo, 'ramGB' | 'gpu'>, catalog = CATALOG): Ranked[] {
  const all = catalog.map((m) => ({ ...m, fit: fitFor(m.sizeGB, s), best: false }))
  all.sort((a, b) => WEIGHT[b.fit] - WEIGHT[a.fit] || b.q - a.q || b.sizeGB - a.sizeGB)
  const bestFit = all[0]?.fit
  // "Best for your PC" only means something for models that run at a usable speed
  if (bestFit === 'gpu' || bestFit === 'partial') all.filter((m) => m.fit === bestFit).slice(0, 2).forEach((m) => (m.best = true))
  else if (bestFit === 'cpu') all.filter((m) => m.fit === 'cpu' && m.sizeGB <= 6).slice(0, 1).forEach((m) => (m.best = true))
  return all
}
