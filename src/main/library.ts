import { readFileSync, writeFileSync } from 'node:fs'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { rank } from './catalog'
import { Engine } from './engine'
import { searchHF } from './hf'
import { patientFetch } from './net'
import { ollamaStatus, runsOnCpu } from './ollama'
import { PullTracker } from './pull'
import { systemInfo, type SystemInfo } from './system'
import { getHost, isRemote, normalizeHost, remoteVramGB, setHost } from './ollamaHost'

// Model names go to the local engine only, but they still come from the screen: keep to what a model name can contain.
const NAME = /^[\w][\w.\-/:@]{0,199}$/
const checkName = (n: string) => {
  if (!NAME.test(n)) throw new Error(`"${n}" is not a valid model name.`)
  return n
}

export function registerLibrary(getWin: () => BrowserWindow | null) {
  const data = app.getPath('userData')
  const engine = new Engine(join(data, 'engine'), join(data, 'models'))
  const send = (channel: string, payload?: unknown) => getWin()?.webContents.send(channel, payload)
  let installing: AbortController | null = null
  const pulls = new Map<string, AbortController>()
  let sys: SystemInfo | null = null
  const system = async () => (sys = await systemInfo(data))

  ipcMain.handle('engine:status', async () => {
    const st = await engine.status()
    // Pointed at another computer that does not answer: never offer to install here, say what is wrong.
    const state = isRemote() && !st.state.startsWith('ready') ? ('remote-down' as const) : st.state
    return { ...st, state, installing: !!installing, remote: isRemote(), host: getHost(), cpuOnly: runsOnCpu(await ollamaStatus(engine.host)) }
  })

  // The engine on another computer (for example the desktop with the big card). Remembered between runs.
  const hostFile = join(data, 'engine-host.json')
  try {
    const saved = JSON.parse(readFileSync(hostFile, 'utf8')) as { host?: string; vramGB?: number }
    setHost(saved.host ?? '', saved.vramGB)
  } catch {
    /* none saved: this computer */
  }
  ipcMain.handle('engine:host-get', () => ({ host: isRemote() ? getHost() : '', vramGB: remoteVramGB() }))
  ipcMain.handle('engine:host-test', async (_e, input: string) => {
    const host = normalizeHost(String(input ?? ''))
    const st = await ollamaStatus(host)
    return { ok: st.up, host, models: st.models.length }
  })
  ipcMain.handle('engine:host-set', async (_e, input: string, vramGB?: number) => {
    const host = setHost(String(input ?? ''), typeof vramGB === 'number' ? vramGB : undefined)
    writeFileSync(hostFile, JSON.stringify({ host: isRemote() ? host : '', vramGB: remoteVramGB() }))
    send('engine:changed')
    send('models:changed')
  })
  ipcMain.handle('engine:install', async () => {
    if (isRemote()) throw new Error('Forge is using an AI engine on another computer, so there is nothing to install here.')
    if (installing) throw new Error('The engine is already being installed.')
    installing = new AbortController()
    try {
      await engine.install((p) => send('engine:progress', p), installing.signal)
      send('engine:progress', { phase: 'start', done: 0, total: 1 })
      await engine.start()
    } finally {
      installing = null
      send('engine:changed')
    }
  })
  ipcMain.on('engine:cancel', () => installing?.abort())
  ipcMain.handle('engine:start', async () => {
    if (isRemote()) throw new Error('The engine runs on another computer. Start it there.')
    await engine.start()
    send('engine:changed')
  })

  ipcMain.handle('system:info', () => system())

  ipcMain.handle('models:catalog', async () => {
    const [s, st] = await Promise.all([sys ?? system(), ollamaStatus(engine.host)])
    const have = new Set(st.models.flatMap((m) => [m, m.replace(/:latest$/, '')]))
    // A remote engine's card is not ours: rate models against the memory the user gave for it.
    const target = isRemote() ? { ...s, gpu: { name: 'Remote GPU', vramGB: remoteVramGB(), freeGB: remoteVramGB() } } : s
    return rank(target).map((m) => ({ ...m, installed: have.has(m.id) }))
  })

  ipcMain.handle('models:installed', async () => {
    try {
      const j = (await (await patientFetch(`${engine.host}/api/tags`, { signal: AbortSignal.timeout(4000) })).json()) as {
        models?: { name: string; size: number; modified_at: string; details?: { parameter_size?: string; quantization_level?: string; family?: string } }[]
      }
      const st = await ollamaStatus(engine.host)
      return (j.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size,
        modified: m.modified_at,
        params: m.details?.parameter_size ?? '',
        quant: m.details?.quantization_level ?? '',
        loaded: st.loaded.some((l) => l.name === m.name),
      }))
    } catch {
      return []
    }
  })

  ipcMain.handle('models:pull', async (_e, rawName: string) => {
    const name = checkName(rawName)
    if (pulls.has(name)) throw new Error(`${name} is already downloading.`)
    const ctl = new AbortController()
    pulls.set(name, ctl)
    try {
      let res: Response
      try {
        res = await patientFetch(`${engine.host}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal: ctl.signal })
      } catch (e) {
        if (ctl.signal.aborted) throw e
        throw new Error('The AI engine is not running. Start it from the model library first.')
      }
      if (!res.ok) throw new Error(`The engine refused the download (${res.status}): ${(await res.text()).slice(0, 160)}`)
      const tracker = new PullTracker()
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const p = tracker.update(line)
          if (!p) continue
          send('models:progress', { name, ...p })
          if (p.error) throw new Error(p.error)
        }
      }
      send('models:changed')
    } catch (e) {
      if (ctl.signal.aborted) send('models:progress', { name, status: 'cancelled', completed: 0, total: 0, percent: 0, bytesPerSec: 0, done: true, cancelled: true })
      else throw e
    } finally {
      pulls.delete(name)
    }
  })
  ipcMain.on('models:cancel', (_e, name: string) => pulls.get(name)?.abort())

  ipcMain.handle('models:delete', async (_e, rawName: string) => {
    const name = checkName(rawName)
    const res = await patientFetch(`${engine.host}/api/delete`, { method: 'DELETE', body: JSON.stringify({ model: name }) })
    if (!res.ok) throw new Error(`Could not delete ${name} (${res.status}).`)
    send('models:changed')
  })

  ipcMain.handle('models:search', (_e, q: string) => searchHF(String(q).slice(0, 100)))

  return {
    // At launch: a Forge-managed engine starts by itself if no other Ollama is running.
    async ensureStarted() {
      const st = await engine.status()
      if (st.state === 'installed') await engine.start().catch(() => {})
    },
    stop: () => engine.stop(),
  }
}
