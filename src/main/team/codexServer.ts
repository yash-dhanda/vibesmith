import { spawn } from 'node:child_process'
import { killTree } from '../agent/commands'
import { codexMcpArgs, type TeamLink } from './link'
import type { ErrorKind, TeamEvent } from './events'
import { classifyError } from './events'
import { resolveCommand } from './bin'
import { cleanEnv, makeSink, type RunOpts, type RunResult } from './process'
import { unwrapShell } from './codexStream'
import { relative } from 'node:path'

// Codex through `codex app-server` (JSON-RPC over stdio) instead of `codex exec`. What it adds: the agent can be steered while it
// works (turn/steer), its approval requests reach the user instead of being refused by the sandbox, and it reports how much of the
// ChatGPT plan's allowance is used. Protocol shapes were captured from codex-cli 0.153 (the schema is `codex app-server generate-json-schema`).

export type ServerHandle = { steer(text: string): Promise<boolean>; interrupt(): void }
export type ApprovalAsk = { kind: 'command' | 'files'; title: string; detail: string; command?: string }
export type CodexServerOpts = RunOpts & {
  write: boolean
  model: string
  resume?: string
  team?: TeamLink
  onApproval?: (a: ApprovalAsk) => Promise<boolean>
  onHandle?: (h: ServerHandle | null) => void
}

type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

export function runCodexServer(o: CodexServerOpts, bin = 'codex'): Promise<RunResult> {
  return new Promise((resolve) => {
    const sink = makeSink('codex', o.onEvent)
    const { push } = sink
    let settled = false
    let threadId = ''
    let turnId = ''
    let finalText = ''
    let lastText = ''
    let baseline: { input: number; output: number; cached: number } | null = null
    let latest = { input: 0, output: 0, cached: 0 }
    let buf = ''
    let nextId = 0
    const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>()

    const cmd = resolveCommand(bin, ['app-server', ...(o.team ? codexMcpArgs(o.team) : [])])
    const child = spawn(cmd.cmd, cmd.args, { cwd: o.cwd, env: cleanEnv(process.env, { ...cmd.env, ...o.env }), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    const write = (m: object) => child.stdin.writable && child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    const request = (method: string, params: object) =>
      new Promise<any>((ok, fail) => {
        const id = ++nextId
        waiting.set(id, { ok, fail })
        write({ id, method, params })
      })

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      clearTimeout(max)
      o.signal?.removeEventListener('abort', onAbort)
      o.onHandle?.(null)
      for (const w of waiting.values()) w.fail(new Error('closed'))
      killTree(child)
      resolve(sink.res)
    }
    const end = (kind: ErrorKind | null, message = '') => {
      if (kind && !sink.res.error) push({ type: 'error', agent: 'codex', kind, message })
      if (!sink.done) {
        if (latest.input || latest.output) push({ type: 'usage', agent: 'codex', input: latest.input - (baseline?.input ?? 0), output: latest.output - (baseline?.output ?? 0), cached: latest.cached - (baseline?.cached ?? 0) })
        push({ type: 'done', agent: 'codex', ok: !kind, text: finalText || lastText })
      }
      finish()
    }

    const idleMs = o.idleMs ?? 300_000
    let idle = setTimeout(() => end('timeout', `no output for ${Math.round(idleMs / 1000)}s`), idleMs)
    const poke = () => {
      clearTimeout(idle)
      idle = setTimeout(() => end('timeout', `no output for ${Math.round(idleMs / 1000)}s`), idleMs)
    }
    const max = setTimeout(() => end('timeout', `took longer than ${Math.round((o.maxMs ?? 1_800_000) / 60_000)} minutes`), o.maxMs ?? 1_800_000)
    const onAbort = () => {
      if (threadId && turnId) write({ id: ++nextId, method: 'turn/interrupt', params: { threadId, turnId } })
      setTimeout(() => end('aborted', 'stopped by user'), 1500).unref()
    }
    if (o.signal?.aborted) onAbort()
    else o.signal?.addEventListener('abort', onAbort, { once: true })

    const rel = (p: string) => (p.startsWith(o.cwd) ? relative(o.cwd, p) || p : p)

    const item = (m: Rpc, started: boolean) => {
      const it = m.params?.item
      if (!it) return
      const out: TeamEvent[] = []
      if (it.type === 'agentMessage' && !started) {
        lastText = String(it.text ?? '')
        if (it.phase === 'final_answer') finalText = lastText
        out.push({ type: 'text', agent: 'codex', text: lastText })
      } else if (it.type === 'commandExecution') {
        if (started) out.push({ type: 'tool', agent: 'codex', id: it.id, kind: 'command', name: 'shell', summary: unwrapShell(String(it.command ?? '')).slice(0, 200) })
        else out.push({ type: 'tool_result', agent: 'codex', id: it.id, ok: it.exitCode === 0, text: String(it.aggregatedOutput ?? '').slice(0, 4000) })
      } else if (it.type === 'fileChange') {
        if (started) out.push({ type: 'tool', agent: 'codex', id: it.id, kind: 'edit', name: 'apply_patch', summary: (it.changes ?? []).map((c: any) => `${c.kind?.type ?? c.kind} ${rel(String(c.path))}`).join(', ').slice(0, 200) })
        else out.push({ type: 'tool_result', agent: 'codex', id: it.id, ok: it.status === 'completed', text: '' })
      } else if (it.type === 'mcpToolCall' || it.type === 'webSearch') {
        const name = it.type === 'webSearch' ? 'web_search' : `${it.server}.${it.tool}`
        if (started) out.push({ type: 'tool', agent: 'codex', id: it.id, kind: it.type === 'webSearch' ? 'read' : 'other', name, summary: String(it.query ?? JSON.stringify(it.arguments ?? {})).slice(0, 200) })
        else out.push({ type: 'tool_result', agent: 'codex', id: it.id, ok: it.status !== 'failed' && !it.error, text: JSON.stringify(it.result ?? it.error ?? '').slice(0, 2000) })
      }
      for (const e of out) push(e)
    }

    const handle = async (m: Rpc) => {
      // answers to our requests
      if (m.id !== undefined && !m.method) {
        const w = waiting.get(m.id as number)
        waiting.delete(m.id as number)
        if (w) m.error ? w.fail(new Error(m.error.message)) : w.ok(m.result)
        return
      }
      // requests from the server: approvals are decided by the caller, anything else is refused so the agent never hangs
      if (m.id !== undefined && m.method) {
        if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
          const p = m.params ?? {}
          const files = m.method.includes('fileChange')
          const yes = o.onApproval ? await o.onApproval({ kind: files ? 'files' : 'command', title: files ? 'Codex wants to change files outside its folder' : `Codex wants to run: ${unwrapShell(String(p.command ?? '')).slice(0, 200)}`, detail: String(p.reason ?? ''), command: p.command ?? undefined }) : false
          write({ id: m.id, result: { decision: yes ? 'accept' : 'decline' } })
        } else write({ id: m.id, error: { code: -32601, message: 'Forge does not handle this request' } })
        return
      }
      switch (m.method) {
        case 'turn/started':
          turnId = m.params?.turn?.id ?? turnId
          return
        case 'item/started':
          return item(m, true)
        case 'item/completed':
          return item(m, false)
        case 'thread/tokenUsage/updated': {
          const t = m.params?.tokenUsage
          if (!t?.total) return
          const cur = { input: t.total.inputTokens ?? 0, output: (t.total.outputTokens ?? 0) + (t.total.reasoningOutputTokens ?? 0), cached: t.total.cachedInputTokens ?? 0 }
          baseline ??= { input: cur.input - (t.last?.inputTokens ?? 0), output: cur.output - ((t.last?.outputTokens ?? 0) + (t.last?.reasoningOutputTokens ?? 0)), cached: cur.cached - (t.last?.cachedInputTokens ?? 0) }
          latest = cur
          return
        }
        case 'account/rateLimits/updated': {
          const r = m.params?.rateLimits
          if (r?.primary) push({ type: 'limits', agent: 'codex', primaryPct: r.primary.usedPercent ?? 0, primaryResetsAt: r.primary.resetsAt, secondaryPct: r.secondary?.usedPercent, secondaryResetsAt: r.secondary?.resetsAt })
          return
        }
        case 'turn/completed': {
          const turn = m.params?.turn
          if (turn?.status === 'failed') {
            const msg = String(turn.error?.message ?? 'the turn failed')
            return end(classifyError(msg), msg.slice(0, 500))
          }
          if (turn?.status === 'interrupted') return end('aborted', 'interrupted')
          return end(null)
        }
        case 'error': {
          const msg = String(m.params?.error?.message ?? m.params?.message ?? 'error')
          if (m.params?.willRetry) return void push({ type: 'note', agent: 'codex', text: msg.slice(0, 300) })
          return end(classifyError(msg), msg.slice(0, 500))
        }
      }
    }

    child.stdout.on('data', (d: Buffer) => {
      poke()
      buf += d.toString()
      let i: number
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          void handle(JSON.parse(line)).catch(() => {})
        } catch {}
      }
    })
    let tail = ''
    child.stderr.on('data', (d: Buffer) => (poke(), (tail = (tail + d.toString()).slice(-1500))))
    child.stdin.on('error', () => {})
    child.on('error', (e: NodeJS.ErrnoException) => end(e.code === 'ENOENT' ? 'missing' : 'other', e.code === 'ENOENT' ? `${bin} is not installed or not on PATH` : e.message))
    child.on('close', (code) => {
      if (!sink.done) end(code === 0 ? 'protocol' : classifyError(tail), tail.trim().slice(-400) || `codex app-server exited with code ${code}`)
      else finish()
    })

    // ---- the conversation
    void (async () => {
      try {
        await request('initialize', { clientInfo: { name: 'forge', title: 'Forge', version: '0.1.0' } })
        write({ method: 'initialized' })
        const common = { cwd: o.cwd, model: o.model, sandbox: o.write ? 'workspace-write' : 'read-only', approvalPolicy: 'on-request' }
        const started = await request(o.resume ? 'thread/resume' : 'thread/start', o.resume ? { threadId: o.resume, ...common } : common)
        threadId = started.thread.id
        push({ type: 'session', agent: 'codex', sessionId: threadId })
        const t = request('turn/start', { threadId, input: [{ type: 'text', text: o.prompt }] })
        o.onHandle?.({
          steer: async (text) => {
            if (!turnId) return false
            try {
              await request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] })
              return true
            } catch {
              return false
            }
          },
          interrupt: () => onAbort(),
        })
        turnId = (await t).turn.id
      } catch (e) {
        end(sink.res.error ? null : 'protocol', `app-server: ${(e as Error).message}`)
      }
    })()
  })
}
