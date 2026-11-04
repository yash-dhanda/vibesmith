import { execFileSync } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureCert, findTailscaleName, lookupTailscale, obtainTls, type Run } from './tlsCert'

const hasOpenssl = (() => { try { execFileSync('openssl', ['version']); return true } catch { return false } })()
if (!hasOpenssl) console.warn('openssl is not installed: the certificate file tests in tlsCert.test.ts are skipped')
const withSsl = hasOpenssl ? it : it.skip

const NAME = 'box.tail1234.ts.net'
const makeCert = (crt: string, key: string, name: string, days: number) =>
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', String(days), '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`], { stdio: 'ignore' })
const status = (o: object): Run => async () => ({ stdout: JSON.stringify(o), stderr: '' })
const failing = (stderr: string, code?: string): Run => async () => { throw Object.assign(new Error(stderr), { stderr, code }) }

describe('tailscale name', () => {
  it('returns the MagicDNS name without the trailing dot', async () => {
    expect(await findTailscaleName(status({ BackendState: 'Running', Self: { DNSName: `${NAME}.` } }))).toBe(NAME)
  })
  it('says why there is none', async () => {
    expect(await findTailscaleName(failing('', 'ENOENT'))).toBeNull()
    expect(await lookupTailscale(failing('', 'ENOENT'))).toEqual({ error: expect.stringMatching(/not installed/) })
    expect(await lookupTailscale(status({ BackendState: 'Stopped' }))).toEqual({ error: expect.stringMatching(/not running/) })
    expect(await lookupTailscale(failing('failed to connect to local tailscaled; it doesn\'t appear to be running'))).toEqual({ error: expect.stringMatching(/not running/) })
    expect(await lookupTailscale(status({ BackendState: 'Running', Self: { DNSName: '' } }))).toEqual({ error: expect.stringMatching(/HTTPS Certificates/) })
    expect(await lookupTailscale(async () => ({ stdout: 'nope', stderr: '' }))).toEqual({ error: expect.stringMatching(/could not read/) })
  })
})

describe('tailscale certificate', () => {
  const issuing = (days: number) => vi.fn<Run>(async (_c, a) => { makeCert(a[2], a[4], a[5], days); return { stdout: '', stderr: '' } })

  withSsl('asks tailscale for a pair, keeps the key private and reports the expiry', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tls-')), 'tls')
    const run = issuing(90)
    const c = await ensureCert(dir, NAME, run)
    expect(run).toHaveBeenCalledWith('tailscale', ['cert', '--cert-file', join(dir, `${NAME}.crt`), '--key-file', join(dir, `${NAME}.key`), NAME])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, `${NAME}.key`)).mode & 0o777).toBe(0o600)
    expect(c.cert).toContain('BEGIN CERTIFICATE')
    expect(c.key).toContain('PRIVATE KEY')
    expect(c.notAfter - Date.now()).toBeGreaterThan(85 * 86400_000)
  })

  withSsl('reuses a pair with more than 14 days left and renews one with fewer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tls-'))
    makeCert(join(dir, `${NAME}.crt`), join(dir, `${NAME}.key`), NAME, 60)
    const run = issuing(90)
    await ensureCert(dir, NAME, run)
    expect(run).not.toHaveBeenCalled()
    makeCert(join(dir, `${NAME}.crt`), join(dir, `${NAME}.key`), NAME, 10)
    const renewed = await ensureCert(dir, NAME, run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(renewed.notAfter - Date.now()).toBeGreaterThan(80 * 86400_000)
  })

  withSsl('refuses a certificate that is for another name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tls-'))
    const run = vi.fn<Run>(async (_c, a) => { makeCert(a[2], a[4], 'other.example.net', 90); return { stdout: '', stderr: '' } })
    await expect(ensureCert(dir, NAME, run)).rejects.toThrow(/not for box\.tail1234/)
  })

  it('turns the failures into sentences the user can act on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tls-'))
    await expect(ensureCert(dir, NAME, failing('', 'ENOENT'))).rejects.toThrow(/not installed/)
    await expect(ensureCert(dir, NAME, failing('your Tailscale account does not support getting TLS certs'))).rejects.toThrow(/"HTTPS Certificates"/)
    await expect(ensureCert(dir, NAME, failing('Access denied: cert access denied\nUse \'sudo tailscale set --operator=$USER\''))).rejects.toThrow(/set --operator/)
    await expect(ensureCert(dir, NAME, failing('invalid domain'))).rejects.toThrow(/name/)
    await expect(ensureCert(dir, '../evil', failing(''))).rejects.toThrow(/not usable/)
  })

  withSsl('obtainTls ties the name and the pair together', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tls-'))
    const run: Run = async (_c, a) => (a[0] === 'status' ? { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${NAME}.` } }), stderr: '' } : (makeCert(a[2], a[4], a[5], 90), { stdout: '', stderr: '' }))
    expect((await obtainTls(dir, run)).name).toBe(NAME)
    await expect(obtainTls(dir, status({ BackendState: 'Stopped' }))).rejects.toThrow(/not running/)
  })
})
