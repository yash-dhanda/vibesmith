import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runClaude } from './claude'
import { runCodex } from './codex'
import { runCodexServer } from './codexServer'
import { hubBusy } from './hub'
import { claudeMcpConfig } from './link'
import { runLocal } from './local'
import type { AgentRunner } from './orchestrator'
import type { RunResult } from './process'

const MAX_MS = 3 * 3600_000 // ceiling for one agent turn

// The real agents. The Claude MCP config holds the hub secret, so it goes in a private temp file that is removed after the run.
export const realRunner: AgentRunner = async (agent, o): Promise<RunResult> => {
  // An approval or a question can wait for the user for hours (and a build for longer than the default half hour), so the limits stand still while one is pending.
  const link = o.link
  const common = { cwd: o.cwd, prompt: o.prompt, signal: o.signal, onEvent: o.onEvent, write: o.write, resume: o.resume, maxMs: MAX_MS, hold: link ? () => hubBusy(link.runId, link.taskId) : undefined }
  if (agent === 'local') return runLocal({ cwd: o.cwd, prompt: o.prompt, model: o.model ?? '', write: o.write, signal: o.signal, onEvent: o.onEvent, ask: o.onApproval })
  if (agent === 'codex') {
    const model = o.model ?? ''
    if (o.codexMode === 'app-server') {
      const r = await runCodexServer({ ...common, model, effort: o.effort, web: o.web, images: o.images, team: o.link ?? undefined, onApproval: o.onApproval, onHandle: o.onHandle })
      // app-server is experimental: if it could not even start a conversation, do the same job through exec
      const started = r.events.some((e) => e.type === 'text' || e.type === 'tool')
      if (r.error?.kind !== 'protocol' || started) return r
      o.onEvent({ type: 'note', agent: 'codex', text: `Codex app-server did not start (${r.error.message.slice(0, 120)}); using codex exec.` })
    }
    return runCodex({ ...common, model, effort: o.effort, web: o.web, images: o.images, team: o.link ?? undefined })
  }
  if (!o.link) return runClaude({ ...common, model: o.model, effort: o.effort, addDirs: o.addDirs, web: o.web })
  const dir = mkdtempSync(join(tmpdir(), 'forge-mcp-'))
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, claudeMcpConfig(o.link), { mode: 0o600 })
  try {
    return await runClaude({ ...common, model: o.model, effort: o.effort, addDirs: o.addDirs, web: o.web, mcpConfig, team: o.link })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
