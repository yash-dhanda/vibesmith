import type { RunEvent } from './types'

// Display hygiene: obvious secrets are masked in what Forge shows and saves about a run (events, messages, reports).
// The agents themselves are not affected. Deliberately conservative: a false positive would hide real code from the live view,
// so key=value pairs only match a quoted, long, mixed value.
const KEY_VALUE = /\b(api[_-]?key|secret|token|passw(?:or)?d|auth)(["']?\s*[:=]\s*)(["'])([A-Za-z0-9_\-./+=]{16,})\3/gi
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]

export function redact(text: string): string {
  if (!text) return text
  let out = text
  for (const re of PATTERNS) out = out.replace(re, '[secret removed]')
  return out.replace(KEY_VALUE, (m, key, sep, q, value) => (/\d/.test(value) && /[A-Za-z]/.test(value) ? `${key}${sep}${q}[secret removed]${q}` : m))
}

const TEXT_KEYS = ['text', 'summary', 'message', 'body', 'detail', 'title', 'output', 'report', 'verifyOutput'] as const
const deep = (v: unknown, depth = 0): unknown => {
  if (typeof v === 'string') return redact(v)
  if (depth > 6 || !v || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => deep(x, depth + 1))
  const o: Record<string, unknown> = { ...(v as object) }
  for (const k of Object.keys(o)) if ((TEXT_KEYS as readonly string[]).includes(k) || (o[k] && typeof o[k] === 'object')) o[k] = deep(o[k], depth + 1)
  return o
}
export const redactEvent = (ev: RunEvent): RunEvent => deep(ev) as RunEvent
