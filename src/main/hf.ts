// Community models on Hugging Face. Ollama can pull any GGUF repository as "hf.co/<owner>/<repo>".
export type HFModel = { id: string; pullName: string; downloads: number; likes: number }

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export async function searchHF(query: string, f: Fetch = (u) => fetch(u, { signal: AbortSignal.timeout(10_000) })): Promise<HFModel[]> {
  const q = query.trim()
  if (!q) return []
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=20`
  const res = await f(url)
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}`)
  const list = (await res.json()) as { id?: string; downloads?: number; likes?: number }[]
  return list
    .filter((m): m is { id: string; downloads?: number; likes?: number } => typeof m.id === 'string' && /^[\w.-]+\/[\w.-]+$/.test(m.id))
    .map((m) => ({ id: m.id, pullName: `hf.co/${m.id}`, downloads: m.downloads ?? 0, likes: m.likes ?? 0 }))
}
