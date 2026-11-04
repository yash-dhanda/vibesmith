// The "Key answer": the few things the user asked to be handed over (a login, a URL, a command), pulled out of an agent's reply
// so they show as small text in a card instead of hiding in a long summary. Agents mark them with lines that start "KEY:".
const LINE = /^[ \t>*_-]*\**KEY\**\s*:\**\s*(.+?)\s*$/i
export const KEY_MAX_LINES = 8
export const KEY_MAX_CHARS = 240

export function keyLines(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw)
    const v = m?.[1]?.replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, KEY_MAX_CHARS)
    if (v && !seen.has(v)) { seen.add(v); out.push(v) }
    if (out.length >= KEY_MAX_LINES) break
  }
  return out
}

// A reply without its KEY lines, for showing the rest as normal text.
export function withoutKey(text: string): string {
  return text.split('\n').filter((l) => !LINE.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export const KEY_HEADING = '## Key answer'

// A run report carries the lines as a "## Key answer" section; this splits it back into lines and the remaining report.
export function splitKeyAnswer(report: string): { key: string[]; rest: string } {
  const i = report.indexOf(`\n${KEY_HEADING}\n`)
  if (i < 0) return { key: [], rest: report }
  const from = i + 1 + KEY_HEADING.length + 1
  const next = report.indexOf('\n## ', from)
  const body = report.slice(from, next < 0 ? undefined : next)
  const key = body.split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean)
  return { key, rest: report.slice(0, i) + (next < 0 ? '' : report.slice(next)) }
}
