import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './redact'
import type { Run, RunEvent, Task } from './types'

// The project's running history: a plain text file in the project folder, written by Forge, that says what has happened so far
// (goals, plans, who did what, reviews, decisions, answers from the user, results). It only grows; agents are pointed at it and read it.
// It sits in .forge/ and is hidden from git through .git/info/exclude (local to this computer), so it never shows up in a diff.

export const HISTORY_DIR = '.forge'
export const HISTORY_FILE = 'what-happened.txt'
const stamp = (t = Date.now()) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
const oneLine = (s: string, n: number) => redact(s).replace(/\s+/g, ' ').trim().slice(0, n)
const AGENT = { claude: 'Claude', codex: 'Codex', local: 'Local' } as const

export const historyPath = (project: string) => join(project, HISTORY_DIR, HISTORY_FILE)

function ensure(project: string): string {
  const dir = join(project, HISTORY_DIR)
  const file = join(dir, HISTORY_FILE)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `WHAT HAPPENED IN THIS PROJECT\nKept by Forge. New entries are added at the bottom. Started ${stamp()}.\n`)
    try {
      const exclude = join(project, '.git', 'info', 'exclude')
      if (existsSync(join(project, '.git')) && statSync(join(project, '.git')).isDirectory()) {
        const have = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
        if (!have.split('\n').includes(`${HISTORY_DIR}/`)) {
          mkdirSync(join(project, '.git', 'info'), { recursive: true })
          appendFileSync(exclude, `${have && !have.endsWith('\n') ? '\n' : ''}${HISTORY_DIR}/\n`)
        }
      }
    } catch {}
  }
  return file
}

export function writeHistory(project: string, lines: string | string[]) {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean)
  if (!list.length) return
  try { appendFileSync(ensure(project), list.map((l) => `[${stamp()}] ${redact(l)}\n`).join('')) } catch {}
}

// The end of the file, for an agent prompt: the pointer to the whole file plus the newest lines.
export function historyBlock(project: string, tail = 40): string {
  const file = historyPath(project)
  if (!existsSync(file)) return ''
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return '' }
  const lines = text.split('\n').filter(Boolean)
  if (lines.length < 3) return ''
  return `PROJECT HISTORY: Forge keeps a log of everything that has happened in this project so far (goals, plans, who did what, reviews, decisions, the user's answers, results). It is at ${file} and only grows; the newest entries are at the end. Read the end of it if you need to know what was already done or decided, and search it for names you need. Do not edit it. Newest entries:\n${lines.slice(-tail).join('\n')}`
}

// Which run events become history lines. Task status is logged when it changes, not every time a task is touched.
export class HistoryRecorder {
  private status = new Map<string, string>()
  private runStatus = new Map<string, string>()

  lines(run: Run, ev: RunEvent): string[] {
    switch (ev.type) {
      case 'run': {
        if (this.runStatus.get(run.id) === ev.status) return []
        this.runStatus.set(run.id, ev.status)
        return [`Run ${run.id} is ${ev.status}${ev.reason ? `: ${oneLine(ev.reason, 300)}` : ''}`]
      }
      case 'plan':
        return [`Run ${run.id} plan${run.plan?.plannedBy ? ` (by ${AGENT[run.plan.plannedBy]})` : ''}: ${oneLine(ev.summary, 400)}`, ...ev.tasks.map((t) => `  task ${t.id} for ${AGENT[t.agent]}: ${oneLine(t.title, 160)}${t.deps.length ? ` (after ${t.deps.join(', ')})` : ''}`)]
      case 'task': {
        const t: Task = ev.task
        const key = `${run.id}:${t.id}`
        const now = `${t.status}${t.phase ? `/${t.phase}` : ''}`
        if (this.status.get(key) === now) return []
        this.status.set(key, now)
        if (t.status === 'queued') return []
        const files = t.changed?.length ? ` Files: ${t.changed.slice(0, 12).map((c) => c.path).join(', ')}${t.changed.length > 12 ? ` and ${t.changed.length - 12} more` : ''}.` : ''
        const end = ['done', 'failed', 'blocked', 'cancelled'].includes(t.status)
        return [`Task ${t.id} "${oneLine(t.title, 120)}" (${AGENT[t.agent]}) is ${now}.${end && t.summary ? ` ${oneLine(t.summary, 600)}` : ''}${end && t.error ? ` Problem: ${oneLine(t.error, 300)}` : ''}${end ? files : ''}`]
      }
      case 'message': {
        const m = ev.message
        if (!['finding', 'review', 'decision', 'handoff', 'question', 'steer'].includes(m.kind)) return []
        const who = m.from === 'user' ? 'The user' : m.from === 'orchestrator' ? 'Forge' : AGENT[m.from]
        return [`${who} to ${m.to === 'all' || m.to === 'user' ? m.to : AGENT[m.to]} (${m.kind})${m.taskId ? ` on ${m.taskId}` : ''}: ${oneLine(m.body, 700)}`]
      }
      case 'approval': {
        const a = ev.approval
        const who = a.agent ? AGENT[a.agent] : 'The team'
        if (a.status === 'pending') return a.kind === 'question' ? [`${who} asked the user: ${oneLine(a.title, 300)}${a.options?.length ? ` Options: ${a.options.map((o) => o.label).join(' / ')}` : ''}`] : []
        if (a.kind === 'question') return [`The user answered "${oneLine(a.title, 160)}": ${a.status === 'allowed' ? oneLine(a.answer ?? '', 400) || 'yes' : 'skipped'}`]
        return [`${a.kind.replace('_', ' ')} "${oneLine(a.title, 160)}" was ${a.status}${a.answer ? `: ${oneLine(a.answer, 200)}` : ''}`]
      }
      case 'verify':
        return [`Project check "${oneLine(ev.command, 160)}" ${ev.ok ? 'passed' : 'failed'}${ev.ok ? '' : `: ${oneLine(ev.output.split('\n').slice(-6).join(' '), 400)}`}`]
      case 'final':
        return [`Run ${run.id} result: ${oneLine(ev.final.report, 600)}${ev.final.verifyOk === false ? ' The project check failed.' : ev.final.verifyOk ? ' The project check passed.' : ''}`]
      default:
        return []
    }
  }
}
