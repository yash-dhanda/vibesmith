import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeCodexParser } from './codexStream'
import { hubBusy, TeamHub } from './hub'
import { runCli } from './process'

const node = process.execPath
const p = () => makeCodexParser()
const base = { cwd: process.cwd() }
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform === 'win32')('runCli', () => {
  it('keeps a character that arrives split across two reads', async () => {
    const body = `const l=Buffer.from(JSON.stringify({type:'item.completed',item:{id:'a',type:'agent_message',text:'caf\\u00e9 menu'}})+'\\n'+JSON.stringify({type:'turn.completed',usage:{}})+'\\n');const cut=l.indexOf(0xc3)+1;process.stdout.write(l.subarray(0,cut));setTimeout(()=>process.stdout.write(l.subarray(cut)),100)`
    const r = await runCli('codex', node, ['-e', body], p(), { ...base, prompt: '' })
    expect(r.text).toBe('café menu')
  })

  it('does not call an agent stuck while something is waiting on its behalf (an approval for the user)', async () => {
    let waiting = true
    setTimeout(() => (waiting = false), 700)
    const body = `setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{id:'a',type:'agent_message',text:'answered'}}));console.log(JSON.stringify({type:'turn.completed',usage:{}}))},800)`
    const r = await runCli('codex', node, ['-e', body], p(), { ...base, prompt: '', idleMs: 300, hold: () => waiting })
    expect(r).toMatchObject({ ok: true, text: 'answered' })
    const stuck = await runCli('codex', node, ['-e', body], p(), { ...base, prompt: '', idleMs: 300 })
    expect(stuck.error?.kind).toBe('timeout')
  })

  it('stops the commands the agent started detached (Claude Code does that), not only the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-orphan-'))
    const pidFile = join(dir, 'pid')
    const body = `const c=require('child_process').spawn('sleep',['60'],{detached:true,stdio:'ignore'});c.unref();require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 500)
    const r = await runCli('codex', node, ['-e', body], p(), { ...base, prompt: '', signal: ctl.signal })
    expect(r.error?.kind).toBe('aborted')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100))
    const still = alive(pid)
    if (still) process.kill(pid, 'SIGKILL')
    expect(still).toBe(false)
  })
})

describe('hub: calls in progress', () => {
  it('reports a task as busy while the handler (an approval) is still answering', async () => {
    let release = () => {}
    const hub = new TeamHub(() => new Promise((res) => (release = () => res('ok'))))
    const sent: string[] = []
    const sock = { writable: true, write: (s: string) => sent.push(s) } as any
    const one = (hub as any).one(sock, JSON.stringify({ id: 1, token: hub.token, op: 'ask', args: {}, ctx: { runId: 'r', taskId: 't', agent: 'codex' } }))
    expect(hubBusy('r', 't')).toBe(true)
    expect(hubBusy('r', 'other')).toBe(false)
    release()
    await one
    expect(hubBusy('r', 't')).toBe(false)
    expect(sent[0]).toContain('"ok":true')
  })
})
