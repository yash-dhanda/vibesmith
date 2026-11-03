// Plain-language wording for what the agent is doing, so the UI can tell a run as a story instead of a tool log.

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
    case 'run_command': {
      const c = str(a.command)
      if (/\b(test|pytest|vitest|jest)\b/.test(c)) return 'Running the tests'
      if (/\b(build|compile|tsc)\b/.test(c)) return 'Building the project'
      if (/\b(install|add)\b/.test(c) && /\b(npm|pnpm|yarn|pip|pip3|cargo)\b/.test(c)) return 'Installing packages'
      return `Running ${short(c, 40) || 'a command'}`
    }
    default:
      return name
  }
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
