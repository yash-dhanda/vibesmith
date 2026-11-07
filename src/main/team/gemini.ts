import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGeminiParser } from './geminiStream'
import { runCli, type RunOpts, type RunResult } from './process'

export type GeminiOpts = RunOpts & {
  write: boolean // false: plan mode, nothing is changed
  model?: string // empty = Gemini CLI's own choice for the signed-in plan
}

// What a build task may run without asking, and what is refused in any role. Gemini CLI cannot ask in a headless run, so a command
// outside the allow list is denied and comes back as a failed tool call, the same as Claude's headless runs.
const ALLOW = ['npm test', 'npm run', 'npm install', 'npm ci', 'npx', 'node', 'python3', 'git status', 'git diff', 'git log', 'git add', 'git commit', 'ls', 'cat', 'mkdir', 'pwd', 'echo']
const DENY = ['git push', 'sudo', 'rm -rf /', 'rm -rf ~', 'curl', 'wget', 'npm publish', 'docker push', 'vercel', 'terraform apply', 'kubectl']
const list = (a: string[]) => `[${a.map((s) => JSON.stringify(s)).join(', ')}]`
export const geminiPolicy = (): string =>
  `[[rule]]\ntoolName = "run_shell_command"\ncommandPrefix = ${list(ALLOW)}\ndecision = "allow"\npriority = 100\n\n[[rule]]\ntoolName = "run_shell_command"\ncommandPrefix = ${list(DENY)}\ndecision = "deny"\npriority = 200\n`

// The prompt goes in on stdin; `-p` only switches to headless mode (its text is appended to stdin).
export function geminiArgs(o: GeminiOpts, policy?: string): string[] {
  const a = ['-p', ' ', '-o', 'stream-json', '--skip-trust', '--approval-mode', o.write ? 'auto_edit' : 'plan']
  if (o.model) a.push('-m', o.model)
  if (o.write && policy) a.push('--policy', policy)
  return a
}

export async function runGemini(o: GeminiOpts, bin = 'gemini'): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gemini-'))
  try {
    const policy = join(dir, 'policy.toml')
    writeFileSync(policy, geminiPolicy())
    return await runCli('gemini', bin, geminiArgs(o, policy), makeGeminiParser(), o)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
