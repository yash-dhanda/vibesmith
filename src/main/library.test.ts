import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ probes: [] as ({ gpu: unknown })[], dir: '', handlers: new Map<string, (...a: unknown[]) => unknown>(), pullBody: '' as string | Error }))
vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => h.handlers.set(c, f), on: () => {} },
}))
vi.mock('./net', () => ({
  patientFetch: async (url: string) => {
    if (!url.endsWith('/api/pull')) return new Response('{}')
    if (h.pullBody instanceof Error) {
      const err = h.pullBody
      return new Response(new ReadableStream({ start: (c) => c.error(err) }))
    }
    return new Response(h.pullBody)
  },
}))
vi.mock('./system', async (orig) => ({
  ...(await orig<typeof import('./system')>()),
  systemInfo: async () => ({ ramGB: 16, cpu: 'x', cores: 4, diskFreeGB: 100, ...h.probes.shift() }),
}))
import { registerLibrary } from './library'

const sent: { channel: string; payload: any }[] = []
const pull = (name: string) => h.handlers.get('models:pull')!({}, name) as Promise<void>
beforeEach(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'forge-lib-'))
  h.handlers.clear()
  sent.length = 0
  registerLibrary(() => ({ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }) as never)
})

describe('models:pull errors', () => {
  it('a failed download is reported once: as the progress event, not also as a rejection', async () => {
    h.pullBody = '{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n'
    await expect(pull('nope')).resolves.toBeUndefined()
    expect(sent.filter((s) => s.channel === 'models:progress' && s.payload.error)).toHaveLength(1)
    expect(sent.some((s) => s.channel === 'models:changed')).toBe(false)
  })

  it('a dropped engine connection gets a readable message', async () => {
    h.pullBody = new TypeError('terminated')
    await expect(pull('m')).rejects.toThrow('The engine stopped during the download.')
  })
})

describe('models:catalog', () => {
  it('a missed GPU probe is not kept for the session', async () => {
    h.probes = [{ gpu: null }, { gpu: { name: 'g', vramGB: 24, freeGB: 24 } }, { gpu: { name: 'other', vramGB: 8, freeGB: 8 } }]
    const catalog = () => h.handlers.get('models:catalog')!({}) as Promise<unknown[]>
    await catalog()
    await catalog()
    await catalog() // the second probe found a GPU and is kept: the third is not asked
    expect(h.probes).toHaveLength(1)
  })
})
