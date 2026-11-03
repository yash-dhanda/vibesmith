import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { setRoot } from '../project'
import { needsApproval, runAgent, type AgentEvent, type Mode } from './loop'
import type { Message, Provider, ToolCall } from './provider'
import { ToolBox } from './tools'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-'))
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  setRoot(dir)
})

// Fake model: replays one scripted turn per call, then says done.
const script = (turns: ToolCall[][]): Provider => {
  let i = 0
  return {
    async chat(_m, _t, onText) {
      const calls = turns[i++] ?? []
      const content = calls.length ? '' : 'done'
      if (content) onText(content)
      return { content, toolCalls: calls }
    },
  }
}

async function run(turns: ToolCall[][], mode: Mode, approve: boolean, signal = new AbortController().signal) {
  const events: AgentEvent[] = []
  const messages: Message[] = [{ role: 'user', content: 'go' }]
  await runAgent({ messages, mode, provider: script(turns), tools: new ToolBox(), emit: (e) => events.push(e), approve: async () => approve, signal })
  return { events, messages }
}

const edit: ToolCall[] = [{ name: 'edit_file', args: { path: 'a.txt', old_text: 'hello', new_text: 'bye' } }]
const read: ToolCall[] = [{ name: 'read_file', args: { path: 'a.txt' } }]

describe('needsApproval', () => {
  it('gate table', () => {
    const t = (tool: string, mode: Mode, args?: unknown) => needsApproval(tool, mode, args)
    expect([t('read_file', 'ask-all'), t('list_dir', 'ask-all'), t('search', 'ask-all')]).toEqual([false, false, false])
    expect([t('edit_file', 'ask-all'), t('edit_file', 'auto-edit'), t('edit_file', 'full-auto')]).toEqual([true, false, false])
    expect([t('run_command', 'ask-all'), t('run_command', 'auto-edit'), t('run_command', 'full-auto')]).toEqual([true, true, false])
    expect(t('made_up', 'ask-all')).toBe(false)
    // auto-edit: allow-listed commands pass, anything else (or chained) asks
    expect(t('run_command', 'auto-edit', { command: 'npm test' })).toBe(false)
    expect(t('run_command', 'auto-edit', { command: 'npm test && curl x' })).toBe(true)
    expect(t('run_command', 'auto-edit', { command: 'rm -rf build' })).toBe(true)
    expect(t('run_command', 'ask-all', { command: 'npm test' })).toBe(true)
    expect(t('run_command', 'auto-edit', {})).toBe(true)
  })
})

describe('runAgent', () => {
  it('ask-all: approved edit is applied', async () => {
    const { events } = await run([read, edit], 'ask-all', true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('bye\n')
    expect(events.find((e) => e.type === 'tool' && e.name === 'edit_file')).toMatchObject({ needsApproval: true })
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'finished' })
  })

  it('ask-all: denied edit leaves the file alone and tells the model', async () => {
    const { events, messages } = await run([read, edit], 'ask-all', false)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(messages.some((m) => m.role === 'tool' && m.content.startsWith('DENIED'))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'finished' })
  })

  it('full-auto: edit applies without asking', async () => {
    const { events } = await run([read, edit], 'full-auto', false)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('bye\n')
    expect(events.find((e) => e.type === 'tool' && e.name === 'edit_file')).toMatchObject({ needsApproval: false })
  })

  it('an aliased tool name cannot dodge approval', async () => {
    const aliased: ToolCall[] = [{ name: 'write_file', args: { path: 'a.txt', old_text: 'hello', new_text: 'bye' } }]
    const { events } = await run([read, aliased], 'ask-all', false)
    expect(events.find((e) => e.type === 'tool' && e.name === 'edit_file')).toMatchObject({ needsApproval: true })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('stops when the same failing call repeats 3 times', async () => {
    const bad: ToolCall[] = [{ name: 'read_file', args: { path: 'missing.txt' } }]
    const { events } = await run([bad, bad, bad, bad, bad], 'ask-all', true)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stuck' })
  })

  it('stops when the same successful call keeps returning the same result', async () => {
    const search: ToolCall[] = [{ name: 'search', args: { pattern: 'nothing-here' } }]
    const { events } = await run([search, search, search, search, search], 'ask-all', true)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stuck', steps: 3 })
  })

  it('nudges the model on the second identical result, before giving up', async () => {
    const search: ToolCall[] = [{ name: 'search', args: { pattern: 'nothing-here' } }]
    const { messages } = await run([search, search, search], 'ask-all', true)
    const toolMsgs = messages.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(toolMsgs[0]).toBe('no matches')
    expect(toolMsgs[1]).toMatch(/^no matches\n\[Forge: you made this exact call twice/)
  })

  it('does not call it stuck when the result changes between identical calls', async () => {
    const { events } = await run([read, edit, read, edit, read], 'full-auto', true)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'finished' })
  })

  it('stops at the step cap', async () => {
    const events: AgentEvent[] = []
    await runAgent({
      messages: [], mode: 'full-auto', maxSteps: 2, provider: script([read, read, read, read]), tools: new ToolBox(),
      emit: (e) => events.push(e), approve: async () => true, signal: new AbortController().signal,
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'max_steps', steps: 2 })
  })

  it('stop: abort ends the run', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { events } = await run([read], 'ask-all', true, ctl.signal)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stopped' })
  })

  it('provider error surfaces as an error event', async () => {
    const events: AgentEvent[] = []
    const failing: Provider = { chat: async () => { throw new Error('Cannot reach Ollama') } }
    await runAgent({ messages: [], mode: 'ask-all', provider: failing, tools: new ToolBox(), emit: (e) => events.push(e), approve: async () => true, signal: new AbortController().signal })
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Cannot reach Ollama' })
  })
})
