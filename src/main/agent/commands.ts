import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ponytail: pattern deny-list, not a sandbox. Real containment is the approval gate; upgrade to a container if full-auto becomes the default.
const DENY: [RegExp, string][] = [
  [/\bsudo\b/, 'sudo'],
  [/\brm\s+(-\w+\s+)*-\w*[rf]\w*\s+(\/|~|\$HOME|\*)(\s|$)/, 'recursive delete of / ~ or *'],
  [/\bmkfs\b/, 'mkfs'],
  [/\bdd\s+if=/, 'dd'],
  [/:\(\)\s*\{/, 'fork bomb'],
  [/\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, 'pipe download to shell'],
]

export function blocked(cmd: string): string | null {
  return DENY.find(([re]) => re.test(cmd))?.[1] ?? null
}

// auto-edit mode runs these without asking. Exact match only, and no shell chaining.
const ALLOW = new Set(['npm test', 'npm run test', 'npm run build', 'npm run typecheck', 'npm run lint', 'npx vitest run', 'npx tsc --noEmit', 'git status', 'git diff', 'git log --oneline'])

export function isAllowlisted(cmd: string): boolean {
  const c = cmd.trim()
  return ALLOW.has(c) && !/[;&|<>`$\n]/.test(c)
}

// ---- package existence check: blocks hallucinated package names before install ----
type Fetch = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ status: number }>

const NPM_INSTALL = /^\s*(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\s+(.*)$/
const PIP_INSTALL = /^\s*(?:python3?\s+-m\s+)?pip3?\s+install\s+(.*)$/
const FLAGS_WITH_VALUE = new Set(['-r', '-e', '-c', '--requirement', '--editable', '--constraint', '--registry', '--prefix'])

function packageNames(args: string, kind: 'npm' | 'pip'): string[] {
  const out: string[] = []
  const toks = args.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(t)) i++
      continue
    }
    if (/^(\.|\/|~|git\+|https?:|file:|[\w-]+:)/.test(t) || t.includes('/') && !t.startsWith('@')) continue // paths, urls, git specs
    out.push(kind === 'npm' ? t.replace(/(?<=.)@[^@/]*$/, '') : t.replace(/\[.*\]/, '').split(/[=<>!~;]/)[0])
  }
  return out.filter(Boolean)
}

export async function checkPackages(cmd: string, fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<string | null> {
  const npm = NPM_INSTALL.exec(cmd)
  const pip = PIP_INSTALL.exec(cmd)
  const kind = npm ? 'npm' : pip ? 'pip' : null
  if (!kind) return null
  for (const name of packageNames((npm ?? pip)![1], kind)) {
    const url = kind === 'npm' ? `https://registry.npmjs.org/${name.replace('/', '%2f')}` : `https://pypi.org/pypi/${name}/json`
    try {
      const res = await fetchFn(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      if (res.status === 404) return `ERROR: package "${name}" does not exist on ${kind === 'npm' ? 'npm' : 'PyPI'}. Do not install it; check the name or use a different approach.`
    } catch {
      // registry unreachable: fail open, the install itself will fail loudly
    }
  }
  return null
}

// ---- run ----
const MAX_OUT = 10_000

export async function runCommand(cmd: string, cwd: string, signal: AbortSignal, opts: { timeoutMs?: number; fetchFn?: Fetch } = {}): Promise<string> {
  const why = blocked(cmd)
  if (why) return `ERROR: command blocked (${why}). Choose a safer approach.`
  const bad = await checkPackages(cmd, opts.fetchFn)
  if (bad) return bad

  const timeoutMs = opts.timeoutMs ?? 60_000
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32'
    const child = spawn(cmd, { shell: true, cwd, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let note = ''
    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL') // whole process group, not just the shell
        else child.kill('SIGKILL')
      } catch {}
    }
    const timer = setTimeout(() => {
      note = `\n[timed out after ${timeoutMs / 1000}s and was killed]`
      kill()
    }, timeoutMs)
    const onAbort = () => {
      note = '\n[stopped by user]'
      kill()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const take = (d: Buffer) => {
      out += d.toString()
      if (out.length > MAX_OUT * 4) out = out.slice(-MAX_OUT * 2) // bound memory on chatty commands
    }
    child.stdout!.on('data', take)
    child.stderr!.on('data', take)
    const finish = (tail: string) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const text = out.length > MAX_OUT ? `[output truncated, showing the end]\n${out.slice(-MAX_OUT)}` : out
      resolve((text.trimEnd() + note + tail).trimStart() || '(no output)')
    }
    child.on('error', (e) => finish(`\nERROR: ${e.message}`))
    child.on('close', (code) => finish(`\n[exit code ${code ?? 'killed'}]`))
  })
}

// ---- verify: the project's own check (tests, build). The user picks it, so it is trusted like a button, not like a model-chosen command ----
export async function runVerify(command: string, cwd: string, signal: AbortSignal): Promise<{ command: string; ok: boolean; output: string }> {
  const output = await runCommand(command, cwd, signal, { timeoutMs: 120_000 })
  return { command, ok: /\[exit code 0\]\s*$/.test(output), output }
}

// A package.json test script is a safe default. Anything fancier is the user's call in Settings.
export function detectVerify(root: string): string | null {
  try {
    const test = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: { test?: string } }).scripts?.test
    return test && !/no test specified/.test(test) ? 'npm test' : null
  } catch {
    return null
  }
}
