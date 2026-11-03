import { execFile } from 'node:child_process'
import { cleanEnv } from './process'
import type { AgentName } from './events'

export type Health = { agent: AgentName; ok: boolean; detail: string; fix?: string; version?: string }

const run = (bin: string, args: string[]): Promise<{ ok: boolean; out: string; missing: boolean }> =>
  new Promise((resolve) =>
    execFile(bin, args, { env: cleanEnv(), timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) =>
      resolve({ ok: !err, out: String(out) + String(stderr), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' }),
    ),
  )

// Is the agent installed, and signed in with the user's own account? Checked with the same cleaned environment the runs use,
// because that is what decides whether a run works (a login that only exists inside another app's session does not count).
export async function checkClaude(bin = 'claude'): Promise<Health> {
  const v = await run(bin, ['--version'])
  if (v.missing) return { agent: 'claude', ok: false, detail: 'Claude Code is not installed.', fix: 'Install it from https://claude.com/claude-code, then run `claude auth login`.' }
  const version = v.out.trim().split('\n')[0]
  const s = await run(bin, ['auth', 'status'])
  let logged = false
  let method = ''
  try {
    const j = JSON.parse(s.out)
    logged = !!j.loggedIn
    method = String(j.authMethod ?? '')
  } catch {}
  return logged
    ? { agent: 'claude', ok: true, detail: `signed in (${method})`, version }
    : { agent: 'claude', ok: false, detail: 'Claude Code is not signed in on this computer.', fix: 'Run `claude auth login` in a terminal and finish the sign-in, then try again.', version }
}

export async function checkCodex(bin = 'codex'): Promise<Health> {
  const v = await run(bin, ['--version'])
  if (v.missing) return { agent: 'codex', ok: false, detail: 'Codex is not installed.', fix: 'Install it with `npm i -g @openai/codex`, then run `codex login`.' }
  const version = v.out.trim().split('\n')[0]
  const s = await run(bin, ['login', 'status'])
  return /logged in/i.test(s.out) && !/not logged in/i.test(s.out)
    ? { agent: 'codex', ok: true, detail: s.out.trim().split('\n')[0], version }
    : { agent: 'codex', ok: false, detail: 'Codex is not signed in.', fix: 'Run `codex login` and choose "Sign in with ChatGPT".', version }
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

export const checkTeamTools = () => Promise.all([checkClaude(), checkCodex()])
