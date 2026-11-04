import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { hubBusy, TeamHub } from './hub'
import { handleRpc, hubCaller, TOOLS } from './mcpServer'

let hub: TeamHub | null = null
afterEach(() => hub?.stop())

describe('hub + mcp server', () => {
  it('lists the team tools and answers initialize', async () => {
    const call = async () => ''
    expect((await handleRpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, call))?.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'forge_team' } })
    const list: any = await handleRpc({ id: 2, method: 'tools/list' }, call)
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name))
    expect(await handleRpc({ method: 'notifications/initialized' }, call)).toBeNull()
  })

  it('carries a tool call to the handler with the agent identity, and refuses a wrong token', async () => {
    const seen: unknown[] = []
    hub = new TeamHub(async (op, args, ctx) => (seen.push({ op, args, ctx }), op === 'boom' ? Promise.reject(new Error('nope')) : { got: op }))
    const sock = await hub.start()
    const call = hubCaller(sock, hub.token, { runId: 'r1', taskId: 't1', agent: 'codex' })
    const out: any = await handleRpc({ id: 3, method: 'tools/call', params: { name: 'team_post', arguments: { to: 'claude', body: 'hi' } } }, call)
    expect(JSON.parse(out.result.content[0].text)).toEqual({ got: 'post' })
    expect(seen[0]).toEqual({ op: 'post', args: { to: 'claude', body: 'hi' }, ctx: { runId: 'r1', taskId: 't1', agent: 'codex' } })

    const bad = hubCaller(sock, 'wrong', { runId: 'r1', taskId: 't1', agent: 'codex' })
    await expect(bad('post', {})).rejects.toThrow(/not allowed/)

    const failing: any = await handleRpc({ id: 4, method: 'tools/call', params: { name: 'team_tasks', arguments: {} } }, async () => Promise.reject(new Error('boom')))
    expect(failing.result.isError).toBe(true)
    expect((await handleRpc({ id: 5, method: 'tools/call', params: { name: 'rm_rf' } }, call) as any).error.code).toBe(-32602)
  })

  it('lets a slow call (an approval) wait while others are answered', async () => {
    let release: (v: string) => void = () => {}
    hub = new TeamHub((op) => (op === 'request_approval' ? new Promise((r) => (release = r)) : Promise.resolve('fast')))
    const call = hubCaller(await hub.start(), hub.token, { runId: 'r', taskId: 't', agent: 'claude' })
    const slow = call('request_approval', {})
    expect(await call('inbox', {})).toBe('fast')
    release('allowed')
    expect(await slow).toBe('allowed')
  })

  it('stops counting a pending call when the agent that made it goes away', async () => {
    const h = new TeamHub(() => new Promise(() => {}))
    const sock: any = new EventEmitter()
    Object.assign(sock, { writable: true, write: () => true, setEncoding: () => {} })
    ;(h as any).serve(sock)
    sock.emit('data', JSON.stringify({ id: 1, token: h.token, op: 'ask', ctx: { runId: 'rx', taskId: 'tx', agent: 'claude' } }) + '\n')
    await new Promise((r) => setTimeout(r, 20))
    expect(hubBusy('rx', 'tx')).toBe(true)
    sock.emit('close')
    expect(hubBusy('rx', 'tx')).toBe(false)
  })
})
