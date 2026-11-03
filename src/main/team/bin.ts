import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

// Starting `claude` or `codex` on Windows: npm installs them as .cmd shims, and Node cannot spawn a .cmd without a shell
// (which would also mangle the JSON in our arguments). So the shim is read, and the script it points to is run directly.
// A real .exe is used as it is. Everywhere else the name is used unchanged. Written without a Windows machine to test on:
// the logic is unit-tested with a fake file system; the first real Windows run is the proof.
export type Cmd = { cmd: string; args: string[]; env: Record<string, string> }
type Probe = { platform?: NodeJS.Platform; which?: (name: string) => string[]; exists?: (p: string) => boolean; read?: (p: string) => string; node?: string }

const defaultWhich = (name: string): string[] => {
  try {
    return execFileSync('where', [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

// "%dp0%\node_modules\@openai\codex\bin\codex.js" -> that path next to the shim
export function shimTarget(shimPath: string, text: string, exists: (p: string) => boolean): string | null {
  for (const m of text.matchAll(/"%(?:~dp0|dp0)%?\\([^"]+\.(?:js|mjs|cjs))"/gi)) {
    const p = join(dirname(shimPath), m[1])
    if (exists(p)) return p
  }
  return null
}

const cache = new Map<string, string[]>()
export function resolveCommand(bin: string, args: string[], p: Probe = {}): Cmd {
  const platform = p.platform ?? process.platform
  const plain: Cmd = { cmd: bin, args, env: {} }
  if (platform !== 'win32' || isAbsolute(bin) || /\.exe$/i.test(bin)) return plain
  const key = `${platform}:${bin}`
  const found = p.which ? p.which(bin) : (cache.get(key) ?? (cache.set(key, defaultWhich(bin)), cache.get(key)!))
  const exe = found.find((f) => /\.exe$/i.test(f))
  if (exe) return { cmd: exe, args, env: {} }
  const exists = p.exists ?? existsSync
  const read = p.read ?? ((f: string) => readFileSync(f, 'utf8'))
  for (const shim of found.filter((f) => /\.(cmd|bat)$/i.test(f))) {
    try {
      const script = shimTarget(shim, read(shim), exists)
      if (script) return { cmd: p.node ?? process.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } }
    } catch {}
  }
  return plain
}
