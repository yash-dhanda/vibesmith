import { execFile } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { atomicWrite } from './projectRules'

// Speech to text with a program already on this computer; Forge ships none. The recording is turned into a 16 kHz mono WAV with ffmpeg,
// then the program is run with an argument list (never a shell string) and its printed text is the result. The program comes only from
// the saved settings or from a search of PATH, never from the recording or a message.

export type VoiceSettings = { command?: string; model?: string; language: string }
export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; missing?: boolean }
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>
export type Transcriber = { command: string; name: string }

export const MAX_AUDIO = 50 * 1024 * 1024
export const KNOWN = ['whisper-cli', 'whisper-cpp', 'whisper', 'faster-whisper', 'faster-whisper-cli']
const EXTS = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']

export const NO_TRANSCRIBER = [
  'No speech-to-text program found. Install one, then try again:',
  '1. whisper.cpp',
  '   git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp',
  '   cmake -B build && cmake --build build -j --config Release',
  '   sh ./models/download-ggml-model.sh base.en',
  '   Then enter build/bin/whisper-cli and models/ggml-base.en.bin (full paths) in the voice settings.',
  '2. OpenAI Whisper',
  '   pipx install openai-whisper',
  'Both also need ffmpeg.',
].join('\n')

export const runner: Runner = (cmd, args, timeoutMs) =>
  new Promise((res) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (e, stdout, stderr) => {
      const err = e as (Error & { code?: number | string; killed?: boolean }) | null
      res({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: !!err?.killed, missing: err?.code === 'ENOENT' })
    })
  })

const executable = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile() } catch { return false } }

// An absolute path to a program, or a bare name found on PATH; null when there is no such program.
export function findProgram(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  if (typeof name !== 'string' || !name || name.length > 300 || /[\0\r\n]/.test(name)) return null
  if (/[\\/]/.test(name)) return isAbsolute(name) && executable(name) ? name : null
  for (const dir of pathEnv.split(delimiter)) for (const ext of EXTS) if (dir && executable(join(dir, name + ext))) return join(dir, name + ext)
  return null
}

export function detectTranscriber(pathEnv = process.env.PATH ?? ''): Transcriber | null {
  for (const name of KNOWN) { const command = findProgram(name, pathEnv); if (command) return { command, name } }
  return null
}

const family = (command: string) => (command.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat)$/i, '')
const isCpp = (f: string) => f === 'whisper-cli' || f === 'whisper-cpp'

// whisper.cpp needs a model file; the others take a model name. A program Forge does not know gets just the WAV path and must print the text.
// ponytail: flags for the faster-whisper CLIs are a best guess (their packages differ); point the setting at a small wrapper script if yours differs.
export function transcriberArgs(command: string, wav: string, s: Pick<VoiceSettings, 'model' | 'language'>): string[] {
  const f = family(command)
  const lang = s.language && s.language !== 'auto' ? s.language : ''
  if (isCpp(f)) {
    if (!s.model) throw new Error('whisper.cpp needs a model file. Set the model path in the voice settings (for example models/ggml-base.en.bin).')
    return ['-m', s.model, '-f', wav, '-nt', '-np', '-l', lang || 'auto']
  }
  if (f === 'whisper' || f.startsWith('faster-whisper')) return [wav, '--model', s.model || 'base', ...(lang ? ['--language', lang] : [])]
  return [wav]
}

// Plain text from what the program printed: whisper's "[00:00.000 --> 00:02.000]" prefixes and blank lines go.
export const cleanText = (out: string) => out.split('\n').map((l) => l.replace(/^\s*\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()

export function loadVoice(file: string): VoiceSettings {
  let v: Partial<VoiceSettings> = {}
  try { v = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  return { language: 'auto', ...(typeof v.command === 'string' ? { command: v.command } : {}), ...(typeof v.model === 'string' ? { model: v.model } : {}), ...(typeof v.language === 'string' && /^(auto|[a-z]{2,3})$/.test(v.language) ? { language: v.language } : {}) }
}

// Checked before anything is saved: the program must exist, and nothing may start with "-" (it would be read as an option).
export function saveVoice(file: string, patch: { command?: unknown; model?: unknown; language?: unknown }): VoiceSettings {
  const cur = loadVoice(file)
  const next: VoiceSettings = { ...cur }
  const str = (v: unknown, what: string) => { if (typeof v !== 'string' || v.length > 300 || /[\0\r\n]/.test(v) || v.trim().startsWith('-')) throw new Error(`That ${what} is not valid.`); return v.trim() }
  if (patch.command !== undefined) {
    const c = patch.command === '' || patch.command === null ? '' : str(patch.command, 'program')
    if (c && !findProgram(c)) throw new Error(`Forge cannot run "${c}". Give the full path to the program, or a name that is on your PATH.`)
    if (c) next.command = c; else delete next.command
  }
  if (patch.model !== undefined) { const m = patch.model === '' || patch.model === null ? '' : str(patch.model, 'model'); if (m) next.model = m; else delete next.model }
  if (patch.language !== undefined) { if (typeof patch.language !== 'string' || !/^(auto|[a-z]{2,3})$/.test(patch.language)) throw new Error('The language must be "auto" or a code such as "en".'); next.language = patch.language }
  atomicWrite(file, JSON.stringify(next, null, 2))
  return next
}

export type TranscribeDeps = { settings: VoiceSettings; run?: Runner; detect?: () => Transcriber | null; ffmpeg?: string }

export async function transcribe(audioPath: string, d: TranscribeDeps): Promise<string> {
  const run = d.run ?? runner
  if (statSync(audioPath).size > MAX_AUDIO) throw new Error('That recording is too long. Keep it under two minutes.')
  const command = d.settings.command ? findProgram(d.settings.command) : (d.detect ?? detectTranscriber)()?.command
  if (!command) throw new Error(d.settings.command ? `Forge cannot run "${d.settings.command}" any more. Check the voice settings.` : NO_TRANSCRIBER)
  const dir = mkdtempSync(join(tmpdir(), 'forge-wav-'))
  try {
    const wav = join(dir, 'speech.wav')
    const conv = await run(d.ffmpeg ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', wav], 30_000)
    if (conv.missing) throw new Error('ffmpeg is not installed, and Forge needs it to prepare the recording. Install ffmpeg and try again.')
    if (conv.timedOut) throw new Error('Preparing the recording took too long.')
    if (conv.code !== 0) throw new Error(`Could not read the recording: ${conv.stderr.trim().split('\n').pop() || 'ffmpeg failed'}`)
    const r = await run(command, transcriberArgs(command, wav, d.settings), 120_000)
    if (r.timedOut) throw new Error('Speech to text took longer than two minutes and was stopped.')
    if (r.code !== 0) throw new Error(`The speech-to-text program failed: ${r.stderr.trim().split('\n').pop() || `exit code ${r.code}`}`)
    const text = cleanText(r.stdout)
    if (!text) throw new Error('No speech was heard. Try again, closer to the microphone.')
    return text
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
