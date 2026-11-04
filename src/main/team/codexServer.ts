import { spawn } from 'node:child_process'
import { codexLeanArgs, codexMcpArgs, type TeamLink } from './link'
import type { ErrorKind, TeamEvent } from './events'
import { classifyError } from './events'
import { resolveCommand } from './bin'
import { cleanEnv, makeSink, stopTree, type RunOpts, type RunResult } from './process'
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
  effort?: string
  web?: boolean
  images?: string[]
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

    const cmd = resolveCommand(bin, ['app-server', ...(o.web === true ? ['-c', 'web_search="live"'] : o.web === false ? ['-c', 'web_search="disabled"'] : []), ...codexLeanArgs(), ...(o.team ? codexMcpArgs(o.team) : [])])
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
      stopTree(child)
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

    // Codex prints nothing while an approval or an MCP question waits for a person: that is not being stuck.
    let asking = 0
    const held = () => asking > 0 || !!o.hold?.()
    const idleMs = o.idleMs ?? 300_000
    const maxMs = o.maxMs ?? 1_800_000
    const onIdle = () => (held() ? poke() : end('timeout', `no output for ${Math.round(idleMs / 1000)}s`))
    let idle = setTimeout(onIdle, idleMs)
    const poke = () => {
      clearTimeout(idle)
      idle = setTimeout(onIdle, idleMs)
    }
    const onMax = () => (held() ? (max = setTimeout(onMax, Math.min(maxMs, 60_000))) : end('timeout', `took longer than ${Math.round(maxMs / 60_000)} minutes`))
    let max = setTimeout(onMax, maxMs)
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
        for (const c of Array.isArray(it.changes) ? it.changes : []) if (c?.path && c.diff) out.push({ type: 'code', agent: 'codex', id: `${it.id}:${c.path}`, path: rel(String(c.path)), text: String(c.diff), kind: 'diff', done: !started })
        if (started) out.push({ type: 'tool', agent: 'codex', id: it.id, kind: 'edit', name: 'apply_patch', summary: (Array.isArray(it.changes) ? it.changes : []).map((c: any) => `${c.kind?.type ?? c.kind} ${rel(String(c.path))}`).join(', ').slice(0, 200) })
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
          // Only a plain yes from the caller accepts, and only this one request (never 'acceptForSession' or a grantRoot): no answer, a no or a failure all decline.
          let yes = false
          asking++
          try {
            yes = o.write && o.onApproval ? (await o.onApproval({ kind: files ? 'files' : 'command', title: files ? 'Codex wants to change files outside its folder' : `Codex wants to run: ${unwrapShell(String(p.command ?? '')).slice(0, 200)}`, detail: String(p.reason ?? ''), command: p.command ?? undefined })) === true : false
          } catch {}
          asking--
          write({ id: m.id, result: { decision: yes ? 'accept' : 'decline' } })
        } else write({ id: m.id, error: { code: -32601, message: 'Forge does not handle this request' } })
        return
      }
      switch (m.method) {
        case 'item/agentMessage/delta':
          return void (m.params?.delta && push({ type: 'delta', agent: 'codex', channel: 'text', id: m.params.itemId, text: String(m.params.delta) }))
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta':
          return void (m.params?.delta && push({ type: 'delta', agent: 'codex', channel: 'thinking', id: m.params.itemId, text: String(m.params.delta) }))
        case 'item/commandExecution/outputDelta':
          return void (m.params?.delta && push({ type: 'delta', agent: 'codex', channel: 'output', id: m.params.itemId, text: String(m.params.delta) }))
        case 'item/fileChange/patchUpdated': {
          const changes: any[] = m.params?.changes ?? m.params?.item?.changes ?? []
          for (const c of changes) if (c?.path) push({ type: 'code', agent: 'codex', id: `${m.params?.itemId ?? 'f'}:${c.path}`, path: rel(String(c.path)), text: String(c.diff ?? ''), kind: 'diff', done: false })
          return
        }
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

    child.stdout.setEncoding('utf8') // a character split across two reads stays whole
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      poke()
      buf += d
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
    child.stderr.on('data', (d: string) => (poke(), (tail = (tail + d).slice(-1500))))
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
        // A read-only run never leaves its sandbox: with 'never' the sandbox is the gate (as in exec) and nothing can be approved into a write.
        const common = { cwd: o.cwd, model: o.model, sandbox: o.write ? 'workspace-write' : 'read-only', approvalPolicy: o.write ? 'on-request' : 'never' }
        const started = await request(o.resume ? 'thread/resume' : 'thread/start', o.resume ? { threadId: o.resume, ...common } : common)
        threadId = started.thread.id
        push({ type: 'session', agent: 'codex', sessionId: threadId })
        const t = request('turn/start', { threadId, input: [{ type: 'text', text: o.prompt }, ...(o.images ?? []).map((path) => ({ type: 'localImage', path }))], ...(o.effort ? { effort: o.effort } : {}) })
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
