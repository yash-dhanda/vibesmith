import { execFile, spawn } from 'node:child_process'
import { resolveCommand } from './bin'
import { cleanEnv } from './process'
import type { AgentName } from './events'
import { sortByQuality } from '../catalog'
import { ollamaStatus } from '../ollama'

export type Health = { agent: AgentName; ok: boolean; detail: string; fix?: string; version?: string }

const run = (bin: string, args: string[]): Promise<{ ok: boolean; out: string; missing: boolean }> => {
  const c = resolveCommand(bin, args)
  return new Promise((resolve) =>
    execFile(c.cmd, c.args, { env: cleanEnv(process.env, c.env), timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) =>
      resolve({ ok: !err, out: String(out) + String(stderr), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' }),
    ),
  )
}

// Is the agent installed, and signed in with the user's own account? Checked with the same cleaned environment the runs use,
// because that is what decides whether a run works (a login that only exists inside another app's session does not count).
export async function checkClaude(bin = 'claude'): Promise<Health> {
  const v = await run(bin, ['--version'])
  if (v.missing) return { agent: 'claude', ok: false, detail: 'Claude Code is not installed.', fix: 'Install it from https://claude.com/claude-code, then run `claude auth login`.' }
  const version = v.out.trim().split('\n')[0]
  const s = await run(bin, ['auth', 'status'])
  const a = judgeClaudeAuth(s.out)
  return a.ok ? { agent: 'claude', ok: true, detail: a.detail, version } : { agent: 'claude', ok: false, detail: a.detail, fix: a.fix, version }
}

// Forge runs on the user's subscription plans, never on pay-per-token API billing, so a CLI signed in with an API key is refused.
export function judgeClaudeAuth(statusJson: string): { ok: boolean; detail: string; fix?: string } {
  let j: { loggedIn?: boolean; authMethod?: string } = {}
  try {
    j = JSON.parse(statusJson)
  } catch {}
  if (!j.loggedIn) return { ok: false, detail: 'Claude Code is not signed in on this computer.', fix: 'Run `claude auth login` in a terminal and sign in with your Claude account, then try again.' }
  if (j.authMethod && j.authMethod !== 'claude.ai') return { ok: false, detail: `Claude Code is signed in with ${j.authMethod}, which bills per use instead of using your Claude plan.`, fix: 'Run `claude auth logout`, then `claude auth login` and choose your Claude account (not an API key).' }
  return { ok: true, detail: 'signed in with your Claude plan' }
}

export function judgeCodexAuth(statusText: string): { ok: boolean; detail: string; fix?: string } {
  const t = statusText.split('\n').find((l) => /logged in/i.test(l))?.trim() ?? '' // not the first line: codex may print a warning before it
  if (!/logged in/i.test(statusText) || /not logged in/i.test(statusText)) return { ok: false, detail: 'Codex is not signed in.', fix: 'Run `codex login` and choose "Sign in with ChatGPT".' }
  if (/api key/i.test(t)) return { ok: false, detail: 'Codex is signed in with an API key, which bills per use instead of using your ChatGPT plan.', fix: 'Run `codex logout`, then `codex login` and choose "Sign in with ChatGPT".' }
  return { ok: true, detail: t || 'signed in with your ChatGPT plan' }
}

export async function checkCodex(bin = 'codex'): Promise<Health> {
  const v = await run(bin, ['--version'])
  if (v.missing) return { agent: 'codex', ok: false, detail: 'Codex is not installed.', fix: 'Install it with `npm i -g @openai/codex`, then run `codex login`.' }
  const version = v.out.trim().split('\n')[0]
  const s = await run(bin, ['login', 'status'])
  const a = judgeCodexAuth(s.out)
  return a.ok ? { agent: 'codex', ok: true, detail: a.detail, version } : { agent: 'codex', ok: false, detail: a.detail, fix: a.fix, version }
}

// The models this account can pick, from Codex's own catalog. A model the plan does not include fails at run time, so Forge pins one from this list.
export async function codexModels(bin = 'codex'): Promise<string[]> {
  const r = await run(bin, ['debug', 'models'])
  try {
    const j = JSON.parse(r.out)
    const list: { slug?: string; visibility?: string }[] = Array.isArray(j) ? j : j.models ?? []
    return list.filter((m) => m.slug && m.visibility === 'list').map((m) => m.slug!)
  } catch {
    return []
  }
}

// The local agent runs on Ollama: free, offline, and uses no subscription. It is ready when the server is up and has a model that is not an embedding model.
export async function localModels(): Promise<string[]> {
  const s = await ollamaStatus()
  return sortByQuality(s.models.filter((m) => !/embed/i.test(m)))
}
export async function checkLocal(): Promise<Health> {
  const s = await ollamaStatus()
  if (!s.up) return { agent: 'local', ok: false, detail: 'Ollama is not running.', fix: 'Start it with `ollama serve`, then pull a model, for example `ollama pull qwen3:8b`.' }
  const models = s.models.filter((m) => !/embed/i.test(m))
  if (!models.length) return { agent: 'local', ok: false, detail: 'Ollama has no model yet.', fix: 'Pull one, for example `ollama pull qwen3:8b`.' }
  return { agent: 'local', ok: true, detail: `${models.length} model${models.length === 1 ? '' : 's'} installed` }
}

export const checkTeamTools = () => Promise.all([checkClaude(), checkCodex(), checkLocal()])

export type LimitInfo = { primaryPct: number; primaryResetsAt?: number; secondaryPct?: number; secondaryResetsAt?: number; plan?: string }

// How much of the ChatGPT plan's allowance is used right now, asked of Codex itself (no model call, so it costs nothing).
export function codexLimits(bin = 'codex', timeoutMs = 12_000): Promise<LimitInfo | null> {
  return new Promise((resolve) => {
    const c = resolveCommand(bin, ['app-server'])
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(c.cmd, c.args, { env: cleanEnv(process.env, c.env), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      return resolve(null)
    }
    let buf = ''
    let done = false
    const end = (v: LimitInfo | null) => {
      if (done) return
      done = true
      clearTimeout(t)
      child.kill()
      resolve(v)
    }
    const t = setTimeout(() => end(null), timeoutMs)
    const send = (m: object) => child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    child.on('error', () => end(null))
    child.on('close', () => end(null))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try {
          const m = JSON.parse(line)
          if (m.id === 1) {
            send({ method: 'initialized' })
            send({ id: 2, method: 'account/rateLimits/read', params: {} })
          } else if (m.id === 2) {
            const r = m.result?.rateLimits
            end(r?.primary ? { primaryPct: r.primary.usedPercent ?? 0, primaryResetsAt: r.primary.resetsAt, secondaryPct: r.secondary?.usedPercent, secondaryResetsAt: r.secondary?.resetsAt, plan: r.planType } : null)
          }
        } catch {}
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'forge', title: 'Forge', version: '0.1.0' } } })
  })
}
