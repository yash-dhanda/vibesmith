import { makeCodexParser } from './codexStream'
import { codexLeanArgs, codexMcpArgs, type TeamLink } from './link'
import { runCli, type RunOpts, type RunResult } from './process'

export type CodexOpts = RunOpts & {
  write: boolean // false: read-only sandbox
  model: string // always pinned: the default in the user's config.toml may not exist on a ChatGPT plan
  resume?: string // thread id from an earlier run
  web?: boolean // live web search
  images?: string[] // pictures shown to the model with the prompt
  effort?: string // reasoning effort: low, medium, high or xhigh
  team?: TeamLink // attaches the team MCP server (mailbox, approvals)
}

// Codex exec cannot ask for approval while it runs, so the sandbox is the gate: it may write inside the working tree only, with no network.
export function codexArgs(o: CodexOpts): string[] {
  const sandbox = o.write ? 'workspace-write' : 'read-only'
  const mcp = o.team ? codexMcpArgs(o.team) : []
  const pics = (o.images ?? []).flatMap((p) => ['-i', p])
  const web = o.web === true ? ['-c', 'web_search="live"'] : o.web === false ? ['-c', 'web_search="disabled"'] : [] // codex 0.153 searches the web unless told not to
  const effort = o.effort ? ['-c', `model_reasoning_effort="${o.effort}"`] : []
  if (o.resume) return ['exec', 'resume', o.resume, '--json', '-m', o.model, '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"', ...effort, ...web, ...pics, ...codexLeanArgs(), ...mcp, '-']
  return ['exec', '--json', '-C', o.cwd, '-s', sandbox, '-m', o.model, '-c', 'approval_policy="never"', ...effort, ...web, ...pics, ...codexLeanArgs(), ...mcp, '-']
}

export const runCodex = (o: CodexOpts, bin = 'codex'): Promise<RunResult> => runCli('codex', bin, codexArgs(o), makeCodexParser(o.cwd), o)
