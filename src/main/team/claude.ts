import { makeClaudeParser } from './claudeStream'
import { runCli, type RunOpts, type RunResult } from './process'

export type ClaudeOpts = RunOpts & {
  write: boolean // false: plan mode, nothing is changed
  model?: string
  resume?: string // session id from an earlier run
  systemAppend?: string
  mcpConfig?: string // path to an MCP config file (the Forge team server)
  allow?: string[]
  deny?: string[]
}

// What a build task may run without asking. Anything else is denied in a headless run, which is the point: it comes back as a failed
// tool call the orchestrator can turn into an approval request.
export const CLAUDE_ALLOW = ['Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(python3 *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(mkdir *)']
// Never, in any role. Pushing, deploying, secrets and destructive shell stay with the user.
export const CLAUDE_DENY = ['Bash(git push *)', 'Bash(sudo *)', 'Bash(rm -rf *)', 'Bash(curl *)', 'Bash(wget *)', 'Bash(npm publish *)', 'Bash(docker push *)', 'Bash(vercel *)', 'Bash(terraform apply *)', 'Bash(kubectl *)', 'Read(./.env*)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)']

export function claudeArgs(o: ClaudeOpts): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', o.write ? 'acceptEdits' : 'plan']
  if (o.model) a.push('--model', o.model)
  if (o.resume) a.push('--resume', o.resume)
  if (o.systemAppend) a.push('--append-system-prompt', o.systemAppend)
  if (o.mcpConfig) a.push('--mcp-config', o.mcpConfig)
  const allow = o.allow ?? (o.write ? CLAUDE_ALLOW : [])
  if (allow.length) a.push('--allowedTools', allow.join(','))
  a.push('--disallowedTools', (o.deny ?? CLAUDE_DENY).join(','))
  return a
}

export const runClaude = (o: ClaudeOpts, bin = 'claude'): Promise<RunResult> => runCli('claude', bin, claudeArgs(o), makeClaudeParser(), o)
