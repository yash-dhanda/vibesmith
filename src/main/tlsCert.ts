import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A certificate for the phone link from Tailscale ("tailscale cert"): the name is the computer's MagicDNS name, so Safari trusts it.

export type Run = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
export type TlsCert = { name: string; cert: string; key: string; notAfter: number }

const DAY = 24 * 3600_000
export const RENEW_BEFORE = 14 * DAY
const ENABLE = 'In the Tailscale admin console open the DNS page and enable "HTTPS Certificates" (MagicDNS must be on too).'

export const defaultRun: Run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout: 90_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve({ stdout: String(stdout), stderr: String(stderr) }))))

const fail = (e: unknown): string => {
  const x = e as NodeJS.ErrnoException & { stderr?: string }
  if (x.code === 'ENOENT') return 'Tailscale is not installed on this computer (the tailscale command was not found).'
  const text = `${x.stderr ?? ''} ${x.message ?? ''}`
  if (/access denied|permission denied|operator/i.test(text)) return 'Tailscale would not let Forge ask for a certificate. Run "sudo tailscale set --operator=$USER" once in a terminal, then try again.'
  if (/https|tls cert|certificates?/i.test(text) && /not (enabled|allowed|support)|does not support|disabled/i.test(text)) return `HTTPS certificates are not enabled for your tailnet. ${ENABLE}`
  if (/invalid domain|not .*valid for|name.*(mismatch|does not match)/i.test(text)) return 'Tailscale does not issue a certificate for this computer\'s name. Check that the name in Tailscale has not changed.'
  if (/not running|stopped|logged out|NeedsLogin|connect.*(refused|tailscaled)|no such file/i.test(text)) return 'Tailscale is not running. Start Tailscale and sign in.'
  return `Tailscale could not make a certificate: ${(x.stderr || x.message || 'unknown error').trim().split('\n')[0]}`
}

// The computer's MagicDNS name, or the reason there is none.
export async function lookupTailscale(run: Run): Promise<{ name: string } | { error: string }> {
  let status: { BackendState?: string; Self?: { DNSName?: string } }
  try { status = JSON.parse((await run('tailscale', ['status', '--json'])).stdout) } catch (e) { return { error: e instanceof SyntaxError ? 'Tailscale gave an answer Forge could not read.' : fail(e) } }
  if (status.BackendState && status.BackendState !== 'Running') return { error: 'Tailscale is not running. Start Tailscale and sign in.' }
  const name = (status.Self?.DNSName ?? '').replace(/\.$/, '')
  return name ? { name } : { error: `Tailscale has no name for this computer. ${ENABLE}` }
}
export async function findTailscaleName(run: Run): Promise<string | null> {
  const r = await lookupTailscale(run)
  return 'name' in r ? r.name : null
}

function read(crt: string, key: string, name: string): { cert: string; key: string; notAfter: number } | null {
  try {
    const cert = readFileSync(crt, 'utf8')
    const x = new X509Certificate(cert)
    return x.checkHost(name) ? { cert, key: readFileSync(key, 'utf8'), notAfter: Date.parse(x.validTo) } : null
  } catch { return null }
}

// Reuses the pair on disk while it has more than 14 days left, otherwise asks Tailscale for a new one. Throws a sentence the user can act on.
export async function ensureCert(dir: string, name: string, run: Run): Promise<Omit<TlsCert, 'name'>> {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(name)) throw new Error('The computer name from Tailscale is not usable for a certificate.')
  const crt = join(dir, `${name}.crt`)
  const key = join(dir, `${name}.key`)
  const have = existsSync(crt) && existsSync(key) ? read(crt, key, name) : null
  if (have && have.notAfter - Date.now() > RENEW_BEFORE) return have
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  try { await run('tailscale', ['cert', '--cert-file', crt, '--key-file', key, name]) } catch (e) { throw new Error(fail(e)) }
  if (existsSync(key)) chmodSync(key, 0o600)
  const got = read(crt, key, name)
  if (!got) throw new Error(`Tailscale made a certificate that is not for ${name}.`)
  return got
}

export async function obtainTls(dir: string, run: Run = defaultRun): Promise<TlsCert> {
  const found = await lookupTailscale(run)
  if ('error' in found) throw new Error(found.error)
  return { name: found.name, ...(await ensureCert(dir, found.name, run)) }
}
