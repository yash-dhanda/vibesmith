import { ipcMain, nativeImage } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RULES_BYTES, readRules, writeRules } from './projectRules'
import { addReference, getAutoAttach, listReferences, referencePath, removeReference, setAutoAttach, setReferenceNote, type NewReference, type Reference } from './references'
import { detectTranscriber, findProgram, loadVoice, MAX_AUDIO, NO_TRANSCRIBER, saveVoice, transcribe, transcriberArgs, type VoiceSettings } from './transcribe'
import type { Forecast, TaskStat } from './team/forecast'
import type { Run } from './team/types'

// IPC for the project's rules file, its reference library, voice prompts and the Crew run's cost and time table. The project is always the
// folder of the window that asks (rootOf), never a path sent by the renderer.
export type KnowledgeDeps = {
  rootOf: (e: unknown) => string | null
  userData: string
  briefRules: (project: string) => string // the older rules field of the project brief, shown until a rules file exists
  getRun: (id: string) => Run | null
  stats: (id: string) => { tasks: TaskStat[]; forecast: Forecast } | null
}
export type RulesState = { text: string; saved: boolean; fromBrief: boolean; maxBytes: number }
export type ReferencesState = { items: Reference[]; autoAttach: boolean }
export type VoiceStatus = { available: boolean; command: string | null; model: string; language: string; hint: string }
export type CrewStats = { tasks: (TaskStat & { title: string; status: string })[]; forecast: Forecast; active: boolean }

export function registerProjectKnowledge(d: KnowledgeDeps) {
  const project = (e: unknown) => d.rootOf(e) ?? (() => { throw new Error('Choose a project folder first.') })()
  const voiceFile = () => join(d.userData, 'voice.json')

  ipcMain.handle('rules:get', (e): RulesState => {
    const p = project(e)
    const file = readRules(p)
    const legacy = d.briefRules(p)
    return { text: file ?? legacy, saved: file !== null, fromBrief: file === null && !!legacy, maxBytes: MAX_RULES_BYTES }
  })
  ipcMain.handle('rules:set', (e, text: unknown) => writeRules(project(e), text))

  ipcMain.handle('references:list', (e): ReferencesState => { const p = project(e); return { items: listReferences(p), autoAttach: getAutoAttach(p) } })
  ipcMain.handle('references:add', (e, item: NewReference) => addReference(project(e), item))
  ipcMain.handle('references:remove', (e, id: unknown) => removeReference(project(e), String(id)))
  ipcMain.handle('references:note', (e, id: unknown, note: unknown) => setReferenceNote(project(e), String(id), note))
  ipcMain.handle('references:auto', (e, on: unknown) => setAutoAttach(project(e), on === true))
  // A small picture for the grid, so the window never loads a 25 MB screenshot to draw a thumbnail.
  ipcMain.handle('references:thumb', (e, id: unknown) => {
    const path = referencePath(project(e), String(id))
    const img = path ? nativeImage.createFromPath(path) : null
    if (!img || img.isEmpty()) return null
    return (img.getSize().width > 240 ? img.resize({ width: 240 }) : img).toDataURL()
  })

  const voiceSettings = (): VoiceSettings => loadVoice(voiceFile())
  ipcMain.handle('voice:status', (): VoiceStatus => {
    const s = voiceSettings()
    const command = s.command ? findProgram(s.command) : (detectTranscriber()?.command ?? null)
    let hint = ''
    if (!command) hint = s.command ? `Forge cannot run "${s.command}" any more. Check the voice settings.` : NO_TRANSCRIBER
    else if (!findProgram('ffmpeg')) hint = 'Voice prompts need ffmpeg. Install it and try again.'
    else { try { transcriberArgs(command, 'x.wav', s) } catch (err) { hint = (err as Error).message } }
    return { available: !hint, command, model: s.model ?? '', language: s.language, hint }
  })
  ipcMain.handle('voice:set', (_e, o: { command?: unknown; model?: unknown; language?: unknown }) => { saveVoice(voiceFile(), o ?? {}) })
  let busy = false
  // The recording arrives as bytes (the computer's window) or base64 text (the phone link, which carries JSON).
  ipcMain.handle('voice:transcribe', async (_e, data: unknown): Promise<string> => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'base64') : data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null
    if (!buf?.length) throw new Error('Nothing was recorded.')
    if (buf.length > MAX_AUDIO) throw new Error('That recording is too long. Keep it under two minutes.')
    if (busy) throw new Error('Forge is still turning the last recording into text.')
    busy = true
    const dir = mkdtempSync(join(tmpdir(), 'forge-voice-'))
    try {
      const file = join(dir, 'recording.webm')
      writeFileSync(file, buf)
      return await transcribe(file, { settings: voiceSettings() })
    } finally {
      busy = false
      rmSync(dir, { recursive: true, force: true })
    }
  })

  ipcMain.handle('team:stats', (_e, id: unknown): CrewStats | null => {
    if (typeof id !== 'string' || !/^[\w-]{1,60}$/.test(id)) throw new Error('bad id')
    const s = d.stats(id)
    const run = d.getRun(id)
    if (!s || !run) return null
    const task = new Map(run.tasks.map((t) => [t.id, t]))
    return { tasks: s.tasks.map((t) => ({ ...t, title: task.get(t.id)?.title ?? t.id, status: task.get(t.id)?.status ?? 'queued' })), forecast: s.forecast, active: !['done', 'failed', 'cancelled'].includes(run.status) }
  })
}
