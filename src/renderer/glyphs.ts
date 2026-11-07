import type { Run, Task } from '../main/team/types'
import type { IconName } from './icons'

// Forge's one status mark, drawn like Claude Code's checklist: a dashed ring waits, a turning arc works, a check is done, a cross failed,
// a dash was skipped, an amber dot needs you. Every mark draws every glyph; data-state shows one, so a change of state crossfades in place.
export type Mark = 'pending' | 'active' | 'done' | 'failed' | 'skipped' | 'ask'
export const RUN_MARK: Record<Run['status'], Mark> = { planning: 'active', running: 'active', verifying: 'active', paused: 'pending', awaiting_approval: 'ask', done: 'done', failed: 'failed', cancelled: 'skipped', interrupted: 'pending' }
export const TASK_MARK: Record<Task['status'], Mark> = { queued: 'pending', proposed: 'pending', running: 'active', blocked: 'pending', done: 'done', failed: 'failed', cancelled: 'skipped', interrupted: 'pending' }
// Agent tool steps in the Crew Details lanes: a line icon from icons.ts.
export const TOOL_ICON: Record<string, IconName> = { read_file: 'file', list_dir: 'folder', search: 'search', edit_file: 'edit', create_file: 'plus', run_command: 'terminal', update_plan: 'list', read: 'file', edit: 'edit', command: 'terminal', other: 'dots' }
const GLYPH = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle class="ck-ring" cx="7" cy="7" r="6" pathLength="40"/><path class="ck-done" d="m4.4 7.3 1.9 1.9 3.3-3.7"/><path class="ck-fail" d="m5 5 4 4m0-4-4 4"/><path class="ck-skip" d="M4.8 7h4.4"/><circle class="ck-ask" cx="7" cy="7" r="2.2"/></svg><i class="ck-spin"></i>'
export function mark(state: Mark, label = ''): HTMLElement {
  const m = document.createElement('span')
  m.className = 'ck-mark'; m.dataset.state = state; m.innerHTML = GLYPH // a constant, never user text
  if (label) { m.setAttribute('role', 'img'); m.setAttribute('aria-label', label) } else m.setAttribute('aria-hidden', 'true')
  return m
}
