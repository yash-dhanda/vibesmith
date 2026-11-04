import { makeClaudeParser } from './claudeStream'
import { linkEnv, PERMISSION_TOOL, SERVER, TOOL_TIMEOUT_SEC, type TeamLink } from './link'
import { runCli, type RunOpts, type RunResult } from './process'

export type ClaudeOpts = RunOpts & {
  write: boolean // false: plan mode, nothing is changed
  model?: string
  effort?: string
  resume?: string // session id from an earlier run
  systemAppend?: string
  web?: boolean // false: no WebSearch / WebFetch
  addDirs?: string[] // extra folders Claude may read, for example the skill libraries
  mcpConfig?: string // path to an MCP config file (the Forge team server)
  team?: TeamLink // when set, permission prompts are answered by Forge's policy and the user instead of being denied
  allow?: string[]
  deny?: string[]
}

// What a build task may run without asking. Anything else is denied in a headless run, which is the point: it comes back as a failed
// tool call the orchestrator can turn into an approval request.
export const CLAUDE_ALLOW = ['Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(python3 *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(mkdir *)']
// Never, in any role. With the team server attached, everything else risky (deploys, secrets, destructive commands) is not denied
// but sent to the policy, which asks the user. Without it, those are denied outright.
export const CLAUDE_DENY = ['Bash(git push *)', 'Bash(sudo *)', 'Bash(rm -rf /*)', 'Bash(rm -rf ~*)']
export const CLAUDE_DENY_NO_GATE = [...CLAUDE_DENY, 'Bash(curl *)', 'Bash(wget *)', 'Bash(npm publish *)', 'Bash(docker push *)', 'Bash(vercel *)', 'Bash(terraform apply *)', 'Bash(kubectl *)', 'Read(./.env*)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)']

export function claudeArgs(o: ClaudeOpts): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--setting-sources', 'project,local', '--permission-mode', o.write ? 'acceptEdits' : 'plan']
  if (o.model) a.push('--model', o.model)
  if (o.effort) a.push('--effort', o.effort)
  if (o.resume) a.push('--resume', o.resume)
  if (o.systemAppend) a.push('--append-system-prompt', o.systemAppend)
  if (o.addDirs?.length) a.push('--add-dir', ...o.addDirs)
  if (o.mcpConfig) a.push('--mcp-config', o.mcpConfig, '--strict-mcp-config')
  const allow = [...(o.allow ?? (o.write ? CLAUDE_ALLOW : [])), ...(o.web === true ? ['WebSearch', 'WebFetch'] : []), ...(o.team ? [`mcp__${SERVER}`] : [])]
  if (allow.length) a.push('--allowedTools', allow.join(','))
  if (o.team) a.push('--permission-prompt-tool', PERMISSION_TOOL)
  a.push('--disallowedTools', [...(o.deny ?? (o.team ? CLAUDE_DENY : CLAUDE_DENY_NO_GATE)), ...(o.web === false ? ['WebSearch', 'WebFetch'] : [])].join(','))
  return a
}

export const runClaude = (o: ClaudeOpts, bin = 'claude'): Promise<RunResult> =>
  runCli('claude', bin, claudeArgs(o), makeClaudeParser(o.cwd), o.team ? { ...o, env: { ...linkEnv(o.team), MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_SEC * 1000), ...o.env } } : o)
