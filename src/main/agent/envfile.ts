import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Code that reads a secret from the environment is no use to a beginner without a file that says which values to set.
// Small models often write the code and skip the file, so the loop checks once before finishing.
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__'])
const SECRET = /(?:process\.env\.|process\.env\[['"]|os\.environ(?:\.get)?\(?\[?['"]?|os\.getenv\(['"])([A-Z][A-Z0-9_]*)/g
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/

function sources(dir: string, depth: number, out: string[] = []): string[] {
  if (depth < 0 || out.length > 200) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) sources(join(dir, e.name), depth - 1, out)
    } else if (/\.(js|mjs|cjs|ts|py)$/.test(e.name)) out.push(join(dir, e.name))
  }
  return out
}

// The message to hand the model when secrets are read from the environment but the project has no .env* file; otherwise null.
export function missingEnvFile(root: string): string | null {
  try {
    if (readdirSync(root).some((f) => f.startsWith('.env'))) return null
    const names = new Set<string>()
    for (const f of sources(root, 2)) {
      if (statSync(f).size > 200_000) continue
      for (const m of readFileSync(f, 'utf8').matchAll(SECRET)) if (SECRETISH.test(m[1])) names.add(m[1])
    }
    if (!names.size || existsSync(join(root, '.env.example'))) return null
    return `The code reads ${[...names].slice(0, 6).join(', ')} from the environment, but the project has no .env.example. Call create_file for .env.example listing each variable with a placeholder value (never a real secret), then tell the user to copy it to .env.`
  } catch {
    return null
  }
}
