import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanText, detectTranscriber, findProgram, loadVoice, MAX_AUDIO, NO_TRANSCRIBER, saveVoice, transcribe, transcriberArgs, type RunResult, type Runner } from './transcribe'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const program = (dir: string, name: string) => { const f = join(dir, name); writeFileSync(f, '#!/bin/sh\n'); chmodSync(f, 0o755); return f }
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const audio = () => { const f = join(tmp('aud-'), 'rec.webm'); writeFileSync(f, 'x'); return f }

describe('voice settings and detection', () => {
  it('finds a known program on PATH in the order of the list', () => {
    const bin = tmp('bin-')
    expect(detectTranscriber(bin)).toBeNull()
    program(bin, 'whisper')
    const cli = program(bin, 'whisper-cli')
    expect(detectTranscriber(bin)).toEqual({ command: cli, name: 'whisper-cli' })
    expect(findProgram('nope', bin)).toBeNull()
    expect(findProgram('../x', bin)).toBeNull() // a relative path is not a program
  })

  it('saves valid settings and refuses programs that are missing or look like options', () => {
    const file = join(tmp('voice-'), 'voice.json')
    expect(loadVoice(file)).toEqual({ language: 'auto' })
    const bin = tmp('bin-')
    const cmd = program(bin, 'whisper-cli')
    expect(saveVoice(file, { command: cmd, model: '/models/base.bin', language: 'en' })).toEqual({ command: cmd, model: '/models/base.bin', language: 'en' })
    expect(loadVoice(file).language).toBe('en')
    expect(() => saveVoice(file, { command: '/no/such/program' })).toThrow(/cannot run/)
    expect(() => saveVoice(file, { command: 'whisper-cli; rm -rf ~' })).toThrow()
    expect(() => saveVoice(file, { model: '--output-dir' })).toThrow()
    expect(() => saveVoice(file, { language: 'English' })).toThrow()
    expect(saveVoice(file, { command: '' }).command).toBeUndefined()
  })

  it('builds argument lists per program family', () => {
    expect(transcriberArgs('/x/whisper-cli', '/t/a.wav', { model: 'm.bin', language: 'auto' })).toEqual(['-m', 'm.bin', '-f', '/t/a.wav', '-nt', '-np', '-l', 'auto'])
    expect(() => transcriberArgs('/x/whisper-cli', '/t/a.wav', { language: 'auto' })).toThrow(/model/)
    expect(transcriberArgs('/x/whisper', '/t/a.wav', { language: 'hi' })).toEqual(['/t/a.wav', '--model', 'base', '--language', 'hi'])
    expect(transcriberArgs('/x/mine.sh', '/t/a.wav', { language: 'en' })).toEqual(['/t/a.wav'])
    expect(cleanText('[00:00.000 --> 00:02.000]  hello there\n\n[00:02.000 --> 00:03.500] general\n')).toBe('hello there general')
  })
})

describe('transcribe', () => {
  it('converts with ffmpeg, runs the program with an argument list and returns trimmed text', async () => {
    const bin = tmp('bin-')
    const cmd = program(bin, 'whisper-cli')
    const calls: { cmd: string; args: string[]; ms: number }[] = []
    const run: Runner = async (c, args, ms) => { calls.push({ cmd: c, args, ms }); return ok(c === 'ffmpeg' ? '' : ' [00:00.000 --> 00:01.000]  add a login page \n') }
    const text = await transcribe(audio(), { settings: { language: 'auto', model: 'm.bin' }, run, detect: () => ({ command: cmd, name: 'whisper-cli' }) })
    expect(text).toBe('add a login page')
    expect(calls[0].args.slice(-5, -1)).toEqual(['-ar', '16000', '-ac', '1'])
    expect(calls[0].ms).toBe(30_000)
    expect(calls[1]).toMatchObject({ cmd, ms: 120_000 })
    expect(calls[1].args).toContain('-nt')
    expect(existsSync(calls[0].args.at(-1)!)).toBe(false) // the WAV is gone
  })

  it('explains each failure in words and cleans up', async () => {
    const cmd = program(tmp('bin-'), 'whisper-cli')
    const detect = () => ({ command: cmd, name: 'whisper-cli' })
    const settings = { language: 'auto', model: 'm.bin' }
    await expect(transcribe(audio(), { settings, run: async () => ok(), detect: () => null })).rejects.toThrow(NO_TRANSCRIBER)
    await expect(transcribe(audio(), { settings: { language: 'auto', command: '/gone/prog' }, run: async () => ok() })).rejects.toThrow(/cannot run/)
    await expect(transcribe(audio(), { settings, detect, run: async () => ({ ...ok(), code: null, missing: true }) })).rejects.toThrow(/ffmpeg is not installed/)
    await expect(transcribe(audio(), { settings, detect, run: async (c) => (c === 'ffmpeg' ? { ...ok(), code: 1, stderr: 'bad data\n' } : ok()) })).rejects.toThrow(/bad data/)
    await expect(transcribe(audio(), { settings, detect, run: async (c) => (c === 'ffmpeg' ? ok() : { ...ok(), code: null, timedOut: true }) })).rejects.toThrow(/longer than two minutes/)
    await expect(transcribe(audio(), { settings, detect, run: async (c) => (c === 'ffmpeg' ? ok() : { ...ok(), code: 2, stderr: 'model not found\n' }) })).rejects.toThrow(/model not found/)
    await expect(transcribe(audio(), { settings, detect, run: async () => ok('  \n') })).rejects.toThrow(/No speech/)
  })

  it('refuses a recording over 50 MB without running anything', async () => {
    const f = join(tmp('big-'), 'big.webm')
    writeFileSync(f, Buffer.alloc(MAX_AUDIO + 1))
    let ran = false
    await expect(transcribe(f, { settings: { language: 'auto' }, run: async () => ((ran = true), ok()), detect: () => null })).rejects.toThrow(/too long/)
    expect(ran).toBe(false)
  })
})
