import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runClaude } from './claude'
import { runCodex } from './codex'
import { runCodexServer } from './codexServer'
import { claudeMcpConfig } from './link'
import type { AgentRunner } from './orchestrator'
import type { RunResult } from './process'

// The real agents. The Claude MCP config holds the hub secret, so it goes in a private temp file that is removed after the run.
export const realRunner: AgentRunner = async (agent, o): Promise<RunResult> => {
  const common = { cwd: o.cwd, prompt: o.prompt, signal: o.signal, onEvent: o.onEvent, write: o.write, resume: o.resume }
  if (agent === 'codex') {
    const model = o.model ?? ''
    if (o.codexMode === 'app-server') {
      const r = await runCodexServer({ ...common, model, team: o.link ?? undefined, onApproval: o.onApproval, onHandle: o.onHandle })
      // app-server is experimental: if it could not even start a conversation, do the same job through exec
      const started = r.events.some((e) => e.type === 'text' || e.type === 'tool')
      if (r.error?.kind !== 'protocol' || started) return r
      o.onEvent({ type: 'note', agent: 'codex', text: `Codex app-server did not start (${r.error.message.slice(0, 120)}); using codex exec.` })
    }
    return runCodex({ ...common, model, team: o.link ?? undefined })
  }
  if (!o.link) return runClaude({ ...common, model: o.model })
  const dir = mkdtempSync(join(tmpdir(), 'forge-mcp-'))
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, claudeMcpConfig(o.link), { mode: 0o600 })
  try {
    return await runClaude({ ...common, model: o.model, mcpConfig, team: o.link })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
