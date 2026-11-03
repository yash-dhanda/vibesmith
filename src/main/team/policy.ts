import { isAbsolute, relative, resolve } from 'node:path'
import { blocked } from '../agent/commands'

// What an agent may do without asking. Used when Claude Code asks permission for a tool call (through the team MCP server),
// and by the orchestrator for the commands it runs itself. deny = never; ask = a person decides; allow = go ahead.
export type Verdict = { verdict: 'allow' | 'ask' | 'deny'; reason: string }

const NEVER: [RegExp, string][] = [
  [/\bgit\s+push\b/, 'agents never push; the team merges and you apply the result'],
  [/\bsudo\b/, 'sudo is never allowed'],
  [/\bgit\s+(remote\s+(add|set-url)|config\s+--global)\b/, 'changing git remotes or global config is not allowed'],
]
const DEPLOY: [RegExp, string][] = [
  [/\b(npm|pnpm|yarn)\s+publish\b/, 'publishes a package'],
  [/\bdocker\s+(push|login)\b/, 'pushes or logs in to a container registry'],
  [/\b(vercel|netlify|firebase|flyctl|fly|heroku|wrangler|railway|serverless|sls)\b[^|;&]*\b(deploy|publish|release|up)\b/, 'deploys the project'],
  [/\b(terraform|pulumi)\s+(apply|destroy|up)\b/, 'changes cloud infrastructure'],
  [/\bkubectl\s+(apply|delete|replace|patch|rollout|scale)\b/, 'changes a cluster'],
  [/\b(aws|gcloud|az)\b[^|;&]*\b(deploy|delete|rm|terminate|put|create|update)\b/, 'changes cloud resources'],
  [/\b(ssh|scp|sftp|rsync)\b[^|;&]*@/, 'connects to another machine'],
]
const DESTRUCTIVE: [RegExp, string][] = [
  [/\brm\s+(-\w+\s+)*-\w*[rf]/, 'deletes files recursively or by force'],
  [/\b(drop\s+(table|database)|truncate\s+table)\b/i, 'deletes database data'],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|branch\s+-D|stash\s+drop)\b/, 'throws away work in git'],
  [/\b(mkfs|dd\s+if=|chmod\s+-R|chown\s+-R)\b/, 'changes the system'],
]
const NETWORK = /\b(curl|wget|nc|ncat)\b/
const SECRET_NAMES = String.raw`(?:\.env(?:\.(?!example|sample|template)[\w.]+)?|\.ssh|\.aws|\.gnupg|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519|ecdsa)|[\w.-]+\.(?:pem|key|p12|pfx)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))`
const SENSITIVE = new RegExp(String.raw`(?:^|/)${SECRET_NAMES}(?:/|$)`, 'i') // a path
const SENSITIVE_IN_COMMAND = new RegExp(String.raw`(?:^|[\s/'"=:])${SECRET_NAMES}(?:[\s/'";|&]|$)`, 'i')

export function decideCommand(cmd: string): Verdict {
  const hard = blocked(cmd)
  if (hard) return { verdict: 'deny', reason: hard }
  for (const [re, why] of NEVER) if (re.test(cmd)) return { verdict: 'deny', reason: why }
  for (const [re, why] of DEPLOY) if (re.test(cmd)) return { verdict: 'ask', reason: `This ${why}.` }
  for (const [re, why] of DESTRUCTIVE) if (re.test(cmd)) return { verdict: 'ask', reason: `This ${why}.` }
  if (SENSITIVE_IN_COMMAND.test(cmd)) return { verdict: 'ask', reason: 'This touches a file that usually holds secrets.' }
  if (NETWORK.test(cmd)) return { verdict: 'ask', reason: 'This downloads or sends data over the network.' }
  return { verdict: 'allow', reason: '' }
}

// A tool call from Claude Code: { tool_name, input }. `worktree` is the agent's own folder.
export function decideTool(tool: string, input: Record<string, unknown>, worktree: string): Verdict {
  if (tool === 'Bash') return decideCommand(String(input.command ?? ''))
  const path = String(input.file_path ?? input.path ?? input.notebook_path ?? '')
  if (path && /^(Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep)$/.test(tool)) {
    const abs = isAbsolute(path) ? resolve(path) : resolve(worktree, path)
    const outside = relative(worktree, abs).startsWith('..')
    const writes = tool !== 'Read' && tool !== 'Glob' && tool !== 'Grep'
    if (SENSITIVE.test(abs)) return writes ? { verdict: 'deny', reason: 'agents may not write secrets or key files' } : { verdict: 'ask', reason: `Reading ${path} may expose a secret.` }
    if (outside) return writes ? { verdict: 'deny', reason: 'writes are limited to the task folder' } : { verdict: 'ask', reason: `Reading outside the project: ${path}` }
  }
  if (/^mcp__forge_team__/.test(tool)) return { verdict: 'allow', reason: '' }
  if (tool === 'WebFetch' || tool === 'WebSearch') return { verdict: 'allow', reason: '' }
  return { verdict: 'allow', reason: '' }
}
