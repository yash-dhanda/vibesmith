import { homedir, tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { blocked } from '../agent/commands'

// What an agent may do without asking. Used when Claude Code asks permission for a tool call (through the team MCP server),
// and by the orchestrator for the commands it runs itself. deny = never; ask = a person decides; allow = go ahead.
export type Verdict = { verdict: 'allow' | 'ask' | 'deny'; reason: string }

// Shell text split into commands and unquoted words, so git is judged by what it runs, not by the letters in a message or a grep pattern.
// Tokens, not one big regex: no backtracking on agent-supplied text, and `git "push"`, `git -ccore.pager=cat push`, `git -C . push` all read as push.
function segments(cmd: string): string[][] {
  const segs: string[][] = [[]]
  let w = ''
  let has = false
  let q = ''
  const push = () => {
    if (has) segs[segs.length - 1].push(w)
    w = ''
    has = false
  }
  const cut = () => {
    push()
    if (segs[segs.length - 1].length) segs.push([])
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (q) {
      if (c === q) q = ''
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) w += cmd[++i]
      else w += c
    } else if (c === '"' || c === "'") {
      q = c
      has = true
    } else if (c === '\\' && i + 1 < cmd.length && /[\s\\"';&|()$]/.test(cmd[i + 1])) {
      w += cmd[++i]
      has = true
    } else if (c === '\n' || /[;&|()`]/.test(c)) cut()
    else if (/\s/.test(c)) push()
    else {
      w += c
      has = true
    }
  }
  cut()
  return segs.filter((s) => s.length)
}

type GitCall = { sub: string; args: string[]; dirs: string[] }
const SHELLS = /^(sh|bash|zsh|dash|ksh|fish|eval)$/
// Every `git` word in the command, with its subcommand (after -C dir, -c k=v, --git-dir x, --no-pager ...) and the folders those options point at.
// Text inside a shell -c string or a $( ) is looked into too. A path or program built by the shell ($VAR) is not judged.
function gitCalls(cmd: string, depth = 0): GitCall[] {
  const out: GitCall[] = []
  for (const words of segments(cmd)) {
    const runsShell = words.some((w) => SHELLS.test(w.replace(/^.*\//, '')))
    for (let i = 0; i < words.length; i++) {
      if (depth < 3 && /\s|\$\(|`/.test(words[i]) && (runsShell || /\$\(|`/.test(words[i]))) out.push(...gitCalls(words[i], depth + 1))
      if (words[i].replace(/^.*\//, '') !== 'git') continue
      const dirs: string[] = []
      let sub = ''
      let alias = false
      let j = i + 1
      for (; j < words.length; j++) {
        const t = words[j]
        if (!t.startsWith('-')) {
          sub = t
          break
        }
        if (t === '-C' || t === '--git-dir' || t === '--work-tree') dirs.push(words[++j] ?? '')
        else if (t === '-c' || t === '--config-env') {
          if (/^alias\./i.test(words[++j] ?? '')) alias = true
        } else if (/^--(git-dir|work-tree)=/.test(t)) dirs.push(t.replace(/^[^=]*=/, ''))
        else if (/^-C./.test(t)) dirs.push(t.slice(2))
        else if (/^-c./.test(t) && /^alias\./i.test(t.slice(2))) alias = true
        else if (t === '--namespace' || t === '--super-prefix' || t === '--attr-source') j++
      }
      out.push({ sub: alias ? 'alias' : sub, args: words.slice(j + 1), dirs })
    }
  }
  return out
}

const SHARED = "agents may not touch the project's stash, branches, tags or git settings (they are shared with your own checkout)"
const shortFlag = (a: string, letters: string) => new RegExp(`^-[a-zA-Z]*[${letters}][a-zA-Z]*$`).test(a)
// `git config` writes: a key and a value, or an unset/edit/add flag. A key alone (user.name) and --get/--list are reads.
function configWrites(args: string[]): boolean {
  if (args.some((a) => /^(--unset(-all)?|--add|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(a))) return true
  const pos: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (/^(-f|--file|--blob|--type|--default)$/.test(args[i])) i++
    else if (!args[i].startsWith('-')) pos.push(args[i])
  }
  if (/^(set|unset|edit|rename-section|remove-section)$/.test(pos[0] ?? '')) return true
  if (args.some((a) => /^(--get\S*|--list|-l|--show-\S+|--name-only)$/.test(a)) || /^(get|list)$/.test(pos[0] ?? '')) return false
  return pos.length >= 2
}
// Task worktrees share the user's stash, branches, tags, reflog and repo config, so none of that may be touched from inside one.
function gitNever({ sub, args }: GitCall): string | null {
  if (sub === 'push') return 'agents never push; the team merges and you apply the result'
  if (sub === 'alias') return 'git aliases can hide a push; run the real command'
  if ((sub === 'remote' && /^(add|set-url|remove|rm|rename)$/.test(args[0] ?? '')) || (sub === 'config' && args.includes('--global') && configWrites(args))) return 'changing git remotes or global config is not allowed'
  if (/^(stash|update-ref|reflog|gc|prune|worktree|filter-branch|replace)$/.test(sub)) return SHARED
  if (sub === 'branch' && args.some((a) => shortFlag(a, 'dDmMf') || /^--(delete|move|force)$/.test(a))) return SHARED
  if (sub === 'tag' && args.some((a) => shortFlag(a, 'd') || a === '--delete')) return SHARED
  if (sub === 'config' && configWrites(args)) return SHARED
  if (sub === 'remote' && /^(set-head|set-branches|prune|update)$/.test(args[0] ?? '')) return SHARED
  return null
}
function gitDestructive({ sub, args }: GitCall): boolean {
  return (
    (sub === 'reset' && args.includes('--hard')) ||
    (sub === 'clean' && args.some((a) => shortFlag(a, 'f') || a === '--force')) ||
    (sub === 'checkout' && args.some((a) => a === '--' || a === '.')) ||
    (sub === 'restore' && !(args.includes('--staged') && !args.includes('--worktree')))
  )
}
const GIT_READS = /^(status|log|diff|show|ls-files|ls-tree|rev-parse|rev-list|blame|grep|cat-file|describe|shortlog|diff-tree|merge-base|name-rev|help|version)$/
const NEVER: [RegExp, string][] = [[/\b(sudo|doas|pkexec)\b|(?:^|[;&|(]\s*)su(?:\s|$)/, 'sudo is never allowed']]
const DEPLOY: [RegExp, string][] = [
  [/\b(npm|pnpm|yarn)\s+publish\b/, 'publishes a package'],
  [/\bdocker\s+(push|login)\b/, 'pushes or logs in to a container registry'],
  [/\b(vercel|netlify|firebase|flyctl|fly|heroku|wrangler|railway|serverless|sls)\b[^|;&]*(?:\b(deploy|publish|release|up)\b|--prod\b)/, 'deploys the project'],
  [/\b(terraform|pulumi)\s+(apply|destroy|up)\b/, 'changes cloud infrastructure'],
  [/\bkubectl\s+(apply|delete|replace|patch|rollout|scale)\b/, 'changes a cluster'],
  [/\b(aws|gcloud|az)\b[^|;&]*\b(deploy|delete|rm|terminate|put|create|update)\b/, 'changes cloud resources'],
  [/\b(ssh|scp|sftp|rsync)\b[^|;&]*@/, 'connects to another machine'],
]
const DESTRUCTIVE: [RegExp, string][] = [
  [/\brm\s+(-\w+\s+)*-\w*[rf]/, 'deletes files recursively or by force'],
  [/\b(drop\s+(table|database)|truncate\s+table)\b/i, 'deletes database data'],
  [/\b(mkfs|dd\s+if=|chmod\s+-R|chown\s+-R)\b/, 'changes the system'],
]
const NETWORK = /\b(curl|wget|nc|ncat)\b/
const SECRET_NAMES = String.raw`(?:\.env(?:\.(?!example|sample|template)[\w.]+)?|\.ssh|\.aws|\.gnupg|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519|ecdsa)|[\w.-]+\.(?:pem|key|p12|pfx)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))`
const SENSITIVE = new RegExp(String.raw`(?:^|/)${SECRET_NAMES}(?:/|$)`, 'i') // a path
const SENSITIVE_IN_COMMAND = new RegExp(String.raw`(?:^|[\s/'"=:])${SECRET_NAMES}(?:[\s/'";|&]|$)`, 'i')

export function decideCommand(cmd: string): Verdict {
  const hard = blocked(cmd)
  if (hard) return { verdict: 'deny', reason: hard }
  const git = gitCalls(cmd)
  for (const c of git) {
    const why = gitNever(c)
    if (why) return { verdict: 'deny', reason: why }
  }
  for (const [re, why] of NEVER) if (re.test(cmd)) return { verdict: 'deny', reason: why }
  for (const [re, why] of DEPLOY) if (re.test(cmd)) return { verdict: 'ask', reason: `This ${why}.` }
  for (const [re, why] of DESTRUCTIVE) if (re.test(cmd)) return { verdict: 'ask', reason: `This ${why}.` }
  if (git.some(gitDestructive)) return { verdict: 'ask', reason: 'This throws away work in git.' }
  if (SENSITIVE_IN_COMMAND.test(cmd)) return { verdict: 'ask', reason: 'This touches a file that usually holds secrets.' }
  if (NETWORK.test(cmd)) return { verdict: 'ask', reason: 'This downloads or sends data over the network.' }
  return { verdict: 'allow', reason: '' }
}

// The destination of a copy, a redirect or a file command, when it lies outside the agent's folder. Regexes, not a sandbox: it catches the
// plain forms (cp/mv/tee/redirects into the user's real project); a path built by the shell ($VAR, command substitution) is not judged.
const COPIERS = /^(cp|mv|install|ln|rsync)$/
const WRITERS = /^(tee|touch|mkdir|rm|rmdir|truncate|chmod|chown)$/
function writesOutside(cmd: string, worktree: string): string | null {
  const outside = (raw: string) => {
    const t = raw.replace(/^['"]|['"]$/g, '')
    if (!t || /[$`*]/.test(t) || !/^(\/|~|\.\.|[a-z]:[\\/])/i.test(t)) return false
    const abs = resolve(worktree, t.replace(/^~(?=\/|$)/, homedir())).replace(/\\/g, '/')
    return !/^\/dev\//.test(abs) && !abs.startsWith(tmpdir().replace(/\\/g, '/') + '/') && !abs.startsWith('/tmp/') && (relative(worktree, abs).startsWith('..') || /^[a-z]:\//i.test(relative(worktree, abs)))
  }
  for (const m of cmd.matchAll(/>>?\s*(?!&)("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g)) if (outside(m[1])) return m[1]
  // git aimed at another folder (-C, --git-dir, --work-tree) may only read there
  for (const c of gitCalls(cmd)) {
    let cur = worktree
    for (const d of c.dirs) cur = resolve(cur, d.replace(/^~(?=\/|$)/, homedir()))
    if (c.dirs.length && !GIT_READS.test(c.sub) && outside(cur)) return cur
  }
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const words = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).filter((w) => !/^\w+=/.test(w))
    const name = (words[0] ?? '').replace(/^.*\//, '')
    const args = words.slice(1).filter((w) => !w.startsWith('-'))
    const hit = COPIERS.test(name) ? args.slice(-1).find(outside) : WRITERS.test(name) ? args.find(outside) : undefined
    if (hit) return hit
  }
  return null
}

// A tool call from Claude Code: { tool_name, input }. `worktree` is the agent's own folder.
export function decideTool(tool: string, input: Record<string, unknown>, worktree: string): Verdict {
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '')
    const v = decideCommand(cmd)
    if (v.verdict === 'deny') return v
    const out = writesOutside(cmd, worktree)
    return out ? { verdict: 'deny', reason: `writes are limited to the task folder (${out})` } : v
  }
  const path = String(input.file_path ?? input.path ?? input.notebook_path ?? '')
  if (path && /^(Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep)$/.test(tool)) {
    const abs = (isAbsolute(path) ? resolve(path) : resolve(worktree, path)).replace(/\\/g, '/') // one separator, so the patterns below also fit Windows paths
    const outside = relative(worktree, abs).startsWith('..') || /^[a-z]:\//i.test(relative(worktree, abs))
    const writes = tool !== 'Read' && tool !== 'Glob' && tool !== 'Grep'
    if (SENSITIVE.test(abs)) return writes ? { verdict: 'deny', reason: 'agents may not write secrets or key files' } : { verdict: 'ask', reason: `Reading ${path} may expose a secret.` }
    if (outside) return writes ? { verdict: 'deny', reason: 'writes are limited to the task folder' } : { verdict: 'ask', reason: `Reading outside the project: ${path}` }
  }
  if (/^mcp__forge_team__/.test(tool)) return { verdict: 'allow', reason: '' }
  if (tool === 'WebFetch' || tool === 'WebSearch') return { verdict: 'allow', reason: '' }
  return { verdict: 'allow', reason: '' }
}
