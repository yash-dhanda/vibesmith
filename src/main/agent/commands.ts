import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ponytail: pattern deny-list, not a sandbox. Real containment is the approval gate; upgrade to a container if full-auto becomes the default.
const HOMEISH = String.raw`(?:~|\$\{?HOME\}?|\$env:USERPROFILE|%USERPROFILE%|%HOMEPATH%)`
const BOUNDARY = '[;&|(\\n\\x60"\'{]|\\$\\('
const SHELL = String.raw`(?:\S*\/)?(?:env\s+)?(?:sudo\s+)?(?:ba|z|da|k|fi|a)?sh\b`
const DENY: [RegExp, string][] = [
  // Only where a command can start (or after a wrapper like env or xargs), so `cat run0.log` and prose in a commit message pass.
  [new RegExp(String.raw`(?:^|${BOUNDARY}|\b(?:env|time|nohup|exec|command|xargs|nice|watch|timeout|then|do|else)\b[^;&|\n]*?)\s*(?:\S*\/)?(?:sudo|doas|pkexec|run0|runas)(?![\w.-])`, 'i'), 'sudo'],
  [new RegExp(String.raw`(?:^|${BOUNDARY})\s*(?:\S*\/)?su(?:\s|$)`), 'su'],
  [/\bmkfs\b/, 'mkfs'],
  [/\bdd\b[^|;&\n]*\b(?:if|of)=/, 'dd'],
  [/\b(wipefs|shred|blkdiscard|sgdisk|sfdisk|fdisk|parted|Format-Volume|Clear-Disk)\b/i, 'disk wipe or partitioning'],
  [/:\(\)\s*\{/, 'fork bomb'],
  [new RegExp(String.raw`\b(?:curl|wget)\b[^;\n]*\|\s*${SHELL}`), 'pipe download to shell'],
  [/\b(?:(?:ba|z|da|k)?sh|eval|source)\s+[^|;\n]*(?:<|\$)\(\s*(?:curl|wget)\b/, 'run a downloaded script'],
  // Windows
  [new RegExp(String.raw`\b(?:rd|rmdir)\s+(?:\/[sq]\s+)+(?:[a-z]:\\?|${HOMEISH})(?:\s|$)`, 'i'), 'recursive delete of a drive or home'],
  [/\bdel\s+(\/[fsq]\s+)+[a-z]:\\/i, 'recursive delete of a drive'],
  [/\bformat\s+[a-z]:/i, 'format a drive'],
  [new RegExp(String.raw`\bremove-item\b[^|;]*-recurse[^|;]*\s(?:[a-z]:\\?|${HOMEISH})(?:\s|$)`, 'i'), 'recursive delete of a drive or home'],
  [/\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;]*\|\s*(iex|invoke-expression)\b/i, 'pipe download to PowerShell'],
  [/\b(iex|invoke-expression)\s*\(?\s*\(?\s*(iwr|irm|invoke-webrequest|invoke-restmethod)\b/i, 'run a downloaded PowerShell script'],
]

// rm is judged per shell segment on its words, so flag order, quotes and a trailing slash or * cannot hide a target.
function recursiveRmOfHome(cmd: string): boolean {
  const home = homedir().replace(/\/+$/, '')
  for (const seg of cmd.split(/&&|\|\||[;|\n(]/)) {
    const words = seg.trim().split(/\s+/).map((w) => w.replace(/^["']+|["']+$/g, ''))
    const rm = words.findIndex((w) => w === 'rm' || w.endsWith('/rm'))
    if (rm < 0) continue
    let rf = false
    let literal = false
    for (const w of words.slice(rm + 1)) {
      if (!literal && w === '--') literal = true
      else if (!literal && w.startsWith('-')) rf ||= /^--(recursive|force)$/.test(w) || /^-[a-zA-Z]*[rRf]/.test(w)
      else if (rf && w && (w === '*' || [home, '', '~', '$HOME', '${HOME}'].includes(w.replace(/\/\*$/, '').replace(/\/+$/, '')))) return true
    }
  }
  return false
}

// Stops a spawned shell and everything it started. POSIX: the child was spawned detached, so signal its process group.
// Windows has no groups, and killing cmd.exe alone leaves the dev server it launched holding the port: taskkill walks the tree.
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL', platform: NodeJS.Platform = process.platform, run: typeof execFile = execFile) {
  if (!child.pid) return
  try {
    if (platform === 'win32') run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    else process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

export function blocked(cmd: string): string | null {
  if (recursiveRmOfHome(cmd)) return 'recursive delete of / ~ or *'
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

// [command pattern, registry, runner]. A runner (npx, dlx) takes the package first and passes the rest to it, so only the first word counts.
const INSTALLS: [RegExp, 'npm' | 'pip', boolean][] = [
  [/^(?:npm|pnpm|bun)\s+(?:install|i|add)\s+(.*)$/, 'npm', false],
  [/^yarn\s+(?:global\s+)?add\s+(.*)$/, 'npm', false],
  [/^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(.*)$/, 'npm', true],
  [/^(?:python3?\s+-m\s+)?pip3?\s+install\s+(.*)$/, 'pip', false],
  [/^(?:uv\s+pip\s+install|uv\s+add|poetry\s+add|pipx\s+install)\s+(.*)$/, 'pip', false],
]
const FLAGS_WITH_VALUE = new Set(['-r', '-e', '-c', '-i', '-t', '--requirement', '--editable', '--constraint', '--registry', '--prefix', '--python', '--group', '--index-url', '--extra-index-url', '--target', '--workspace', '--cache', '--cwd', '--dir'])

function packageNames(args: string, kind: 'npm' | 'pip', runner: boolean): string[] {
  const out: string[] = []
  const toks = (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''))
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(t)) i++
      continue
    }
    if (/^\d*[<>]/.test(t)) {
      if (/^\d*(?:>>?|<)$/.test(t)) i++ // a bare redirection operator: the next word is a file, not a package
      continue
    }
    if (/^(\.|\/|~|git\+|https?:|file:|[\w-]+:)/.test(t) || t.includes('/') && !t.startsWith('@')) continue // paths, urls, git specs
    out.push(kind === 'npm' ? t.replace(/(?<=.)@[^@/]*$/, '') : t.replace(/\[.*\]/, '').split(/[=<>!~;\s]/)[0])
    if (runner) break
  }
  return out.filter(Boolean)
}

// The commands in a chain, outside quotes and heredoc bodies (a commit message or a README that mentions `npm install x` is text, not an install).
function segments(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = ''
  const text = cmd.replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n\s*\3\s*(?=\n|$)/g, '$1')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '\\' && q === '"') cur += c + (text[++i] ?? '')
      else {
        cur += c
        if (c === q) q = ''
      }
    } else if (c === '"' || c === "'") (q = c), (cur += c)
    else if (';&|\n()'.includes(c)) out.push(cur), (cur = '')
    else cur += c
  }
  return [...out, cur]
}

export async function checkPackages(cmd: string, fetchFn: Fetch = (u, i) => fetch(u, i), signal?: AbortSignal): Promise<string | null> {
  // Every install in a chain is checked, not only one at the start of the string.
  for (const seg of segments(cmd)) {
    const hit = INSTALLS.map(([re, kind, runner]) => ({ m: re.exec(seg.trim()), kind, runner })).find((x) => x.m)
    if (!hit) continue
    for (const name of packageNames(hit.m![1], hit.kind, hit.runner)) {
      const url = hit.kind === 'npm' ? `https://registry.npmjs.org/${name.replace('/', '%2f')}` : `https://pypi.org/pypi/${name}/json`
      try {
        const res = await fetchFn(url, { method: 'HEAD', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) })
        if (res.status === 404) return `ERROR: package "${name}" does not exist on ${hit.kind === 'npm' ? 'npm' : 'PyPI'}. Do not install it; check the name or use a different approach.`
      } catch {
        // registry unreachable: fail open, the install itself will fail loudly
      }
    }
  }
  return null
}

// ---- run ----
const MAX_OUT = 10_000

export async function runCommand(cmd: string, cwd: string, signal: AbortSignal, opts: { timeoutMs?: number; fetchFn?: Fetch } = {}): Promise<string> {
  const why = blocked(cmd)
  if (why) return `ERROR: command blocked (${why}). Choose a safer approach.`
  const bad = await checkPackages(cmd, opts.fetchFn, signal)
  if (bad) return bad
  if (signal.aborted) return '[stopped by user]'

  const timeoutMs = opts.timeoutMs ?? 60_000
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32'
    const child = spawn(cmd, { shell: true, cwd, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let note = ''
    const kill = () => killTree(child)
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
  const has = (f: string) => existsSync(join(root, f))
  try {
    const test = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: { test?: string } }).scripts?.test
    if (test && !/no test specified/.test(test)) return 'npm test'
  } catch {}
  // other ecosystems: only when the project clearly has tests
  try {
    if (has('go.mod') && readdirSync(root).some((f) => f.endsWith('_test.go'))) return 'go test ./...'
    if (has('Cargo.toml')) return 'cargo test'
    if (has('pytest.ini') || has('tox.ini') || (has('pyproject.toml') && /pytest/.test(readFileSync(join(root, 'pyproject.toml'), 'utf8')))) return 'python3 -m pytest -q'
    if (has('tests') && readdirSync(join(root, 'tests')).some((f) => /^test_.*\.py$/.test(f))) return 'python3 -m pytest -q'
  } catch {}
  return null
}
