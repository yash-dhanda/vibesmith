import type { Run, Task } from '../main/team/types'

// The only emoji in Forge's UI live here: they mark a status, an approval, or a step an agent is taking.
// Everything else (headings, buttons, menus, rows, hints) is words or an SVG icon from icons.ts.
export const RUN_GLYPH: Record<Run['status'], string> = { planning: '🧠', running: '🔨', paused: '⏸️', verifying: '🔎', awaiting_approval: '👀', done: '✅', failed: '⚠️', cancelled: '🚫', interrupted: '🔌' }
export const TASK_GLYPH: Record<Task['status'], string> = { queued: '⏳', running: '🔨', blocked: '🧱', done: '✅', failed: '⚠️', cancelled: '🚫', interrupted: '🔌', proposed: '📝' }
export const STEP_GLYPH = { working: '🔨', done: '✅', failed: '⚠️', ok: '✅', bad: '❌', skipped: '⏭️', ask: '✋', none: '➖', undone: '↩️' } as const
// Agent tool steps, in chat and in the Team lanes.
export const TOOL_GLYPH: Record<string, string> = { read_file: '📖', list_dir: '📂', search: '🔍', edit_file: '✏️', create_file: '🆕', run_command: '🖥️', update_plan: '🗺️', read: '📖', edit: '✏️', command: '🖥️', other: '🔧' }
