// Plain-language wording for what the agent is doing, so the UI can tell a run as a story instead of a tool log.
import { withoutKey } from '../keyAnswer'

export type PlanItem = { text: string; status: 'todo' | 'doing' | 'done' }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const short = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function describeTool(name: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const path = str(a.path)
  switch (name) {
    case 'list_dir':
      return !path || path === '.' ? 'Looking through the project' : `Looking in ${path}`
    case 'read_file':
      return `Reading ${path || 'a file'}`
    case 'search':
      return `Searching for “${short(str(a.pattern), 32)}”`
    case 'create_file':
      return `Creating ${path || 'a file'}`
    case 'edit_file':
      return `Editing ${path || 'a file'}`
    case 'update_plan':
      return 'Updating the plan'
    case 'run_command':
      return describeCommand(str(a.command))
    default:
      return name
  }
}

const tail2 = (p: string) => p.replace(/^['"]|['"]$/g, '').split('/').filter(Boolean).slice(-2).join('/')
// A shell command in a few plain words ("Running the tests", "Reading login/route.ts"), never the command itself.
export function describeCommand(command: string): string {
  const step = command.split(/\s*(?:&&|\|\||;|\n)\s*/).map((s) => s.replace(/^(\w+=\S*\s+)+/, '').trim()).find((s) => s && !/^(cd|export|source|set|echo|true|:)\b/.test(s)) ?? ''
  const c = step.split(/\s+\|\s*/)[0] // "npm test 2>&1 | tail -20" -> "npm test 2>&1"
  const file = /(?:^|\s)['"]?((?:[\w.@-]*\/)*[\w@-][\w.@-]*\.[A-Za-z]\w{0,5})['"]?(?=\s|$)/.exec(c)?.[1]
  if (/\b(vitest|jest|pytest|mocha|playwright test|go test|cargo test|(npm|pnpm|yarn|bun)( run)? test)\b/.test(c)) return 'Running the tests'
  if (/\b(eslint|ruff|flake8|biome|(npm|pnpm|yarn|bun)( run)? lint)\b/.test(c)) return 'Running the linter'
  if (/\btsc\b/.test(c)) return 'Checking the types'
  if (/\b(build|compile|webpack|esbuild)\b/.test(c)) return 'Building the project'
  if (/\b(npm|pnpm|yarn|bun|pip3?|uv|cargo)\s+(i|install|add|ci)\b/.test(c)) return 'Installing packages'
  if (/\b(npm|pnpm|yarn|bun)( run)? (dev|start|serve|preview)\b|\b(next|vite) (dev|start)\b/.test(c)) return 'Starting the website'
  if (/^git\s+(status|diff|log|show)\b/.test(c)) return 'Looking at the changes'
  if (/^git\b/.test(c)) return 'Using git'
  if (/^sed\s+-i/.test(c)) return file ? `Editing ${tail2(file)}` : 'Editing a file'
  if (/^(cat|sed|head|tail|less|nl|bat|wc|awk)\b/.test(c)) return file ? `Reading ${tail2(file)}` : 'Reading a file'
  if (/^(rg|grep|ag|ack)\b/.test(c)) return 'Searching the code'
  if (/^(ls|find|fd|tree)\b/.test(c)) return 'Looking through the project'
  if (/^(curl|wget)\b/.test(c)) return 'Checking a web address'
  if (/^(node|python3?|deno|bun|tsx)\b/.test(c)) return file ? `Running ${tail2(file)}` : 'Running a script'
  if (/^(mkdir|touch|cp|mv|rm)\b/.test(c)) return 'Arranging files'
  return 'Running a command'
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}✓✗✘]/gu
const LABEL = /^(summary|results?|verification|key (results|changes|points)|changes|what (i|was) (did|done|changed)|status|notes?|tests?|testing|next steps|details|files)\b[^.!?]{0,40}:$/i
// An agent's summary as one plain line: no KEY lines, code blocks, markdown or emoji; whole sentences up to `max`, else cut at a word.
export function plainLine(text: string, max = 140): string {
  const flat = withoutKey(text)
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .split('\n')
    .map((l) => l
      .replace(/^\s*#{1,6}\s+(.*?)[\s#:]*$/, '$1:') // a heading reads as a label: "## Summary" -> "Summary:"
      .replace(/^\s*(>\s*|[-*+•]\s+|\d+[.)]\s+)/, '') // quote and list markers
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
      .replace(/\*\*|__|`/g, '')
      .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=[\s.,;:!?)]|$)/g, '$1$2') // *em*, _em_
      .replace(EMOJI, '')
      .replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^[|=-]/.test(l) && !LABEL.test(l)) // tables, rules, "Summary:" labels
    .map((l, i, all) => (i < all.length - 1 && !/[.!?:;,]$/.test(l) ? `${l}.` : l)) // lines and list items join as sentences
    .join(' ')
  if (flat.length <= max) return flat
  let out = ''
  for (const s of flat.split(/(?<!\b(?:e\.g|i\.e|vs)\.)(?<=[.!?])\s+/)) { if (out.length + s.length + 1 > max) break; out = out ? `${out} ${s}` : s }
  if (out) return out
  const cut = flat.slice(0, max)
  const at = cut.lastIndexOf(' ')
  return `${cut.slice(0, at > max * 0.6 ? at : max - 1).replace(/[\s,;:(-]+$/, '')}…`
}

// The model writes the plan as plain lines: "[x] done", "[>] doing", "[ ] to do". Lines without a marker count as to do.
export function parsePlan(steps: string): PlanItem[] {
  return steps
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((l) => {
      const m = /^[-*]?\s*\[([ xX>~-]?)\]\s*(.*)$/.exec(l)
      const mark = m ? m[1].toLowerCase() : ' '
      const text = (m ? m[2] : l.replace(/^[-*\d.)\s]+/, '')).trim()
      return { text: short(text, 120), status: mark === 'x' ? 'done' : mark === '>' || mark === '~' ? 'doing' : 'todo' } as PlanItem
    })
    .filter((i) => i.text)
}
