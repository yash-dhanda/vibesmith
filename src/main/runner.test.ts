import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectRun, findPort, ProjectRunner, type RunState } from './runner'

const dir = () => mkdtempSync(join(tmpdir(), 'forge-run-'))
const put = (d: string, f: string, c = '') => writeFileSync(join(d, f), c)

describe('detectRun', () => {
  it('prefers a dev script, then start, and installs first when packages are missing', () => {
    const d = dir()
    put(d, 'package.json', JSON.stringify({ scripts: { dev: 'vite', start: 'node x' }, dependencies: { vite: '1' } }))
    expect(detectRun(d)).toMatchObject({ kind: 'server', command: 'npm install && npm run dev' })
    mkdirSync(join(d, 'node_modules'))
    expect(detectRun(d).command).toBe('npm run dev')
    const e = dir()
    put(e, 'package.json', JSON.stringify({ scripts: { start: 'node s.js' } }))
    expect(detectRun(e).command).toBe('npm start')
  })
  it('finds python apps, plain pages and node entry files, else nothing', () => {
    const p = dir(); put(p, 'app.py'); expect(detectRun(p).command).toMatch(/python3? app\.py/)
    const h = dir(); put(h, 'index.html'); expect(detectRun(h)).toMatchObject({ kind: 'static', command: null })
    const n = dir(); put(n, 'server.js'); expect(detectRun(n).command).toBe('node server.js')
    expect(detectRun(dir()).kind).toBe('none')
  })
  it('ignores a package main that is not a plain js path', () => {
    const d = dir(); put(d, 'package.json', JSON.stringify({ main: '../../evil; rm -rf x.js' })); expect(detectRun(d).kind).toBe('none')
  })
})

describe('findPort', () => {
  it('reads the usual startup lines', () => {
    expect(findPort('  Local:   http://localhost:5173/')).toBe(5173)
    expect(findPort('Listening on 0.0.0.0:3000')).toBe(3000)
    expect(findPort('Server started, port 8080')).toBe(8080)
    expect(findPort('nothing to see')).toBeNull()
    expect(findPort('x localhost:99999')).toBeNull()
  })
  it('ignores ports the server reports it could not take', () => {
    expect(findPort('Port 5173 is in use, trying another one...')).toBeNull()
    expect(findPort('Error: listen EADDRINUSE: address already in use 127.0.0.1:3000')).toBeNull()
    expect(findPort('Port 5173 is in use\n  Local: http://localhost:5174/')).toBe(5174)
  })
})

describe('ProjectRunner', () => {
  it('starts a process, streams logs, finds its port, and stops it', async () => {
    const states: RunState[] = []
    let logs = ''
    const r = new ProjectRunner(dir(), (t) => (logs += t), (s) => states.push(s))
    r.start(`node -e "console.log('ready on http://localhost:4321'); setInterval(()=>{},1000)"`)
    await new Promise((ok) => { const t = setInterval(() => { if (r.state.state === 'running') (clearInterval(t), ok(null)) }, 50) })
    expect(r.state).toMatchObject({ state: 'running', port: 4321, url: 'http://localhost:4321' })
    expect(logs).toContain('ready on')
    expect(() => r.start('node -v')).toThrow(/already running/)
    r.stop()
    await new Promise((ok) => { const t = setInterval(() => { if (r.state.state === 'exited') (clearInterval(t), ok(null)) }, 50) })
    expect(r.state.url).toBeNull()
  })
  it('refuses a blocked command', () => {
    expect(() => new ProjectRunner(dir(), () => {}, () => {}).start('sudo rm -rf /')).toThrow(/will not run/)
  })
  it('reports a process that ends by itself', async () => {
    const r = new ProjectRunner(dir(), () => {}, () => {})
    r.start('node -e "process.exit(3)"')
    await new Promise((ok) => { const t = setInterval(() => { if (r.state.state === 'exited') (clearInterval(t), ok(null)) }, 50) })
    expect(r.state.exitCode).toBe(3)
  })
})
