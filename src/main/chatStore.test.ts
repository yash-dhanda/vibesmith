import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatStore, compact, titleFrom, type TranscriptItem } from './chatStore'

let dir: string
let store: ChatStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-chats-'))
  store = new ChatStore(dir)
})

describe('titleFrom', () => {
  it('collapses whitespace, truncates, falls back', () => {
    expect(titleFrom('  fix   the\nbug ')).toBe('fix the bug')
    expect(titleFrom('x'.repeat(80))).toHaveLength(48)
    expect(titleFrom('x'.repeat(80)).endsWith('…')).toBe(true)
    expect(titleFrom('   ')).toBe('New chat')
  })
})

describe('compact', () => {
  it('merges consecutive deltas only', () => {
    const items: TranscriptItem[] = [
      { type: 'user', text: 'hi' },
      { type: 'delta', text: 'He' },
      { type: 'delta', text: 'llo' },
      { type: 'turn_end' },
      { type: 'delta', text: 'Again' },
    ]
    expect(compact(items)).toEqual([{ type: 'user', text: 'hi' }, { type: 'delta', text: 'Hello' }, { type: 'turn_end' }, { type: 'delta', text: 'Again' }])
  })
})

describe('ChatStore', () => {
  it('saves, loads, and lists newest first', async () => {
    const a = store.create('/p/a')
    a.title = 'first'
    a.transcript.push({ type: 'user', text: 'hello' }, { type: 'delta', text: 'hi' }, { type: 'delta', text: ' there' })
    store.save(a)
    await new Promise((r) => setTimeout(r, 5))
    const b = store.create(null)
    b.title = 'second'
    store.save(b)

    expect(store.list().map((s) => s.title)).toEqual(['second', 'first'])
    expect(store.list()[1]).toMatchObject({ id: a.id, project: '/p/a' })
    expect(store.load(a.id)!.transcript).toEqual([{ type: 'user', text: 'hello' }, { type: 'delta', text: 'hi there' }])
  })

  it('re-saving a chat moves it to the top without duplicating', async () => {
    const a = store.create('/p')
    store.save(a)
    await new Promise((r) => setTimeout(r, 5))
    const b = store.create('/p')
    store.save(b)
    await new Promise((r) => setTimeout(r, 5))
    store.save(a)
    expect(store.list().map((s) => s.id)).toEqual([a.id, b.id])
  })

  it('persists messages and checkpoints so a chat can continue and undo after a restart', () => {
    const a = store.create('/p')
    a.messages.push({ role: 'user', content: 'x' })
    a.checkpoints['1'] = { id: '1', tree: 'abc' }
    store.save(a)
    const again = new ChatStore(dir).load(a.id)!
    expect(again.messages).toEqual([{ role: 'user', content: 'x' }])
    expect(again.checkpoints['1']).toEqual({ id: '1', tree: 'abc' })
  })

  it('delete removes the file and the index entry', () => {
    const a = store.create(null)
    store.save(a)
    store.delete(a.id)
    expect(store.list()).toEqual([])
    expect(store.load(a.id)).toBeNull()
    expect(existsSync(join(dir, `${a.id}.json`))).toBe(false)
  })

  it('refuses ids that could escape the folder', () => {
    expect(() => store.load('../evil')).not.toThrow() // load swallows errors and returns null
    expect(store.load('../evil')).toBeNull()
    expect(() => store.delete('../../etc/passwd')).toThrow('bad chat id')
    expect(() => store.delete('a/b')).toThrow('bad chat id')
  })

  it("'index' names the sidebar's own file, so it cannot be a chat id", () => {
    const a = store.create(null)
    store.save(a)
    expect(() => store.delete('index')).toThrow('bad chat id')
    expect(() => store.create(null, 'index')).toThrow('bad chat id')
    expect(store.list().map((c) => c.id)).toEqual([a.id])
    expect(() => store.create(null, 'index2')).not.toThrow()
  })

  it('survives a corrupt chat file and a corrupt index', () => {
    const a = store.create(null)
    store.save(a)
    writeFileSync(join(dir, `${a.id}.json`), '{ broken')
    expect(store.load(a.id)).toBeNull()
    writeFileSync(join(dir, 'index.json'), 'not json')
    expect(store.list()).toEqual([])
    store.save(store.create(null)) // still usable afterwards
    expect(store.list()).toHaveLength(1)
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).toContain('New chat')
  })
})

describe('index rebuild', () => {
  const three = () => ['a', 'b', 'c'].map((t) => { const c = store.create('/p'); c.title = t; c.pinned = t === 'a' || undefined; store.save(c); return c })

  it.each(['', 'not json', '{}', 'null', '[{"title":"no id"}]'])('a garbled index (%j) is rebuilt from the chat files, not emptied', (bad) => {
    const [a] = three()
    writeFileSync(join(dir, 'index.json'), bad)
    expect(store.list().map((s) => s.title).sort()).toEqual(['a', 'b', 'c'])
    expect(store.list().find((s) => s.id === a.id)).toMatchObject({ project: '/p', pinned: true })
    store.save(store.create('/p')) // the next save must not shrink the list to one
    expect(store.list()).toHaveLength(4)
  })

  it('a missing index is rebuilt too, and stray files are ignored', () => {
    three()
    rmSync(join(dir, 'index.json'))
    writeFileSync(join(dir, 'x.json.tmp'), '{}')
    writeFileSync(join(dir, 'broken.json'), '{ nope')
    expect(store.list()).toHaveLength(3)
  })
})

describe('pinning and search', () => {
  const make = (id: string, title: string, items: TranscriptItem[], project: string | null = '/p/a') => {
    const c = store.create(project, id)
    c.title = title
    c.transcript = items
    store.save(c)
    return c
  }

  it('pinning keeps the chat\'s place in time and shows in the list', () => {
    const a = make('a', 'first', [])
    make('b', 'second', [])
    const before = store.list().find((s) => s.id === 'a')!.updatedAt
    a.pinned = true
    store.save(a, false)
    const item = store.list().find((s) => s.id === 'a')!
    expect(item.pinned).toBe(true)
    expect(item.updatedAt).toBe(before)
    a.pinned = undefined
    store.save(a, false)
    expect(store.list().find((s) => s.id === 'a')!.pinned).toBeUndefined()
  })

  it('finds chats by title, user and assistant text, needs every word, shows a snippet', () => {
    make('a', 'Flower shop', [{ type: 'user', text: 'please add a checkout page with stripe' }, { type: 'delta', text: 'I created '}, { type: 'delta', text: 'checkout.html for you' }, { type: 'turn_end' }])
    make('b', 'Todo app', [{ type: 'user', text: 'a to-do list' }, { type: 'delta', text: 'Done: dark mode added' }])
    expect(store.search('checkout stripe').map((h) => h.id)).toEqual(['a'])
    expect(store.search('DARK mode').map((h) => h.id)).toEqual(['b'])
    expect(store.search('flower').map((h) => h.snippets[0])).toEqual([{ where: 'title', text: 'Flower shop' }])
    const hit = store.search('checkout')[0]
    expect(hit.snippets.map((s) => s.where)).toEqual(['user', 'assistant'])
    expect(hit.snippets[1].text).toContain('checkout.html')
    expect(store.search('nothing here')).toEqual([])
    expect(store.search('a')).toEqual([]) // one-letter words are ignored
  })
})

// ---- the handlers in index.ts, driven with a stand-in for Electron and for everything that talks to git, models or the team ----
const H = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  listeners: new Map<string, ((...a: any[]) => any)[]>(),
  appEvents: new Map<string, ((...a: any[]) => any)[]>(),
  userData: '',
  lock: true,
  exits: 0,
  quits: 0,
  wins: 0,
  ready: () => {},
  msgBox: (async () => ({ response: 0 })) as (...a: any[]) => Promise<{ response: number }>,
  pty: [] as any[],
  runAgent: (async () => {}) as (o: any) => Promise<void>,
  usageRecord: (() => {}) as (...a: any[]) => void,
  recorded: [] as any[],
  teamOpts: null as any,
  shutdowns: 0,
  settingsSet: [] as any[],
  teamStarts: [] as any[],
  runs: {} as Record<string, { project: string }>,
  scans: 0,
  scanGate: null as null | Promise<void>,
  provider: null as any,
  git: { has: true, repo: true, createCheckpoint: (async () => ({ id: 'cp1' })) as (...a: any[]) => Promise<any>, changes: (async () => []) as (...a: any[]) => Promise<any[]>, undoTo: (async () => []) as (...a: any[]) => Promise<string[]> },
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  H.handlers = new Map()
  H.listeners = new Map()
  const wc = () => ({ send() {}, setWindowOpenHandler() {}, on() {}, getURL: () => 'x', isDestroyed: () => false })
  class BrowserWindow extends EventEmitter {
    webContents = wc()
    constructor() { super(); H.wins++ }
    static fromWebContents() { return null }
    loadFile() {}
    loadURL() {}
    isMinimized() { return false }
    isFocused() { return true }
    isDestroyed() { return false }
    focus() {}
    close() { this.emit('close', { preventDefault() { closePrevented = true } }) }
  }
  let closePrevented = false
  const app = Object.assign(new EventEmitter().setMaxListeners(100), {
    getPath: () => H.userData,
    whenReady: () => new Promise<void>((r) => (H.ready = r)),
    requestSingleInstanceLock: () => H.lock,
    quit: () => { H.quits++ },
    exit: () => { H.exits++ },
    getVersion: () => '0',
  })
  H.appEvents = new Map()
  const on = app.on.bind(app)
  app.on = ((ev: string, fn: any) => (H.appEvents.set(ev, [...(H.appEvents.get(ev) ?? []), fn]), on(ev, fn))) as any
  return {
    app,
    BrowserWindow,
    WebContentsView: class { webContents = wc() },
    Notification: class { static isSupported() { return false } },
    shell: { openPath: async () => '', openExternal: async () => {} },
    safeStorage: {},
    dialog: { showMessageBox: (...a: any[]) => H.msgBox(...a), showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
    ipcMain: {
      handle: (c: string, fn: any) => void H.handlers.set(c, fn),
      on: (c: string, fn: any) => void H.listeners.set(c, [...(H.listeners.get(c) ?? []), fn]),
    },
  }
})
vi.mock('node-pty', () => ({
  spawn: () => {
    const t: any = { exited: false, data: [] as ((d: string) => void)[], exit: [] as (() => void)[], kill() { this.exited = true }, write() {}, resize() { if (this.exited) throw new Error('ioctl(2) failed, EBADF') } }
    t.onData = (f: any) => t.data.push(f)
    t.onExit = (f: any) => t.exit.push(f)
    H.pty.push(t)
    return t
  },
}))
vi.mock('./library', () => ({ registerLibrary: () => ({ ensureStarted() {}, stop() {} }) }))
vi.mock('./remote', () => ({ RemoteServer: class { broadcast() {} async configure() { return {} } status() { return {} } } }))
vi.mock('./usageStore', () => ({ UsageStore: class { record(...a: any[]) { H.usageRecord(...a) } summary() { return {} } } }))
vi.mock('./projectScan', async (orig) => ({ ...(await orig<typeof import('./projectScan')>()), scanProjects: async () => { H.scans++; await H.scanGate; return [] } }))
vi.mock('./models', () => ({ makeProvider: () => H.provider, modelSupportsVision: async () => true, listModels: async () => [], ollamaStatus: async () => ({ loaded: [] }) }))
vi.mock('./checkpoint', () => ({
  hasGit: async () => H.git.has, isRepo: async () => H.git.repo, initRepo: async () => {},
  createCheckpoint: (...a: any[]) => H.git.createCheckpoint(...a), changesSince: (...a: any[]) => H.git.changes(...a), undoTo: (...a: any[]) => H.git.undoTo(...a),
  diffOf: async () => '', fileAt: async () => null, undoFile: async () => [], SECRET_PATH: /\.env$/,
}))
vi.mock('./agent/loop', async (orig) => ({ ...(await orig<typeof import('./agent/loop')>()), runAgent: (o: any) => H.runAgent(o) }))
vi.mock('./team/service', async (orig) => ({
  ...(await orig<typeof import('./team/service')>()),
  createTeamService: (o: any) => {
    H.teamOpts = o
    return {
      stopApps: () => {}, orch: { shutdown: () => void H.shutdowns++, get: (id: string) => H.runs[id] },
      settings: { get: () => ({}), set: (root: string, cfg: unknown) => void H.settingsSet.push([root, cfg]) },
      start: (root: string) => void H.teamStarts.push(root),
      health: () => ({}),
    }
  },
}))

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const desktop = { sender: { send() {} } }
const phone = { sender: { send() {} }, remote: true }

describe('main process handlers', () => {
  let ud: string
  const call = (c: string, ...a: unknown[]) => H.handlers.get(c)!(desktop, ...a)
  const callPhone = (c: string, ...a: unknown[]) => H.handlers.get(c)!(phone, ...a)
  const proj = (name: string, files: Record<string, string> = { 'a.txt': 'a' }) => {
    const d = mkdtempSync(join(ud, name + '-'))
    for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t)
    return d
  }
  const seed = (id: string, project: string, extra: Partial<import('./chatStore').Chat> = {}) => {
    const st = new ChatStore(join(ud, 'chats'))
    const c = st.create(project, id)
    c.transcript.push({ type: 'user', text: 'hi' })
    c.messages.push({ role: 'system', content: 's' }, { role: 'user', content: 'hi' })
    Object.assign(c, extra)
    st.save(c)
  }
  const boot = async () => {
    vi.resetModules()
    for (const m of [H.handlers, H.listeners, H.appEvents]) m.clear()
    ud = mkdtempSync(join(tmpdir(), 'forge-ud-'))
    H.userData = ud
    Object.assign(H, { lock: true, exits: 0, quits: 0, wins: 0, pty: [], recorded: [], shutdowns: 0, settingsSet: [], teamStarts: [], runs: {}, scans: 0, scanGate: null })
    H.msgBox = async () => ({ response: 0 })
    H.runAgent = async () => {}
    H.usageRecord = (...a) => void H.recorded.push(a)
    H.provider = { chat: async () => ({ content: '', toolCalls: [] }) }
    H.git = { has: true, repo: true, createCheckpoint: async () => ({ id: 'cp1' }), changes: async () => [], undoTo: async () => [] }
    await import('./index')
    H.ready()
    await tick()
  }
  const transcript = async (id: string) => (await call('chats:open', id)).transcript as { type: string; [k: string]: unknown }[]
  const send = (e: unknown, chatId: string, extra: object = {}) => H.handlers.get('agent:send')!(e, { chatId, text: 'go', mode: 'auto-edit', model: 'ollama:x', ...extra })
  const never = () => new Promise<void>(() => {})
  afterEach(() => vi.useRealTimers())

  it('a phone opening a chat does not move the computer\'s folder', async () => {
    await boot()
    const a = proj('A')
    const b = proj('B')
    seed('ca', a)
    seed('cb', b)
    await call('chats:open', 'ca')
    await callPhone('chats:open', 'cb')
    await call('fs:write', 'NOTES.md', 'for A')
    expect(readFileSync(join(a, 'NOTES.md'), 'utf8')).toBe('for A')
    expect(existsSync(join(b, 'NOTES.md'))).toBe(false)
    await callPhone('fs:write', 'P.md', 'for B')
    expect(readFileSync(join(b, 'P.md'), 'utf8')).toBe('for B')
    await callPhone('team:settings-set', { x: 1 })
    await callPhone('team:start', 'goal', {})
    await call('team:start', 'goal', {})
    expect(H.settingsSet.map((s) => s[0])).toEqual([b])
    expect(H.teamStarts).toEqual([b, a])
  })

  it('two paired phones keep their own folders', async () => {
    await boot()
    const a = proj('A')
    const b = proj('B')
    seed('ca', a)
    seed('cb', b)
    const p1 = { ...phone, device: 'd1' }
    const p2 = { ...phone, device: 'd2' }
    await H.handlers.get('chats:open')!(p1, 'ca')
    await H.handlers.get('chats:open')!(p2, 'cb')
    await H.handlers.get('fs:write')!(p1, 'P.md', 'one')
    await H.handlers.get('fs:write')!(p2, 'P.md', 'two')
    expect(readFileSync(join(a, 'P.md'), 'utf8')).toBe('one')
    expect(readFileSync(join(b, 'P.md'), 'utf8')).toBe('two')
  })

  it('a failed checkpoint does not leave the chat stuck on "still working"', async () => {
    await boot()
    const d = proj('P')
    await call('project:set', d)
    H.git.createCheckpoint = async () => { throw new Error('open("data"): Permission denied\nfatal: adding files failed') }
    await send(desktop, 'c1')
    await tick()
    expect((await transcript('c1')).some((t) => t.type === 'note' && /cannot be undone/.test(String(t.text)))).toBe(true)
    await expect(send(desktop, 'c1')).resolves.toBeUndefined()
  })

  it('a usage ledger that cannot be written does not stop the run or fail a Crew task', async () => {
    await boot()
    await call('project:set', proj('P'))
    H.usageRecord = () => { throw new Error('EACCES: usage.json.tmp') }
    H.runAgent = async (o) => { o.emit({ type: 'usage', input: 1, output: 1, tps: 1 }); o.emit({ type: 'delta', text: 'still here' }) }
    await send(desktop, 'c1')
    await tick()
    const t = await transcript('c1')
    expect(t.some((x) => x.type === 'error')).toBe(false)
    expect(t.some((x) => x.type === 'delta')).toBe(true)
    expect(() => H.teamOpts.recordUsage('claude', { input: 1, output: 1 })).not.toThrow()
  })

  it('Edit and resend keeps the chat and its checkpoints when the files cannot be restored', async () => {
    await boot()
    const d = proj('P')
    seed('c1', d, { transcript: [{ type: 'user', text: 'hi' }, { type: 'changes', checkpoint: 'cp1', files: [] }], checkpoints: { cp1: { id: 'cp1' } as never } })
    H.git.undoTo = async () => { throw new Error("pathspec 'a' did not match") }
    await expect(call('chats:rewind', 'c1', 0, true)).rejects.toThrow('pathspec')
    expect((await transcript('c1')).map((t) => t.type)).toEqual(['user', 'changes'])
    H.git.undoTo = async () => ['a.txt']
    await expect(call('chats:rewind', 'c1', 0, true)).resolves.toMatchObject({ files: ['a.txt'] })
  })

  it('two sends to one chat start one run, even while the first waits on the undo question', async () => {
    await boot()
    const d = proj('P')
    await call('project:set', d)
    H.git.repo = false
    let answer: (r: { response: number }) => void = () => {}
    H.msgBox = () => new Promise((r) => (answer = r))
    let runs = 0
    H.runAgent = async () => { runs++; await never() }
    const first = send(desktop, 'c1')
    await tick()
    await expect(H.handlers.get('agent:send')!(phone, { chatId: 'c1', text: 'again', mode: 'auto-edit', model: 'ollama:x' })).rejects.toThrow('still working')
    answer({ response: 1 })
    await first
    await tick()
    expect(runs).toBe(1)
  })

  it('the terminal survives its shell exiting and a respawn does not inherit the old shell\'s output', async () => {
    await boot()
    const out: string[] = []
    const e = { sender: { send: (_c: string, d: string) => void out.push(d), isDestroyed: () => false } }
    await H.handlers.get('term:spawn')!(e, 80, 24)
    const first = H.pty[0]
    first.exited = true
    first.exit.forEach((f: () => void) => f())
    expect(out.join('')).toContain('[process exited]')
    expect(() => H.listeners.get('term:resize')!.forEach((f) => f(e, 100, 30))).not.toThrow()
    out.length = 0
    await H.handlers.get('term:spawn')!(e, 80, 24)
    first.data.forEach((f: (d: string) => void) => f('stale'))
    first.exit.forEach((f: () => void) => f())
    expect(out).toEqual([])
    H.pty[1].data.forEach((f: (d: string) => void) => f('fresh'))
    expect(out).toEqual(['fresh'])
  })

  it('two terminal spawns at once leave one shell, and a closed window gets no output', async () => {
    await boot()
    let gone = false
    const e = { sender: { send: () => { if (gone) throw new Error('Object has been destroyed') }, isDestroyed: () => gone } }
    await Promise.all([H.handlers.get('term:spawn')!(e, 80, 24), H.handlers.get('term:spawn')!(e, 80, 24)])
    expect(H.pty).toHaveLength(2)
    expect(H.pty.filter((t: any) => !t.exited)).toHaveLength(1)
    gone = true
    const live = H.pty.find((t: any) => !t.exited)
    expect(() => { live.data.forEach((f: (d: string) => void) => f('x')); live.exit.forEach((f: () => void) => f()) }).not.toThrow()
  })

  it('a plan edit made during a run is kept when the agent updates its plan again', async () => {
    await boot()
    await call('project:set', proj('P'))
    let plan: any
    let release: () => void = () => {}
    H.runAgent = async (o) => { plan = o.plan; plan.revision = 1; plan.items = [{ id: 'a', text: 'A', status: 'todo', skipped: false }]; await new Promise<void>((r) => (release = r)) }
    await send(desktop, 'c1')
    await tick()
    await call('agent:plan-update', 'c1', { revision: 1, items: [{ id: 'a', text: 'A', skipped: true }] })
    expect(plan.revision).toBe(2)
    expect(plan.items[0].skipped).toBe(true)
    release()
  })

  it('a chat deleted just after its run does not come back, and the summary call is counted', async () => {
    await boot()
    const d = proj('P')
    await call('project:set', d)
    let reply: () => void = () => {}
    H.git.changes = async () => [{ path: 'a.txt', status: 'added', added: 1, removed: 0 }]
    H.provider = { chat: async (_m: unknown, _t: unknown, onText: (t: string) => void) => { await new Promise<void>((r) => (reply = r)); onText('a.txt: Adds a note.'); return { content: '', toolCalls: [], usage: { input: 7, output: 3, genMs: 1 } } } }
    await send(desktop, 'c1')
    await tick()
    await tick()
    expect(call('chats:list')).toBeDefined()
    await call('chats:delete', 'c1')
    reply()
    await tick()
    expect((await call('chats:list')).map((c: { id: string }) => c.id)).toEqual([])
    expect(existsSync(join(ud, 'chats', 'c1.json'))).toBe(false)
    expect(H.recorded.some((r) => r[1].input === 7)).toBe(true)
  })

  it('the summary of a new file reads only its first lines, even from a huge file; a corrupt state file is replaced whole', async () => {
    await boot()
    const d = proj('P', { 'big.txt': ('line\n'.repeat(40) + 'x'.repeat(2_000_000)) })
    writeFileSync(join(ud, 'state.json'), '{ half')
    await call('project:set', d)
    expect(JSON.parse(readFileSync(join(ud, 'state.json'), 'utf8')).lastProject).toBe(d)
    expect(existsSync(join(ud, 'state.json.tmp'))).toBe(false)
    let prompt = ''
    H.git.changes = async () => [{ path: 'big.txt', status: 'added', added: 1, removed: 0 }]
    H.provider = { chat: async (m: { content: string }[]) => { prompt = m[0].content; return { content: '', toolCalls: [], usage: { input: 1, output: 1, genMs: 1 } } } }
    await send(desktop, 'c1')
    await tick()
    await tick()
    expect(prompt).toContain('big.txt')
    expect(prompt.length).toBeLessThan(20_000)
  })

  it('no after-run summary is requested for a run the user stopped', async () => {
    await boot()
    await call('project:set', proj('P'))
    let asked = 0
    H.git.changes = async () => [{ path: 'a.txt', status: 'added', added: 1, removed: 0 }]
    H.provider = { chat: async () => (asked++, { content: '', toolCalls: [] }) }
    H.runAgent = (o) => new Promise<void>((r) => o.signal.addEventListener('abort', () => r()))
    await send(desktop, 'c1')
    await tick()
    H.listeners.get('agent:stop')![0](desktop, 'c1')
    await tick()
    expect(asked).toBe(0)
  })

  it('overlapping folder scans share one scan', async () => {
    await boot()
    let open: () => void = () => {}
    H.scanGate = new Promise<void>((r) => (open = r))
    const calls = [call('project:scan', true), call('project:scan', true), call('project:suggest', 'x')]
    await tick()
    open()
    await Promise.all(calls)
    expect(H.scans).toBe(1)
  })

  it('the run header shows the history of the run\'s own project', async () => {
    await boot()
    const runDir = proj('run', {})
    const other = proj('other', {})
    mkdirSync(join(runDir, '.forge'))
    writeFileSync(join(runDir, '.forge', 'what-happened.txt'), 'run history')
    await call('project:set', other)
    H.runs['run-1'] = { project: runDir }
    expect((await call('team:history', 'run-1')).text).toBe('run history')
    expect((await call('team:history')).text).toBe('')
  })

  it('a skill id that names the registry file removes nothing', async () => {
    await boot()
    mkdirSync(join(ud, 'skills'), { recursive: true })
    writeFileSync(join(ud, 'skills', 'index.json'), '[]')
    expect(() => call('skills:remove', 'index.json')).toThrow('not in the list')
    expect(existsSync(join(ud, 'skills', 'index.json'))).toBe(true)
  })

  it('"Keep working" after a quit request leaves everything running', async () => {
    await boot()
    await call('project:set', proj('P'))
    H.runAgent = never
    await send(desktop, 'c1')
    await tick()
    const quit = H.appEvents.get('before-quit')!.at(-1)!
    let prevented = false
    quit({ preventDefault: () => (prevented = true) })
    await tick()
    expect(prevented).toBe(true)
    expect(H.shutdowns).toBe(0)
    expect(H.quits).toBe(0)
    H.msgBox = async () => ({ response: 1 })
    quit({ preventDefault: () => {} })
    await tick()
    expect(H.shutdowns).toBe(0)
    expect(H.quits).toBe(1)
    prevented = false
    quit({ preventDefault: () => (prevented = true) })
    expect(prevented).toBe(false)
    expect(H.shutdowns).toBe(1)
  })

  it('a second launch exits without starting up', async () => {
    vi.resetModules()
    ud = mkdtempSync(join(tmpdir(), 'forge-ud-'))
    H.userData = ud
    H.lock = false
    H.exits = 0
    H.wins = 0
    await import('./index')
    H.ready()
    await tick()
    expect(H.exits).toBe(1)
    expect(H.wins).toBe(0)
  })
})
