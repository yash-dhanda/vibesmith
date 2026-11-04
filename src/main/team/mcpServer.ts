import { connect, type Socket } from 'node:net'

// The MCP server each agent starts (over stdio) to reach the team. It holds no state: every tool is one request to the Forge hub.
// Hand-written JSON-RPC, because the protocol surface is tiny and a dependency would have to ship inside the app.

type Json = Record<string, unknown>
const str = (description: string) => ({ type: 'string', description })

export const TOOLS = [
  { name: 'team_post', description: 'Send a message to a teammate ("claude", "codex") or everyone ("all"): a finding, a question, a decision or a note.', inputSchema: { type: 'object', properties: { to: str('claude, codex or all'), kind: { type: 'string', enum: ['finding', 'question', 'review', 'decision', 'note'] }, body: str('the message') }, required: ['body'] } },
  { name: 'team_inbox', description: 'Read the messages teammates and the user sent you that you have not seen yet.', inputSchema: { type: 'object', properties: {} } },
  { name: 'team_context', description: 'Search the team\'s shared memory (decisions, findings, problems met earlier on this project) for something relevant.', inputSchema: { type: 'object', properties: { query: str('what you want to know') }, required: ['query'] } },
  { name: 'team_decision', description: 'Record a decision the whole team must follow (a name, an API shape, a library choice).', inputSchema: { type: 'object', properties: { text: str('the decision') }, required: ['text'] } },
  { name: 'team_handoff', description: 'At the end of your task, say what the next task needs to know: files, names, how to run it, what is left.', inputSchema: { type: 'object', properties: { notes: str('the handoff') }, required: ['notes'] } },
  { name: 'team_request_approval', description: 'Ask the user before anything destructive, any deployment, or anything that needs a secret. Waits for the answer and returns "allowed" or "denied".', inputSchema: { type: 'object', properties: { title: str('one line'), detail: str('what exactly and why') }, required: ['title'] } },
  { name: 'team_ask', description: 'Ask the user a question and wait for the answer. Use it only when the answer really changes the work and you cannot find it in the project or decide sensibly yourself. Give 2 to 4 short options when there are clear choices; the user can also type their own answer. Ask at most one question at a time.', inputSchema: { type: 'object', properties: { question: str('one clear question'), options: { type: 'array', description: 'short choices, each with an optional one-line description', items: { type: 'object', properties: { label: str('the choice'), description: str('one line on what it means') }, required: ['label'] } }, multi: { type: 'boolean', description: 'true if the user may pick more than one option' } }, required: ['question'] } },
  { name: 'team_propose_subtask', description: 'Hand a separate piece of work to the team (for example a test suite someone else should write). It runs independently of your task.', inputSchema: { type: 'object', properties: { title: str('short title'), goal: str('what to do'), agent: str('claude or codex, optional'), acceptance: { type: 'array', items: { type: 'string' } } }, required: ['title', 'goal'] } },
  { name: 'team_tasks', description: 'See every task of this run and its status.', inputSchema: { type: 'object', properties: {} } },
  { name: 'team_permission', description: 'Internal: answers Claude Code\'s permission prompts.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] } },
]

export type Call = (op: string, args: Json) => Promise<unknown>

// One JSON-RPC message in, the reply out (or null for a notification).
export async function handleRpc(msg: { id?: number | string; method?: string; params?: any }, call: Call): Promise<Json | null> {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  if (msg.id === undefined) return null // notifications/initialized and friends need no answer
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'forge_team', version: '1' } })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOLS })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool ${name}`)
      try {
        const r = await call(name.replace(/^team_/, ''), msg.params?.arguments ?? {})
        return ok({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] })
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true })
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`)
  }
}

// A caller that talks to the hub over one socket, matching replies to requests by id.
export function hubCaller(sock: string, token: string, ctx: { runId: string; taskId: string; agent: string }): Call {
  let socket: Socket | null = null
  let next = 1
  const waiting = new Map<number, (r: { ok: boolean; result?: unknown; error?: string }) => void>()
  let buf = ''
  const open = () =>
    new Promise<Socket>((resolve, reject) => {
      if (socket && !socket.destroyed) return resolve(socket)
      const s = connect(sock)
      s.once('error', reject)
      s.once('connect', () => {
        socket = s
        s.on('data', (d) => {
          buf += d.toString()
          let i: number
          while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            try {
              const r = JSON.parse(line)
              waiting.get(r.id)?.(r)
              waiting.delete(r.id)
            } catch {}
          }
        })
        s.on('close', () => {
          for (const w of waiting.values()) w({ ok: false, error: 'Forge closed the connection' })
          waiting.clear()
        })
        resolve(s)
      })
    })
  return async (op, args) => {
    const s = await open()
    const id = next++
    const reply = new Promise<{ ok: boolean; result?: unknown; error?: string }>((r) => waiting.set(id, r))
    s.write(JSON.stringify({ id, token, op, args, ctx }) + '\n')
    const r = await reply
    if (!r.ok) throw new Error(r.error ?? 'failed')
    return r.result
  }
}

export function serveStdio(env: NodeJS.ProcessEnv = process.env) {
  const call = hubCaller(env.FORGE_TEAM_SOCK ?? '', env.FORGE_TEAM_TOKEN ?? '', { runId: env.FORGE_RUN ?? '', taskId: env.FORGE_TASK ?? '', agent: env.FORGE_AGENT ?? '' })
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d.toString()
    let i: number
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      void handleRpc(msg, call).then((r) => r && process.stdout.write(JSON.stringify(r) + '\n'))
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
