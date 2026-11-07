import { execFileSync } from 'node:child_process'
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { redact } from './redact'
import type { Run, RunEvent, Task } from './types'

// The project's running history: a plain text file in the project folder, written by Forge, that says what has happened so far
// (goals, plans, who did what, reviews, decisions, answers from the user, results). It only grows; agents are pointed at it and read it.
// It sits in .forge/ and is hidden from git through the repository's info/exclude (local to this computer), so it never shows up in a diff.
// A project is not trusted: .forge or the file may be a symlink to somewhere else, so neither is ever followed.

export const HISTORY_DIR = '.forge'
export const HISTORY_FILE = 'what-happened.txt'
// Local time with its offset, because people and agents read these lines as the clock on the wall.
const stamp = (t = Date.now()) => {
  const off = -new Date(t).getTimezoneOffset()
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  return `${new Date(t + off * 60_000).toISOString().slice(0, 16).replace('T', ' ')} ${off < 0 ? '-' : '+'}${pad(off / 60)}:${pad(off % 60)}`
}
const oneLine = (s: string, n: number) => redact(s).replace(/\s+/g, ' ').trim().slice(0, n)
const AGENT = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', local: 'Local' } as const
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export const historyPath = (project: string) => join(project, HISTORY_DIR, HISTORY_FILE)

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
// O_NOFOLLOW makes the open fail if the last part of the path is a link, even one that points nowhere yet.
function appendFile(file: string, text: string) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o644)
  try { writeSync(fd, text) } finally { closeSync(fd) }
}
const hidden = new Set<string>() // projects whose exclude entry is known to be in place

function hideFromGit(project: string) {
  if (hidden.has(project) || !existsSync(join(project, '.git'))) return
  let exclude = ''
  try { exclude = resolve(project, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: project, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_CEILING_DIRECTORIES: resolve(project, '..') } }).toString().trim()) } catch {}
  if (!exclude && statSync(join(project, '.git')).isDirectory()) exclude = join(project, '.git', 'info', 'exclude')
  if (!exclude) return
  const have = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!have.split('\n').includes(`${HISTORY_DIR}/`)) {
    mkdirSync(join(exclude, '..'), { recursive: true })
    appendFile(exclude, `${have && !have.endsWith('\n') ? '\n' : ''}${HISTORY_DIR}/\n`)
  }
  hidden.add(project)
}

function ensure(project: string): string {
  const dir = join(project, HISTORY_DIR)
  const file = join(dir, HISTORY_FILE)
  if (isLink(dir) || isLink(file)) throw new Error('The history folder is a link.')
  const fresh = !existsSync(file)
  if (fresh) mkdirSync(dir, { recursive: true })
  try { hideFromGit(project) } catch {}
  if (fresh) appendFile(file, `WHAT HAPPENED IN THIS PROJECT\nKept by Forge. New entries are added at the bottom. Started ${stamp()}.\n`)
  return file
}

export function writeHistory(project: string, lines: string | string[]) {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean)
  if (!list.length || !existsSync(project)) return // a project that was moved or deleted is not made again for a log line
  try { appendFile(ensure(project), list.map((l) => `[${stamp()}] ${redact(l)}\n`).join('')) } catch {}
}

// The end of the file, for an agent prompt: the pointer to the whole file plus the newest lines.
export function readHistory(project: string): string {
  const file = historyPath(project)
  if (isLink(join(project, HISTORY_DIR))) return ''
  try { return readFileSync(file, { encoding: 'utf8', flag: constants.O_RDONLY | NOFOLLOW }) } catch { return '' }
}

export function historyBlock(project: string, tail = 40): string {
  const file = historyPath(project)
  const text = readHistory(project)
  if (!text) return ''
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
