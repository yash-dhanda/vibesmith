import { readBase64 } from './attachments'
import { hasIcon, icon, type IconName } from './icons'
import { toolDialog } from './rulesPanel'
import { cleanErr, h, toast } from './ui'

const wanted: string = 'mic'
const MIC: IconName = hasIcon(wanted) ? wanted : 'bell' // the real glyph once the icon set has 'mic'
const MAX_SECONDS = 120
const MIN_SECONDS = 0.6

type Status = Awaited<ReturnType<typeof window.forge.voiceStatus>>
let cached: { at: number; value: Promise<Status> } | null = null
// One question to the main process serves every microphone button on screen.
const status = (fresh = false): Promise<Status> => {
  if (fresh || !cached || Date.now() - cached.at > 10_000) cached = { at: Date.now(), value: window.forge.voiceStatus() }
  return cached.value
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// A small dialog for a computer with no speech-to-text program: the steps, and where to tell Forge about one.
async function openHowTo(st: Status, onSaved: () => void) {
  const { dlg, head, close } = toolDialog('voice-howto', 'Voice prompts', MIC)
  const body = h('div', 'voice-howto')
  body.append(h('p', 'tool-intro', 'Forge turns your voice into text with a program on this computer. Nothing is sent anywhere.'), h('pre', 'voice-steps', st.hint || 'Voice prompts are ready.'))
  const field = (label: string, value: string, placeholder: string) => {
    const l = h('label', 'voice-field')
    const i = document.createElement('input')
    i.type = 'text'
    i.value = value
    i.placeholder = placeholder
    i.spellcheck = false
    l.append(h('span', '', label), i)
    return { l, i }
  }
  const program = field('Program', st.command ?? '', '/path/to/whisper-cli')
  const model = field('Model', st.model, '/path/to/ggml-base.en.bin')
  const save = h('button', 'btn primary', 'Save') as HTMLButtonElement
  save.type = 'button'
  save.onclick = async () => {
    save.disabled = true
    try {
      await window.forge.voiceSet({ command: program.i.value.trim(), model: model.i.value.trim() })
      const now = await status(true)
      onSaved()
      if (now.available) { dlg.close(); toast('Voice prompts are ready. Click the microphone to speak.') } else { body.querySelector('pre')!.textContent = now.hint }
    } catch (e) { toast(cleanErr(e), 6000) } finally { save.disabled = false }
  }
  const foot = h('div', 'modal-foot')
  foot.append(h('span', 'modal-hint', 'The program gets a 16 kHz WAV and must print the text.'), h('span', 'grow'), save)
  body.append(program.l, model.l)
  dlg.replaceChildren(head, body, foot)
  if (!dlg.open) dlg.showModal()
  close.focus()
}

// A microphone button for a prompt box. Click to start, click to stop; the words are inserted where the caret is.
// The microphone is asked for only the first time it is used. Recording stops by itself after two minutes.
export function attachVoice(textarea: HTMLTextAreaElement, container: HTMLElement): HTMLButtonElement {
  const btn = h('button', 'icon-btn voice-btn') as HTMLButtonElement
  btn.type = 'button'
  const ring = h('span', 'voice-ring')
  const time = h('span', 'voice-time')
  btn.append(ring, icon(MIC), time)
  container.append(btn)

  let state: 'idle' | 'unavailable' | 'recording' | 'transcribing' = 'idle'
  let st: Status | null = null
  const label = (text: string) => { btn.title = text; btn.setAttribute('aria-label', text.split('\n')[0]) }
  const paint = () => {
    btn.classList.toggle('recording', state === 'recording')
    btn.classList.toggle('busy', state === 'transcribing')
    btn.classList.toggle('off', state === 'unavailable')
    btn.setAttribute('aria-pressed', String(state === 'recording'))
    time.hidden = state !== 'recording'
    if (state === 'idle') label('Speak your prompt (click to start, click again to stop)')
    if (state === 'recording') label('Stop recording')
    if (state === 'transcribing') label('Turning your voice into text…')
    if (state === 'unavailable') label(`Voice prompts are not set up. ${(st?.hint ?? '').split('\n')[0]} Click for steps.`)
  }
  const refresh = async (fresh = false) => {
    if (typeof window.forge.voiceStatus !== 'function') { btn.hidden = true; return }
    try { st = await status(fresh) } catch { st = null }
    if (!navigator.mediaDevices?.getUserMedia) st = { available: false, command: null, model: '', language: 'auto', hint: 'This page cannot use the microphone. Dictate on the computer.' }
    if (state === 'idle' || state === 'unavailable') state = st?.available ? 'idle' : 'unavailable'
    paint()
  }

  let stream: MediaStream | null = null
  let rec: MediaRecorder | null = null
  let ctx: AudioContext | null = null
  let tick = 0
  let frame = 0
  let started = 0
  let caret = 0

  function teardown() {
    clearInterval(tick)
    cancelAnimationFrame(frame)
    stream?.getTracks().forEach((t) => t.stop())
    void ctx?.close().catch(() => {})
    stream = ctx = null
    btn.style.removeProperty('--lvl')
  }

  async function start() {
    state = 'transcribing' // blocks a second click while the permission question is open
    paint()
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      state = 'idle'
      paint()
      toast((e as DOMException).name === 'NotAllowedError' ? 'The microphone is blocked. Allow it for Forge in your system settings, then try again.' : 'No microphone was found.', 6000)
      return
    }
    const chunks: Blob[] = []
    rec = new MediaRecorder(stream)
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    const type = rec.mimeType || 'audio/webm'
    rec.onstop = () => void finish(new Blob(chunks, { type }))
    // a level meter drives the ring; with reduced motion only the clock shows
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      try {
        ctx = new AudioContext()
        const an = ctx.createAnalyser()
        an.fftSize = 256
        ctx.createMediaStreamSource(stream).connect(an)
        const buf = new Uint8Array(an.fftSize)
        const loop = () => {
          an.getByteTimeDomainData(buf)
          let peak = 0
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
          btn.style.setProperty('--lvl', String(Math.min(1, peak / 64)))
          frame = requestAnimationFrame(loop)
        }
        loop()
      } catch {}
    }
    caret = textarea.selectionEnd ?? textarea.value.length
    started = Date.now()
    state = 'recording'
    time.textContent = clock(0)
    paint()
    rec.start()
    tick = window.setInterval(() => {
      const s = (Date.now() - started) / 1000
      time.textContent = clock(s)
      if (!btn.isConnected) cancel()
      else if (s >= MAX_SECONDS) stop()
    }, 250)
  }

  function stop() {
    if (state !== 'recording') return
    state = 'transcribing'
    paint()
    caret = textarea.selectionEnd ?? caret
    const r = rec!
    rec = null
    teardown()
    r.stop() // its onstop hands the recording to finish()
  }

  // The prompt box left the screen while recording: drop the recording.
  function cancel() {
    const r = rec
    rec = null
    if (r) r.onstop = null
    if (r?.state === 'recording') r.stop()
    teardown()
    state = 'idle'
  }

  async function finish(blob: Blob) {
    try {
      if ((Date.now() - started) / 1000 < MIN_SECONDS || !blob.size) throw new Error('That was too short to hear. Hold on a little longer.')
      const text = (await window.forge.voiceTranscribe(await readBase64(blob, () => {}))).trim()
      if (text) {
        const at = Math.min(caret, textarea.value.length)
        const before = textarea.value.slice(0, at)
        textarea.setRangeText(`${before && !/\s$/.test(before) ? ' ' : ''}${text}`, at, at, 'end')
        textarea.dispatchEvent(new Event('input', { bubbles: true })) // so the composer resizes and Send enables
      }
      textarea.focus()
    } catch (e) {
      toast(cleanErr(e), 6000)
    } finally {
      state = 'idle'
      void refresh() // the program may have been removed meanwhile
    }
  }

  btn.onclick = () => {
    if (state === 'unavailable') void openHowTo(st!, () => void refresh(true))
    else if (state === 'idle') void start()
    else if (state === 'recording') stop()
  }
  paint()
  void refresh()
  return btn
}
