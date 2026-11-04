import { mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Run, RunEvent, TeamConfig } from './types'

// The overnight queue: goals that run one after another, each as an ordinary crew run. Items run strictly one at a time, so the plan
// allowance is spent in a predictable order. A result lands by itself only when the item asked for it and nothing looked wrong; otherwise the
// queue stops with the run left for review ("needs you").

export type QueueStatus = 'waiting' | 'running' | 'landed' | 'ready' | 'failed' | 'skipped'
export type QueueItem = {
  id: string
  project: string
  goal: string
  config: Partial<TeamConfig>
  attachments?: unknown
  autoLand: boolean // off unless the user chose it for this item
  continueOnFail: boolean // after a failed or cancelled run, go on with the next item instead of stopping
  status: QueueStatus
  runId?: string
  startedAt?: number
  endedAt?: number
  note: string
}

export type QueueDeps = {
  file: string
  start: (project: string, goal: string, config: Partial<TeamConfig>, attachments?: unknown) => Promise<{ id: string }>
  getRun: (runId: string) => Run | null
  onRunEvent: (cb: (ev: RunEvent) => void) => void
  land: (runId: string) => Promise<{ ok: boolean; message: string }>
  notify?: (kind: 'finished' | 'attention') => void
}

const STATUSES: QueueStatus[] = ['waiting', 'running', 'landed', 'ready', 'failed', 'skipped']
const MAX_ITEMS = 200

// Why a finished run should not land by itself, or null. The notes read "<agent>: FAIL — ..." and "Security review: FAIL — ...".
export function holdBack(run: Run): string | null {
  if (!run.final) return 'The run has no result to land.'
  if (run.final.verifyOk === false) return 'The final check failed.'
  const bad = run.final.reviewNotes.find((n) => /: FAIL —/.test(n))
  return bad ? `A review said FAIL: ${bad.slice(0, 200)}` : null
}

export class RunQueue {
  private items: QueueItem[] = []
  private on = false
  private pumping = false
  private settling = new Set<string>() // items whose run is being handled, so the events that handling causes are not handled again

  constructor(private d: QueueDeps) {
    this.items = this.load()
    // After a restart nothing runs by itself: a run that was in progress is interrupted and waits for the user.
    for (const it of this.items) if (it.status === 'running') this.reconcile(it)
    d.onRunEvent((ev) => {
      if (ev.type !== 'run') return
      const it = this.items.find((i) => i.runId === ev.runId)
      if (!it) return
      if (ev.status === 'paused' && it.status === 'running') {
        it.note = ev.reason ?? 'The run is paused.'
        this.save()
        this.d.notify?.('attention')
      } else if (ev.status === 'running' && it.status === 'running' && it.note) (it.note = ''), this.save()
      else void Promise.resolve().then(() => this.check(it)) // after the orchestrator has finished setting the new state up
    })
  }

  get active() {
    return this.on
  }
  list(): QueueItem[] {
    return this.items.map((i) => ({ ...i }))
  }

  add(o: { project: string; goal: string; config?: Partial<TeamConfig>; attachments?: unknown; autoLand?: boolean; continueOnFail?: boolean }): QueueItem {
    if (!o.goal?.trim()) throw new Error('Describe what the team should build.')
    if (!o.project) throw new Error('Choose a folder for this goal.')
    if (this.items.length >= MAX_ITEMS) throw new Error('The queue is full. Remove finished items first.')
    const it: QueueItem = { id: `q${Date.now().toString(36)}${randomUUID().slice(0, 4)}`, project: o.project, goal: o.goal.trim(), config: o.config ?? {}, attachments: o.attachments, autoLand: o.autoLand === true, continueOnFail: o.continueOnFail === true, status: 'waiting', note: '' }
    this.items.push(it)
    this.save()
    return { ...it }
  }

  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id)
    if (i < 0 || this.items[i].status === 'running') return false // the run has to be stopped first
    this.items.splice(i, 1)
    this.save()
    return true
  }

  move(id: string, to: number): boolean {
    const i = this.items.findIndex((x) => x.id === id)
    if (i < 0) return false
    const [it] = this.items.splice(i, 1)
    this.items.splice(Math.max(0, Math.min(this.items.length, Math.floor(to))), 0, it)
    this.save()
    return true
  }

  start() {
    this.on = true
    for (const it of this.items) if (it.status === 'running') this.reconcile(it)
    void this.pump()
  }
  resume() {
    this.start()
  }
  // The run in progress carries on; the next item is not started.
  pause() {
    this.on = false
  }

  // ------------------------------------------------------------------ running

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.on && !this.items.some((i) => i.status === 'running')) {
        const it = this.items.find((i) => i.status === 'waiting')
        if (!it) {
          this.on = false
          this.d.notify?.('finished')
          return
        }
        it.status = 'running'
        it.startedAt = Date.now()
        it.endedAt = undefined
        it.note = ''
        this.save()
        try {
          it.runId = (await this.d.start(it.project, it.goal, it.config, it.attachments)).id
          this.save()
          await this.check(it) // a run that is already past planning (or over) when start returns
        } catch (e) {
          this.finish(it, 'failed', `Could not start: ${(e as Error).message.slice(0, 300)}`)
          this.afterFailure(it)
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private finish(it: QueueItem, status: QueueStatus, note: string) {
    it.status = status
    it.note = note
    it.endedAt = Date.now()
    this.save()
  }
  private needsYou() {
    this.on = false
    this.d.notify?.('attention')
  }
  private afterFailure(it: QueueItem) {
    if (it.continueOnFail) void this.pump()
    else this.needsYou()
  }

  // Acts on where the item's run is now.
  private async check(it: QueueItem) {
    if ((it.status !== 'running' && it.status !== 'ready') || !it.runId || this.settling.has(it.id)) return
    const run = this.d.getRun(it.runId)
    this.settling.add(it.id)
    try {
      if (!run) {
        this.finish(it, 'failed', 'The run no longer exists.')
        return this.afterFailure(it)
      }
      if (run.status === 'done') {
        const was = it.status
        this.finish(it, run.applied ? 'landed' : 'skipped', run.applied ? (was === 'ready' ? 'You landed it.' : 'Landed.') : 'The result was not applied.')
        return void this.pump()
      }
      if (run.status === 'failed' || run.status === 'cancelled') {
        if (it.status === 'ready') return
        this.finish(it, 'failed', run.pausedReason?.slice(0, 300) || `The run ${run.status}.`)
        return this.afterFailure(it)
      }
      if (run.status !== 'awaiting_approval' || it.status !== 'running') return
      const why = holdBack(run)
      if (it.autoLand && !why) {
        const r = await this.d.land(run.id).catch((e: Error) => ({ ok: false, message: e.message }))
        if (r.ok) {
          this.finish(it, 'landed', r.message.slice(0, 300))
          return void this.pump()
        }
        this.finish(it, 'ready', `Could not land it by itself: ${r.message.slice(0, 300)}`)
      } else this.finish(it, 'ready', why ?? 'Ready for your review. Landing automatically was off for this item.')
      this.needsYou()
    } finally {
      this.settling.delete(it.id)
    }
  }

  private reconcile(it: QueueItem) {
    const run = it.runId ? this.d.getRun(it.runId) : null
    if (!it.runId) this.finish(it, 'failed', 'Forge was closed while this goal was starting.')
    else if (run && ['planning', 'running', 'verifying', 'paused', 'interrupted'].includes(run.status)) {
      it.note = run.status === 'interrupted' || run.status === 'paused' ? 'The run stopped. Resume it from its Crew screen, then start the queue again.' : it.note
      this.save()
    } else void this.check(it)
  }

  // ------------------------------------------------------------------ the morning report

  morningReport(): string {
    const count = (s: QueueStatus) => this.items.filter((i) => i.status === s).length
    const out = [`# Crew queue report`, '', `${this.items.length} goal${this.items.length === 1 ? '' : 's'}: ${count('landed')} landed, ${count('ready')} waiting for you, ${count('failed')} failed, ${count('skipped')} skipped, ${count('running')} running, ${count('waiting')} not started.`]
    this.items.forEach((it, n) => {
      const run = it.runId ? this.d.getRun(it.runId) : null
      const f = run?.final
      const title = it.goal.split('\n')[0].slice(0, 100)
      out.push('', `## ${n + 1}. ${title}`, '', `- Status: ${LABEL[it.status]}`, `- Project: ${basename(it.project)}`)
      if (f) {
        const add = f.files.reduce((a, x) => a + x.added, 0)
        const del = f.files.reduce((a, x) => a + x.removed, 0)
        out.push(`- Files changed: ${f.files.length} (+${add} -${del})${f.files.length ? `: ${f.files.slice(0, 8).map((x) => x.path).join(', ')}${f.files.length > 8 ? ', ...' : ''}` : ''}`)
        out.push(`- Check: ${f.verifyOk === null ? 'none ran' : f.verifyOk ? 'passed' : 'FAILED'}`)
        out.push(`- Review: ${f.reviewNotes.length ? f.reviewNotes.map((x) => x.replace(/\s+/g, ' ')).join(' | ') : 'none'}`)
      }
      if (run) out.push(`- Cost: ${money(run)}`)
      if (it.startedAt) out.push(`- Time: ${span((it.endedAt ?? Date.now()) - it.startedAt)}`)
      const need = it.status === 'ready' ? it.note || 'Review and land the result.' : it.status === 'failed' ? it.note || 'It failed.' : it.status === 'running' ? it.note || 'Still running.' : ''
      if (need) out.push(`- Needs you: ${need}`)
      else if (it.note) out.push(`- Note: ${it.note}`)
    })
    return out.join('\n') + '\n'
  }

  // ------------------------------------------------------------------ storage

  private save() {
    try {
      mkdirSync(dirname(this.d.file), { recursive: true })
      const tmp = this.d.file + '.tmp'
      writeFileSync(tmp, JSON.stringify({ v: 1, items: this.items }, null, 1))
      renameSync(tmp, this.d.file) // a crash mid-write cannot leave half a queue
    } catch {}
  }

  // A missing or unreadable file is an empty queue; a corrupt one is kept beside it so nothing is lost silently.
  private load(): QueueItem[] {
    let raw: string
    try {
      raw = readFileSync(this.d.file, 'utf8')
    } catch {
      return []
    }
    try {
      const j = JSON.parse(raw)
      const list: unknown[] = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : []
      return list.flatMap((x): QueueItem[] => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
        if (typeof o.id !== 'string' || typeof o.goal !== 'string' || typeof o.project !== 'string') return []
        const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
        return [{
          id: o.id, project: o.project, goal: o.goal, config: o.config && typeof o.config === 'object' ? (o.config as Partial<TeamConfig>) : {}, attachments: o.attachments,
          autoLand: o.autoLand === true, continueOnFail: o.continueOnFail === true, status: STATUSES.includes(o.status as QueueStatus) ? (o.status as QueueStatus) : 'waiting',
          runId: typeof o.runId === 'string' ? o.runId : undefined, startedAt: num(o.startedAt), endedAt: num(o.endedAt), note: typeof o.note === 'string' ? o.note : '',
        }]
      })
    } catch {
      try { renameSync(this.d.file, this.d.file + '.corrupt') } catch {}
      return []
    }
  }
}

const LABEL: Record<QueueStatus, string> = { waiting: 'Not started', running: 'Running', landed: 'Landed', ready: 'Ready for your review', failed: 'Failed', skipped: 'Not applied' }
const money = (run: Run) => `$${Object.values(run.usage).reduce((a, u) => a + (u?.costUsd ?? 0), 0).toFixed(2)}`
const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}
