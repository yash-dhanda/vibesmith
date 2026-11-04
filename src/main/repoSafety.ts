import { repoRisk } from '../renderer/repoRisk'
import { cached, getApi, GithubError, ownerInfo, repoMeta, type Deps } from './githubTop'

// A quick look at a repository before it is added, from GitHub's file list and a few small files. Nothing is downloaded or run, and it is a
// scan for the usual tricks, not a guarantee: a repository can pass and still be harmful, or be flagged and be fine.
export type Severity = 'info' | 'caution' | 'danger'
export type Finding = { severity: Severity; text: string }
export type SafetyReport = { verdict: 'ok' | 'caution' | 'danger'; findings: Finding[]; checked: { files: number; bytes: number } }

const TTL = 3_600_000
const MAX_FILES = 12
const MAX_SCRIPT = 60_000
const MAX_MANIFEST = 100_000
const PROGRAM = /\.(exe|dll|msi|dmg|apk|jar|bat|cmd|ps1|scr|lnk|vbs)$/i
const ARCHIVE = /\.(zip|rar|7z|tar|tgz|gz|iso)$/i
const SCRIPT = /\.(sh|bash|zsh|ps1|bat|cmd|vbs|py|js|mjs|cjs|rb|pl|php)$/i
const VENDORED = /(^|\/)(node_modules|vendor|third_party|\.git)\//
const MINIFIED = /\.min\.(js|css)$/i
const HOOKS = ['preinstall', 'install', 'postinstall', 'prepare']
const PIPE_TO_SHELL = /\b(curl|wget)\b[^\n|;]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\biex\s*\(?\s*\(?\s*(irm|iwr|invoke-restmethod|invoke-webrequest|new-object\s+net\.webclient)|\b(irm|iwr)\b[^\n|]*\|\s*iex\b/i
const DECODE_AND_RUN = /(atob\(|base64\s+(-d|--decode)|frombase64string|b64decode)[\s\S]{0,200}(eval|exec|iex|invoke-expression|\|\s*(ba)?sh)|\b(eval|exec|iex)\s*\(\s*(atob|base64\.b64decode|buffer\.from)/i
const LURE_README = /\b(free download|crack(ed)?|keygen|pre-?activated|activated|nulled|full version|serial key)\b/i
const PY_CUSTOM = /cmdclass|os\.system|subprocess|\bexec\(|urlopen|requests\.get/
const PYPROJECT_CUSTOM = /backend-path|build\.hooks\.custom|\[tool\.poetry\.build\]|build\.script/

type TreeEntry = { path?: unknown; type?: unknown; size?: unknown }
const list = (paths: string[]) => paths.slice(0, 4).join(', ') + (paths.length > 4 ? `, and ${paths.length - 4} more` : '')
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/')

export async function safetyCheck(fullName: string, d: Deps = {}): Promise<SafetyReport> {
  return cached(`safety:${fullName.toLowerCase()}`, TTL, false, d, async () => {
    const findings: Finding[] = []
    const add = (severity: Severity, text: string) => findings.push({ severity, text })
    const [owner, repo] = fullName.split('/')
    let skipped = 0
    const soft = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn() } catch { skipped++; return null } }

    // The record and the file list are the core: without them there is nothing to say.
    const meta = await repoMeta(fullName, d)
    const tree = (await cached(`tree:${fullName.toLowerCase()}`, TTL, false, d, () => getApi(`/repos/${fullName}/git/trees/HEAD?recursive=1`, d))) as { tree?: TreeEntry[]; truncated?: boolean }
    const blobs = (Array.isArray(tree?.tree) ? tree.tree : []).filter((e) => e.type === 'blob' && typeof e.path === 'string').map((e) => ({ path: e.path as string, size: typeof e.size === 'number' ? e.size : 0 }))
    if (tree?.truncated) add('info', 'This repository is very large, so only part of its file list was read.')

    // Facts about the repository itself.
    const stars = typeof meta.stargazers_count === 'number' ? meta.stargazers_count : 0
    const created = typeof meta.created_at === 'string' ? meta.created_at : null
    const risk = repoRisk({ fullName, description: typeof meta.description === 'string' ? meta.description : '', topics: Array.isArray(meta.topics) ? meta.topics.filter((t): t is string => typeof t === 'string') : [], stars,
      sizeKb: typeof meta.size === 'number' ? meta.size : undefined, createdAt: created, language: typeof meta.language === 'string' ? meta.language : null })
    if (risk) add(risk.hide ? 'danger' : 'caution', risk.reason)
    if (!meta.license || !(meta.license as { spdx_id?: unknown }).spdx_id) add('caution', 'No license: nothing says you may use or copy this code.')
    if (created && Date.now() - Date.parse(created) < 14 * 86_400_000) add('caution', 'The repository is less than 14 days old.')
    const commits = await soft(() => getApi(`/repos/${fullName}/commits?per_page=3`, d))
    if (Array.isArray(commits) && commits.length < 3) add('caution', `Only ${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} of history.`)
    const own = await soft(() => ownerInfo(owner, d))
    if (own) add('info', own.type === 'org' ? (own.verified ? 'The owner is a GitHub organization that GitHub has verified.' : 'The owner is a GitHub organization that is not verified.') : 'The owner is a personal account. GitHub verifies organizations only.')
    const readme = await soft(() => getApi(`/repos/${fullName}/readme`, d)) as { content?: unknown; encoding?: unknown } | null
    const readmeText = readme && readme.encoding === 'base64' && typeof readme.content === 'string' ? Buffer.from(readme.content.replace(/\s/g, ''), 'base64').toString('utf8').slice(0, 20_000) : ''
    if (LURE_README.test(readmeText)) add('caution', 'The README talks about a free download, a crack or an activated version.')

    // Files that should not be committed to a source repository.
    const programs = blobs.filter((b) => PROGRAM.test(b.path) && !VENDORED.test(b.path)).map((b) => b.path)
    if (programs.length) add(risk?.hide ? 'danger' : 'caution', `Contains ${programs.length === 1 ? 'a program file' : `${programs.length} program files`} (${list(programs)}). Forge never runs them; do not run them yourself unless you trust the author.`)
    const archives = blobs.filter((b) => ARCHIVE.test(b.path) && !VENDORED.test(b.path)).map((b) => b.path)
    if (archives.length) add('caution', `Contains packed archives (${list(archives)}) that cannot be read before they are unpacked.`)
    const blobsOdd = blobs.filter((b) => (MINIFIED.test(b.path) && !/(^|\/)(dist|build|public|static|lib|assets)\//.test(b.path)) || /\.(b64|base64)$/i.test(b.path)).map((b) => b.path)
    if (blobsOdd.length) add('caution', `Contains minified or encoded files nobody can read (${list(blobsOdd)}).`)

    // A few small scripts and manifests, read through the contents API.
    const depth = (p: string) => p.split('/').length
    const rank = (p: string) => (p === 'package.json' ? 0 : /^(setup\.py|pyproject\.toml)$/.test(p) ? 1 : /\.(sh|bash|ps1|bat|cmd)$/i.test(p) ? 2 : 3)
    const candidates = blobs.filter((b) => !VENDORED.test(b.path) && b.size > 0 && b.size <= (b.path === 'package.json' ? MAX_MANIFEST : MAX_SCRIPT) && (SCRIPT.test(b.path) || /^(package\.json|pyproject\.toml|Makefile)$/.test(b.path)))
      .sort((a, b) => rank(a.path) - rank(b.path) || depth(a.path) - depth(b.path)).slice(0, MAX_FILES)
    const checked = { files: 0, bytes: 0 }
    for (const f of candidates) {
      let text: string
      try {
        const c = (await getApi(`/repos/${owner}/${repo}/contents/${encode(f.path)}`, d)) as { content?: unknown; encoding?: unknown }
        if (c.encoding !== 'base64' || typeof c.content !== 'string') continue
        text = Buffer.from(c.content.replace(/\s/g, ''), 'base64').toString('utf8')
      } catch (e) { skipped++; if ((e as GithubError).status === 403 || (e as GithubError).status === 429) break; continue }
      checked.files++; checked.bytes += text.length
      if (f.path === 'package.json') {
        try {
          const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {}
          for (const h of HOOKS) if (typeof scripts[h] === 'string') {
            const body = scripts[h] as string
            add(PIPE_TO_SHELL.test(body) || DECODE_AND_RUN.test(body) ? 'danger' : 'caution', `package.json runs a command when installed: ${h}: "${body.slice(0, 80)}".`)
          }
        } catch { /* a broken package.json is just not read */ }
      }
      if (f.path === 'setup.py' && PY_CUSTOM.test(text)) add('caution', 'setup.py runs custom code when the package is installed.')
      if (f.path === 'pyproject.toml' && PYPROJECT_CUSTOM.test(text)) add('caution', 'pyproject.toml sets up a custom build step that runs when the package is installed.')
      if (f.path !== 'package.json' && PIPE_TO_SHELL.test(text)) add('caution', `${f.path} downloads something and pipes it straight into a shell.`)
      if (DECODE_AND_RUN.test(text) || text.split('\n').some((l) => l.length > 1000 && /[A-Za-z0-9+/=]{300,}/.test(l))) add('danger', `${f.path} contains hidden or encoded code that is decoded and run.`)
    }
    if (skipped) add('info', 'Some checks could not run (GitHub is limiting requests or could not be reached), so this scan is incomplete.')

    const verdict = findings.some((f) => f.severity === 'danger') ? 'danger' : findings.some((f) => f.severity === 'caution') ? 'caution' : 'ok'
    return { verdict, findings, checked }
  })
}
