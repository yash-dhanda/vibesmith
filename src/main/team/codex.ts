import { makeCodexParser } from './codexStream'
import { codexMcpArgs, type TeamLink } from './link'
import { runCli, type RunOpts, type RunResult } from './process'

export type CodexOpts = RunOpts & {
  write: boolean // false: read-only sandbox
  model: string // always pinned: the default in the user's config.toml may not exist on a ChatGPT plan
  resume?: string // thread id from an earlier run
  team?: TeamLink // attaches the team MCP server (mailbox, approvals)
}

// Codex exec cannot ask for approval while it runs, so the sandbox is the gate: it may write inside the working tree only, with no network.
export function codexArgs(o: CodexOpts): string[] {
  const sandbox = o.write ? 'workspace-write' : 'read-only'
  const mcp = o.team ? codexMcpArgs(o.team) : []
  if (o.resume) return ['exec', 'resume', o.resume, '--json', '-m', o.model, '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"', ...mcp, '-']
  return ['exec', '--json', '-C', o.cwd, '-s', sandbox, '-m', o.model, '-c', 'approval_policy="never"', ...mcp, '-']
}

export const runCodex = (o: CodexOpts, bin = 'codex'): Promise<RunResult> => runCli('codex', bin, codexArgs(o), makeCodexParser(o.cwd), o)
