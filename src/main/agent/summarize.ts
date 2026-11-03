import type { Provider } from './provider'

// One short plain-language sentence per changed file, written by the model after the run, for people who do not read code.
// Best effort: slow or failing models just give no summaries. The UI marks them as model-written.

export type FileForSummary = { path: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number; excerpt: string }

const MAX_FILES = 12

export function summaryPrompt(files: FileForSummary[]): string {
  const blocks = files.slice(0, MAX_FILES).map((f) => `### ${f.path} (${f.status}, +${f.added} -${f.removed})\n${f.excerpt.slice(0, 900)}`).join('\n\n')
  return `Describe each changed file for someone who cannot read code. One short sentence per file (under 14 words), about what the user will see or what the feature does, not about code. Reply with one line per file, exactly "path: sentence", nothing else.\n\n${blocks}`
}

export function parseSummaries(reply: string, paths: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of reply.split('\n')) {
    const i = line.indexOf(': ')
    if (i < 1) continue
    const p = line.slice(0, i).replace(/^[-*\s`#]+|`/g, '').trim()
    const text = line.slice(i + 2).trim().replace(/\s+/g, ' ').slice(0, 140)
    if (paths.includes(p) && text) out[p] = text
  }
  return out
}

export async function summarizeChanges(provider: Provider, files: FileForSummary[], signal: AbortSignal): Promise<Record<string, string>> {
  if (!files.length) return {}
  let reply = ''
  try {
    await provider.chat([{ role: 'user', content: summaryPrompt(files) }], [], (t) => (reply += t), signal, {})
  } catch {
    return {}
  }
  return parseSummaries(reply, files.map((f) => f.path))
}
