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
    const t = (tool: string, mode: Mode) => needsApproval(tool, mode)
    expect([t('read_file', 'ask-all'), t('list_dir', 'ask-all')]).toEqual([false, false])
    expect([t('edit_file', 'ask-all'), t('edit_file', 'auto-edit'), t('edit_file', 'full-auto')]).toEqual([true, false, false])
    expect([t('run_command', 'ask-all'), t('run_command', 'auto-edit'), t('run_command', 'full-auto')]).toEqual([true, true, false])
    expect(t('made_up', 'ask-all')).toBe(false)
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

  it('stops when the same failing call repeats 3 times', async () => {
    const bad: ToolCall[] = [{ name: 'read_file', args: { path: 'missing.txt' } }]
    const { events } = await run([bad, bad, bad, bad, bad], 'ask-all', true)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stuck' })
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
