// Ollama's /api/pull streams one JSON object per line: a status, and for each layer its digest, total and completed bytes.
export type PullProgress = { status: string; completed: number; total: number; percent: number; bytesPerSec: number; done: boolean; error?: string }

export class PullTracker {
  private layers = new Map<string, { total: number; completed: number }>()
  private samples: { t: number; bytes: number }[] = []

  update(line: string, now = Date.now()): PullProgress | null {
    if (!line.trim()) return null
    let j: { status?: string; digest?: string; total?: number; completed?: number; error?: string }
    try {
      j = JSON.parse(line)
    } catch {
      return null
    }
    if (j.error) return { status: j.error, completed: 0, total: 0, percent: 0, bytesPerSec: 0, done: true, error: j.error }
    if (j.digest && typeof j.total === 'number') this.layers.set(j.digest, { total: j.total, completed: j.completed ?? 0 })
    let completed = 0
    let total = 0
    for (const l of this.layers.values()) (completed += l.completed), (total += l.total)
    // speed over the last few seconds, not since the start, so it reacts when the network slows down
    this.samples.push({ t: now, bytes: completed })
    while (this.samples.length > 2 && now - this.samples[0].t > 6000) this.samples.shift()
    const first = this.samples[0]
    const bps = now > first.t ? Math.max(0, ((completed - first.bytes) / (now - first.t)) * 1000) : 0
    const done = j.status === 'success'
    return { status: j.status ?? '', completed, total, percent: done ? 100 : total ? Math.min(99, Math.floor((completed / total) * 100)) : 0, bytesPerSec: bps, done }
  }
}
