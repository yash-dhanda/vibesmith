import { makeGeminiParser } from './geminiStream'
import { runCli, type RunOpts, type RunResult } from './process'

// Google AI Pro / Ultra now runs through the Antigravity CLI (`agy`): Google closed Gemini CLI to individual accounts.
export type GeminiOpts = RunOpts & {
  write: boolean // false: plan mode, nothing is changed
  model?: string // empty = the CLI's own choice for the signed-in plan
  resume?: string // conversation id from an earlier run
}

// What a build task may run without asking, and what is refused in any role (deny beats allow). The CLI cannot ask in a headless run, so a command
// outside the allow list is soft-denied and comes back as a failed tool call, the same as Claude's headless runs.
const ALLOW = ['npm test', 'npm run', 'npm install', 'npm ci', 'npx', 'node', 'python3', 'git status', 'git diff', 'git log', 'git add', 'git commit', 'ls', 'cat', 'mkdir', 'pwd', 'echo']
const READ = ['git status', 'git diff', 'git log', 'ls', 'cat', 'pwd']
const DENY = ['git push', 'sudo', 'rm -rf /', 'rm -rf ~', 'curl', 'wget', 'npm publish', 'docker push', 'vercel', 'terraform apply', 'kubectl']
// Session-only settings (--settings is never saved), so the user's own permission rules are left alone.
export const geminiSettings = (write: boolean): string => JSON.stringify({ permissions: { allow: (write ? ALLOW : READ).map((c) => `command(${c})`), deny: DENY.map((c) => `command(${c})`) } })

// The prompt goes in on stdin as one stream-json message (no quoting problems, no argument length limit); the CLI runs the turn and exits when stdin closes.
export const geminiInput = (prompt: string): string => `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`

export function geminiArgs(o: GeminiOpts): string[] {
  const a = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', o.write ? 'accept-edits' : 'plan', '--settings', geminiSettings(o.write)]
  if (o.model) a.push('--model', o.model)
  if (o.resume) a.push('--conversation', o.resume)
  return a
}

export const runGemini = (o: GeminiOpts, bin = 'agy'): Promise<RunResult> => runCli('gemini', bin, geminiArgs(o), makeGeminiParser(), { ...o, prompt: geminiInput(o.prompt) })
