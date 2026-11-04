import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { detectVerify } from './agent/commands'

// "Improve this project": a quick, offline look at a folder. It walks a bounded number of files, reads the small source ones once, and turns
// what it finds into suggestions that each carry a ready-to-run Crew goal. No network, and at most one `git status` with a short timeout.

export type Area = 'security' | 'quality' | 'tests' | 'docs' | 'performance' | 'accessibility' | 'tooling' | 'ux'
export type Severity = 'high' | 'medium' | 'low'
export type Suggestion = { id: string; area: Area; severity: Severity; title: string; why: string; evidence: string[]; goal: string; effortMinutes: number }
export type Facts = {
  files: number
  truncated: boolean
  sourceFiles: number
  testFiles: number
  testCommand: string | null
  lint: boolean | null
  format: boolean | null
  tsStrict: boolean | null
  readme: 'missing' | 'short' | 'no-run-steps' | 'ok'
  license: boolean
  gitignoreNodeModules: boolean | null
  gitignoreEnv: boolean
  envFiles: string[]
  envExample: boolean
  ci: boolean
  docker: boolean
  lockfile: boolean | null
  engines: boolean | null
  todos: number
  consoleLogs: number
  debuggers: number
  emptyCatches: number
  git: { repo: boolean; commits: boolean; remote: boolean; uncommitted: number }
}
export type HealthReport = { stack: string[]; facts: Facts; suggestions: Suggestion[] }

export const MAX_FILES = 4000
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'venv', '.venv', 'target', '.forge', '__pycache__', 'coverage', '.turbo', '.cache'])
const JS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte'])
const CODE = new Set([...JS, '.py', '.rs', '.go', '.java', '.kt', '.php', '.rb', '.cs', '.c', '.cpp', '.h'])
const MARKUP = new Set(['.html', '.htm'])
const CONFIG = new Set(['.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env'])
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'])
const READ_MAX = 300 * 1024
const READ_BUDGET = 8 * 1024 * 1024
const BIG = 1024 * 1024
const DEPRECATED = ['request', 'request-promise', 'request-promise-native', 'moment', 'node-sass', 'tslint', 'babel-eslint', 'bower', 'gulp-util', 'node-uuid', 'left-pad']
const PY_DEPRECATED = ['pycrypto', 'nose', 'sklearn', 'distribute']
const SECRETS: [string, RegExp][] = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['API key (sk-)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['Stripe live key', /\bsk_live_[0-9a-zA-Z]{16,}/],
  ['GitHub token', /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['Private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['Discord bot token', /\b[MNO][A-Za-z\d_-]{23,25}\.[\w-]{6}\.[\w-]{27,}\b/],
]
const PLACEHOLDER = /example|xxxx|your[_-]?(key|token)|placeholder|dummy|changeme/i
const isTest = (rel: string) => /(^|\/)(tests?|__tests__|fixtures?|spec)\//.test(rel) || /\.(test|spec)\.[a-z]+$/.test(rel) || /(^|\/)test_[^/]*\.py$|_test\.(py|go)$/.test(rel)

type Entry = { rel: string; abs: string; size: number }

function walk(root: string, deadline: number): { files: Entry[]; truncated: boolean } {
  const files: Entry[] = []
  const queue = ['']
  while (queue.length) {
    const rel = queue.shift()!
    let list
    try { list = readdirSync(join(root, rel), { withFileTypes: true }) } catch { continue }
    for (const d of list) {
      if (d.isSymbolicLink()) continue
      const r = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) { if (!SKIP.has(d.name)) queue.push(r) } else if (d.isFile()) {
        let size = 0
        try { size = statSync(join(root, r)).size } catch { continue }
        files.push({ rel: r, abs: join(root, r), size })
        if (files.length >= MAX_FILES || Date.now() > deadline) return { files, truncated: true }
      }
    }
  }
  return { files, truncated: false }
}

const readText = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const readJson = (p: string): Record<string, any> | null => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

// A small .gitignore reader: enough for node_modules/, .env, *.log and friends. Negations and nested ignore files are not followed.
function ignoreMatcher(text: string) {
  const rules = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!')).map((l) => {
    const anchored = l.startsWith('/') || l.slice(0, -1).includes('/')
    const body = l.replace(/^\//, '').replace(/\/$/, '')
    const re = body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')
    return new RegExp(anchored ? `^${re}(/|$)` : `(^|/)${re}(/|$)`)
  })
  return (rel: string) => rules.some((r) => r.test(rel))
}

function gitState(root: string): Promise<{ commits: boolean; uncommitted: number; tracked: Set<string> }> {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', 'status', '--porcelain=v2', '-b'], { cwd: root, timeout: 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => {
      if (err) return resolve({ commits: true, uncommitted: 0, tracked: new Set() })
      let commits = true, uncommitted = 0
      const tracked = new Set<string>()
      for (const line of out.split('\n')) {
        if (line.startsWith('# branch.oid ')) commits = !line.includes('(initial)')
        else if (line && !line.startsWith('#')) {
          uncommitted++
          if (line[0] === '1' || line[0] === '2') tracked.add(line.split(' ').slice(8).join(' '))
        }
      }
      resolve({ commits, uncommitted, tracked })
    })
  })
}

export async function inspectProject(root: string): Promise<HealthReport> {
  const started = Date.now()
  const { files, truncated } = walk(root, started + 1500)
  const has = (f: string) => existsSync(join(root, f))
  const rootFiles = new Set(files.filter((f) => !f.rel.includes('/')).map((f) => f.rel))
  const rootHas = (re: RegExp) => [...rootFiles].some((f) => re.test(f))

  // ---- stack ----
  const pkg = readJson(join(root, 'package.json'))
  const deps: Record<string, string> = { ...pkg?.dependencies, ...pkg?.devDependencies }
  const stack: string[] = []
  const add = (...t: string[]) => { for (const x of t) if (!stack.includes(x)) stack.push(x) }
  const pyText = ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'Pipfile', 'setup.py'].map((f) => readText(join(root, f)).toLowerCase()).join('\n')
  const hasPy = !!pyText.trim() || files.some((f) => f.rel.endsWith('.py'))
  const htmlFiles = files.filter((f) => MARKUP.has(extname(f.rel).toLowerCase()))
  if (pkg) add('node')
  if (has('tsconfig.json') || deps.typescript) add('typescript')
  const NODE_FW: Record<string, string> = { next: 'next', react: 'react', vue: 'vue', svelte: 'svelte', '@sveltejs/kit': 'svelte', express: 'express', fastify: 'fastify', koa: 'koa', hono: 'hono', 'discord.js': 'discord.js', telegraf: 'telegraf', grammy: 'grammy', 'node-telegram-bot-api': 'node-telegram-bot-api', mineflayer: 'mineflayer', prisma: 'prisma', '@prisma/client': 'prisma', mongoose: 'mongoose', sequelize: 'sequelize', typeorm: 'typeorm', 'drizzle-orm': 'drizzle', electron: 'electron', vite: 'vite', tailwindcss: 'tailwind', expo: 'expo', 'react-native': 'react-native', 'socket.io': 'socket.io' }
  for (const [d, t] of Object.entries(NODE_FW)) if (deps[d]) add(t)
  if (hasPy) {
    add('python')
    const PY_FW: [string, RegExp][] = [['flask', /(^|[^\w-])flask([^\w-]|$)/], ['django', /(^|[^\w-])django([^\w-]|$)/], ['fastapi', /fastapi/], ['discord.py', /discord\.py|(^|\n)discord([^\w-]|$)/], ['python-telegram-bot', /python-telegram-bot/], ['aiogram', /aiogram/], ['streamlit', /streamlit/], ['pandas', /pandas/], ['sqlalchemy', /sqlalchemy/], ['pytest', /pytest/]]
    for (const [t, re] of PY_FW) if (re.test(pyText)) add(t)
  }
  if (has('Cargo.toml')) add('rust')
  if (has('go.mod')) add('go')
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) add('java')
  if (has('composer.json') || files.some((f) => f.rel.endsWith('.php'))) { add('php'); if (/laravel\/framework/.test(readText(join(root, 'composer.json')))) add('laravel') }
  if (htmlFiles.length) add('html')
  if (htmlFiles.length && !['node', 'python', 'rust', 'go', 'java', 'php'].some((l) => stack.includes(l))) add('static')

  // ---- one pass over file contents ----
  const gi = readText(join(root, '.gitignore'))
  const ignored = ignoreMatcher(gi)
  const f: Facts = {
    files: files.length, truncated, sourceFiles: 0, testFiles: 0, testCommand: detectVerify(root), lint: null, format: null, tsStrict: null,
    readme: 'missing', license: false, gitignoreNodeModules: null, gitignoreEnv: ignored('.env'), envFiles: [], envExample: false, ci: false, docker: false,
    lockfile: null, engines: null, todos: 0, consoleLogs: 0, debuggers: 0, emptyCatches: 0, git: { repo: has('.git'), commits: true, remote: true, uncommitted: 0 },
  }
  const secretHits: string[] = []
  const bigSource: string[] = []
  const bigImages: string[] = []
  const htmlNoLang: string[] = [], htmlNoViewport: string[] = [], htmlNoTitle: string[] = []
  let imgNoAlt = 0
  const imgNoAltFiles = new Set<string>()
  let envReads = 0
  const bySig = new Map<string, string[]>()
  let budget = READ_BUDGET
  for (const e of files) {
    const ext = extname(e.rel).toLowerCase()
    const name = basename(e.rel)
    const code = CODE.has(ext)
    if (code) f.sourceFiles++
    if (isTest(e.rel) && (code || ext === '.go')) f.testFiles++
    if (e.size > BIG && (code || MARKUP.has(ext) || ext === '.css') && !/\.min\./.test(name)) bigSource.push(e.rel)
    if (e.size > BIG && IMAGES.has(ext)) bigImages.push(e.rel)
    if (e.size >= 5000 && !/lock|\.min\.|^LICENSE/i.test(name) && (code || MARKUP.has(ext) || ext === '.css' || IMAGES.has(ext))) {
      const k = `${name}|${e.size}`
      bySig.set(k, [...(bySig.get(k) ?? []), e.rel])
    }
    const isEnvFile = name === '.env' || (name.startsWith('.env.') && !/\.(example|sample|template|dist)$/.test(name))
    if (!e.rel.includes('/') && isEnvFile) f.envFiles.push(name)
    if (!e.rel.includes('/') && /^\.env\.(example|sample|template|dist)$/.test(name)) f.envExample = true
    const readable = code || MARKUP.has(ext) || CONFIG.has(ext) || isEnvFile
    if (!readable || e.size > READ_MAX || budget <= 0 || /package-lock|\.min\./.test(name)) continue
    budget -= e.size
    const text = readText(e.abs)
    if (!text) continue
    const test = isTest(e.rel)
    if (!test && !ignored(e.rel)) {
      const lines = text.split('\n')
      for (let i = 0; i < lines.length && secretHits.length < 20; i++) {
        const line = lines[i]
        if (line.length > 2000) continue
        for (const [, re] of SECRETS) { const m = re.exec(line); if (m && !PLACEHOLDER.test(m[0]) && !PLACEHOLDER.test(line)) { secretHits.push(`${e.rel}:${i + 1}`); break } }
      }
    }
    if (code) {
      f.todos += (text.match(/\b(?:TODO|FIXME|HACK)\b/g) ?? []).length
      if (!test) {
        f.consoleLogs += (text.match(/\bconsole\.log\(/g) ?? []).length
        f.debuggers += (text.match(/^\s*debugger;?\s*$/gm) ?? []).length
        f.emptyCatches += (text.match(/catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\n\s*)?\}/g) ?? []).length + (text.match(/except[^\n:]*:\s*\n\s*pass\b/g) ?? []).length
        if (/process\.env\.|import\.meta\.env\.|os\.environ|os\.getenv/.test(text)) envReads++
      }
    }
    if (MARKUP.has(ext) || ext === '.jsx' || ext === '.tsx' || ext === '.vue' || ext === '.svelte') {
      const noAlt = (text.match(/<img\b[^>]*>/gi) ?? []).filter((t) => !/\balt\s*=/i.test(t) && !t.includes('{...')).length
      if (noAlt) { imgNoAlt += noAlt; imgNoAltFiles.add(e.rel) }
    }
    if (MARKUP.has(ext) && /<html[\s>]/i.test(text)) {
      if (!/<html[^>]*\blang\s*=/i.test(text)) htmlNoLang.push(e.rel)
      if (/<head[\s>]/i.test(text) && !/name\s*=\s*["']viewport["']/i.test(text)) htmlNoViewport.push(e.rel)
      if (!/<title[\s>]/i.test(text)) htmlNoTitle.push(e.rel)
    }
  }

  // ---- project-level files ----
  const readmeName = [...rootFiles].find((n) => /^readme(\.\w+)?$/i.test(n))
  if (readmeName) {
    const t = readText(join(root, readmeName))
    f.readme = t.trim().length < 300 ? 'short' : /\b(?:npm|yarn|pnpm|bun)\s+(?:install|i|run|start|test|ci)\b|\bnpx\b|pip3? install|python3? |cargo (?:run|build)|go (?:run|build)|docker|\bmake\b|\bnode\s/i.test(t) ? 'ok' : 'no-run-steps'
  }
  f.license = rootHas(/^(licen[sc]e|copying)(\.\w+)?$/i) || !!pkg?.license
  f.ci = existsSync(join(root, '.github', 'workflows')) && readdirSync(join(root, '.github', 'workflows')).some((n) => /\.ya?ml$/.test(n)) || ['.gitlab-ci.yml', '.circleci', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml'].some(has)
  f.docker = files.some((e) => /(^|\/)Dockerfile(\.\w+)?$/.test(e.rel))
  const isNode = !!pkg
  if (isNode || has('node_modules')) f.gitignoreNodeModules = ignored('node_modules/x')
  if (isNode) {
    f.lockfile = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'].some(has)
    f.engines = !!pkg?.engines || !!pkg?.volta || ['.nvmrc', '.node-version', '.tool-versions'].some(has)
    f.lint = !!(deps.eslint || deps['@biomejs/biome'] || pkg?.eslintConfig || pkg?.scripts?.lint) || rootHas(/^(\.eslintrc(\..+)?|eslint\.config\..+|biome\.jsonc?)$/)
    f.format = !!(deps.prettier || deps['@biomejs/biome'] || pkg?.prettier) || rootHas(/^(\.prettierrc(\..+)?|prettier\.config\..+|biome\.jsonc?|\.editorconfig)$/)
  } else if (hasPy) {
    f.lockfile = ['poetry.lock', 'Pipfile.lock', 'uv.lock'].some(has) || /==/.test(readText(join(root, 'requirements.txt')))
    f.lint = /\[tool\.(ruff|flake8|pylint)|\bruff\b|flake8|pylint/.test(pyText) || rootHas(/^(ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|setup\.cfg)$/)
    f.format = /\[tool\.(black|ruff)|\bblack\b/.test(pyText) || has('ruff.toml')
  }
  const ts = readText(join(root, 'tsconfig.json'))
  if (ts) { const strip = ts.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ''); f.tsStrict = /"strict"\s*:\s*true/.test(strip) ? true : /"extends"/.test(strip) && !/"strict"/.test(strip) ? null : false }
  if (!f.testFiles && has('Cargo.toml')) f.testFiles = files.some((e) => e.rel.startsWith('tests/')) ? 1 : 0

  // ---- git ----
  let trackedEnv = false
  if (f.git.repo) {
    const cfg = statSync(join(root, '.git')).isDirectory() ? readText(join(root, '.git', 'config')) : '[remote "worktree"]'
    f.git.remote = /\[remote "/.test(cfg)
    const g = await gitState(root)
    f.git.commits = g.commits
    f.git.uncommitted = g.uncommitted
    // The status call only lists tracked files that changed; the index itself tells whether a clean .env was committed long ago.
    // ponytail: v2 index entries only (the common case); an index in v4 format would miss this, upgrade to `git ls-files` if that matters.
    let idx = ''
    try { if (statSync(join(root, '.git', 'index')).size < 8 * 1024 * 1024) idx = readFileSync(join(root, '.git', 'index')).toString('latin1') } catch {}
    trackedEnv = [...g.tracked].some((p) => /(^|\/)\.env(\.(?!example|sample|template|dist)[\w.-]+)?$/.test(p)) || /\x00[\x04-\x40](?:[\w.-]+\/)*\.env(?:\.(?:local|production|prod|dev|development))?\x00/.test(idx)
  }

  // ---- suggestions ----
  const out: Suggestion[] = []
  const S = (id: string, area: Area, severity: Severity, title: string, why: string, evidence: string[], goal: string, effortMinutes: number) => out.push({ id, area, severity, title, why, evidence, goal, effortMinutes })
  const webish = ['next', 'react', 'vue', 'svelte', 'html', 'static'].some((t) => stack.includes(t))
  const serverish = ['express', 'fastify', 'koa', 'hono', 'flask', 'django', 'fastapi', 'next', 'discord.js', 'telegraf', 'grammy', 'discord.py', 'python-telegram-bot', 'aiogram'].some((t) => stack.includes(t))
  const more = (n: number) => (n > 5 ? [`and ${n - 5} more`] : [])

  if (secretHits.length)
    S('secrets-in-code', 'security', 'high', 'Secret-looking keys in the code', 'Keys that sit in files end up in git history and on GitHub, where bots find them within minutes.',
      [`${plural(secretHits.length, 'place')}: ${secretHits.slice(0, 5).join(', ')}`, ...more(secretHits.length)],
      'Find every hard-coded key, token and private key in this project (see the files listed in the evidence and search for others). Move each into an environment variable read through one config module, add the names to `.env.example` with placeholder values, make sure `.env` is in `.gitignore`, and list in your final report which keys must be rotated because they were committed. Do not print the secret values anywhere.', 30)
  if (trackedEnv || (f.envFiles.length && !f.gitignoreEnv))
    S('env-not-ignored', 'security', 'high', trackedEnv ? 'An .env file is committed to git' : 'The .env file is not git-ignored', 'Anything in .env is meant to stay private, and one careless commit publishes it for good.',
      [trackedEnv ? '.env is tracked by git' : `${f.envFiles.join(', ')} present but not covered by .gitignore`],
      'Add `.env` and `.env.*` (except `.env.example`) to `.gitignore`. If a .env file is already tracked, remove it from the index with `git rm --cached` without deleting the file, and create `.env.example` with the variable names and placeholder values. Note in the final report that any keys that were committed must be rotated.', 10)
  if (f.gitignoreNodeModules === false)
    S('gitignore-node-modules', 'tooling', 'medium', 'node_modules is not git-ignored', 'Committing dependencies bloats the repository and makes every change noisy.', [gi ? '.gitignore has no node_modules entry' : 'no .gitignore file'],
      'Create or extend `.gitignore` for this stack: `node_modules/`, build output folders (`dist`, `build`, `.next`), `.env` and `.env.*` except `.env.example`, log files and editor folders. If node_modules or build output is already tracked, remove it from the index with `git rm -r --cached` without deleting local files.', 5)
  if (f.sourceFiles >= 3 && !f.testFiles && !f.testCommand)
    S('no-tests', 'tests', 'medium', 'No automated tests', 'Without tests every change is a gamble and bugs come back unnoticed.', [`${plural(f.sourceFiles, 'source file')}, no test files, no test script`],
      'Add automated tests for the most important logic of this project: pick the standard tool for the stack (Vitest or Jest for Node, pytest for Python), add a `test` script (or `pytest.ini`), and write tests for the three most important functions or user flows covering a normal case, a failure case and an edge case. Keep them fast and offline, and make sure the test command passes.', 60)
  else if (f.testFiles && !f.testCommand && isNode)
    S('no-test-script', 'tests', 'medium', 'Tests exist but nothing runs them', 'A test nobody runs does not protect anything, and agents cannot verify their work without a command.', [`${plural(f.testFiles, 'test file')}, no working "test" script in package.json`],
      'Add a working `test` script to package.json that runs the existing test files with the tool they are written for, fix any tests that fail to run, and mention the command in the README.', 15)
  if (f.emptyCatches)
    S('empty-catch', 'quality', f.emptyCatches >= 5 ? 'medium' : 'low', 'Errors are swallowed silently', 'An empty catch hides real failures, so bugs show up later as mysterious behaviour.', [`${plural(f.emptyCatches, 'empty catch or except block')}`],
      'Find every empty `catch` block and bare `except: pass` in the source (not tests). For each one decide whether to handle the error, log it with context, or rethrow; keep a block empty only where ignoring the error is truly intended, and then add a one-line comment saying why.', 25)
  if (f.debuggers || f.consoleLogs >= 10)
    S('debug-leftovers', 'quality', f.debuggers ? 'medium' : 'low', 'Debug statements left in the code', 'Leftover logging is noise in production and can leak data.', [f.debuggers ? `${plural(f.debuggers, 'debugger statement')}` : '', `${plural(f.consoleLogs, 'console.log call')}`].filter(Boolean),
      'Remove every `debugger` statement and every `console.log` used only for debugging from the source (not tests or CLI output that users are meant to see). Where a message is genuinely useful, replace it with a small logger that respects a `LOG_LEVEL` setting.', 20)
  if (f.todos >= 5)
    S('todo-pile', 'quality', 'low', 'A pile of TODO and FIXME notes', 'Old notes to self are unfinished work that is easy to forget.', [`${plural(f.todos, 'TODO, FIXME or HACK comment')}`],
      'List every TODO, FIXME and HACK comment in the source in a new `TODO.md` grouped by file with the line text. Fix the ones that are small and clear, and for the rest rewrite the comment so it says what is needed and why.', 30)
  if (bigSource.length)
    S('huge-files', 'quality', 'medium', 'Very large source files', 'Files over 1 MB are slow to open, hard to review and often generated or pasted data.', [...bigSource.slice(0, 5), ...more(bigSource.length)],
      'Look at the very large source files listed in the evidence. If they are data, move them to a data file loaded at run time; if generated, exclude them from git and regenerate them in a build step; if hand-written, split them into modules of a reasonable size without changing behaviour.', 40)
  const dupes = [...bySig.values()].filter((g) => g.length > 1 && new Set(g.map((p) => p.slice(0, p.lastIndexOf('/')))).size > 1)
  if (dupes.length)
    S('duplicate-files', 'quality', 'low', 'Duplicated files', 'Copies drift apart over time, so a fix in one place is missing in the others.', dupes.slice(0, 4).map((g) => g.slice(0, 3).join(' = ')),
      'Check the groups of same-named, same-sized files in the evidence. For each group that is a true duplicate, keep one copy in a shared location, point the other places to it (import, symlink or build step) and delete the copies. Leave files that merely look alike but are meant to differ.', 25)
  if (f.lint === false && f.sourceFiles >= 5)
    S('no-lint', 'tooling', 'low', f.format === false ? 'No linter or formatter' : 'No linter', 'A linter catches typos, unused code and risky patterns before you run anything.', [`${plural(f.sourceFiles, 'source file')} and no lint configuration`],
      `Add ${isNode ? 'ESLint (flat config) and Prettier, or Biome,' : 'Ruff for linting and formatting'} with a conservative config, add \`lint\` ${isNode ? 'and \`format\` ' : ''}scripts or commands, fix the errors that are safe to fix automatically, and list in the final report the remaining warnings. Do not change behaviour.`, 25)
  if (f.tsStrict === false)
    S('ts-not-strict', 'quality', 'medium', 'TypeScript strict mode is off', 'Strict mode finds null mistakes and wrong types that otherwise crash at run time.', ['tsconfig.json does not enable "strict"'],
      'Turn on `"strict": true` in tsconfig.json and fix the resulting type errors properly: add real types and null checks instead of `any` or `// @ts-ignore`. If there are too many errors to fix at once, enable strict first for the newest folders using a second tsconfig and report the plan.', 60)
  const bad = pkg ? Object.keys(deps).filter((d) => DEPRECATED.includes(d)) : []
  const badPy = hasPy ? PY_DEPRECATED.filter((d) => new RegExp(`(^|\\n)${d}([^\\w-]|$)`).test(pyText)) : []
  if (bad.length || badPy.length)
    S('deprecated-deps', 'quality', 'medium', 'Deprecated or unmaintained packages', 'Abandoned packages stop getting security fixes.', [...bad, ...badPy].map((d) => `${d}`),
      `Replace these deprecated packages with their maintained successors: ${[...bad, ...badPy].join(', ')} (for example request with the built-in fetch or undici, moment with date-fns or Temporal, node-sass with sass, tslint with ESLint, sklearn with scikit-learn). Update every import, remove the old packages and make sure the build and tests still pass.`, 40)
  const loose = Object.entries(pkg?.dependencies ?? {}).concat(Object.entries(pkg?.devDependencies ?? {})).filter(([, v]) => /^(\*|latest|x|)$/.test(String(v).trim())).map(([k, v]) => `${k}@${v || '""'}`)
  const reqLoose = readText(join(root, 'requirements.txt')).split('\n').map((l) => l.trim()).filter((l) => l && !/^[#-]/.test(l) && !/[=<>~@]|:\/\//.test(l))
  if (loose.length || reqLoose.length)
    S('loose-versions', 'tooling', 'medium', 'Dependencies without a pinned version', 'An unpinned dependency can change under you on the next install and break a working project.', [...loose, ...reqLoose].slice(0, 6),
      'Pin every dependency that has no version or uses `*`, `latest` or an empty range: install the currently resolved version, write it to the manifest (a caret range for Node, `==` for requirements.txt), regenerate the lockfile, and confirm the project still builds and its tests pass.', 15)
  if (f.lockfile === false)
    S('no-lockfile', 'tooling', 'medium', 'No lockfile', 'Without a lockfile, two installs can pull different versions, so it works on your machine and fails elsewhere.', [isNode ? 'package.json present, no package-lock.json, yarn.lock or pnpm-lock.yaml' : 'no lock file or pinned requirements'],
      isNode ? 'Generate a lockfile with the package manager the project already uses (npm by default), commit it, and use `npm ci` in the README and any CI.' : 'Pin the Python dependencies with exact versions in requirements.txt (or a lock file from uv or Poetry) and document how to install from it.', 10)
  if (isNode && f.engines === false)
    S('no-engines', 'tooling', 'low', 'No Node version declared', 'People and servers using a different Node version hit confusing errors.', ['no "engines" in package.json, no .nvmrc'],
      'Declare the supported Node version in `package.json` `engines` and in an `.nvmrc` file, matching what the project actually runs on, and mention it in the README requirements.', 5)
  if (f.readme === 'missing')
    S('readme-missing', 'docs', 'medium', 'No README', 'The README is the front door: nobody, including future you, can run a project without it.', ['no README file at the project root'],
      'Write a README.md with what the project does, the requirements, install and run steps using the real commands from this project, how to run the tests, the environment variables from `.env.example`, and a short map of the main folders. Check each command works.', 20)
  else if (f.readme !== 'ok')
    S('readme-thin', 'docs', 'low', f.readme === 'short' ? 'The README is very short' : 'The README has no run steps', 'Visitors want to know how to run it within a minute.', [f.readme === 'short' ? 'README under 300 characters' : 'README mentions no install or run command'],
      'Expand the README with install and run steps using the real commands from this project, how to run the tests, the required environment variables, and a short description of the main folders. Verify each command works.', 15)
  if (!f.license && f.sourceFiles >= 3)
    S('no-license', 'docs', 'low', 'No license', 'Without a license nobody else may legally use or build on the code.', ['no LICENSE file and no "license" field'],
      'Add a LICENSE file (MIT unless the README or owner says otherwise) with the current year and the repository owner\'s name from git config, and set the `license` field in the package manifest.', 5)
  if (!f.ci && f.sourceFiles >= 5 && f.git.repo)
    S('no-ci', 'tooling', f.testCommand ? 'medium' : 'low', 'No automatic checks on push', 'Continuous integration runs the tests for you on every push, so a broken commit is caught at once.', ['no .github/workflows or other CI config'],
      `Add a GitHub Actions workflow (\`.github/workflows/ci.yml\`) that runs on push and pull requests: install dependencies with caching, ${f.lint ? 'run the linter, ' : ''}run the tests${f.testCommand ? ` (\`${f.testCommand}\`)` : ''} and the build, using the language version the project declares.`, 20)
  if (!f.docker && serverish)
    S('no-dockerfile', 'tooling', 'low', 'No Dockerfile', 'A container makes it easy to run the app the same way on any server.', ['server or bot project with no Dockerfile'],
      'Add a multi-stage Dockerfile for this project that installs only production dependencies, runs as a non-root user and starts the app, a `.dockerignore` excluding `node_modules`, `.git` and `.env`, and document the build and run commands in the README.', 25)
  if (stack.includes('express') || stack.includes('fastify')) {
    if (!deps.helmet && !deps['@fastify/helmet'])
      S('no-security-headers', 'security', 'medium', 'No security headers', 'Browsers block whole attack types when a server sends the right headers.', [`${stack.includes('express') ? 'express' : 'fastify'} app without helmet`],
        'Add the helmet middleware (`@fastify/helmet` for Fastify) with a Content-Security-Policy that matches what the pages actually load, make session cookies HttpOnly and SameSite, and verify the pages still work. Add a test that checks the headers.', 20)
  }
  if (envReads && !f.envExample)
    S('no-env-example', 'docs', 'low', 'Environment variables are not documented', 'New contributors, and you in six months, will not know which variables the app needs.', [`${plural(envReads, 'file')} read environment variables, no .env.example`],
      'Find every environment variable the code reads and create `.env.example` with each name, a placeholder value and a one-line comment saying what it is for. Mention it in the README, and make the app fail early with a clear message when a required variable is missing.', 15)
  if (!f.git.repo)
    S('no-git', 'tooling', 'medium', 'The project is not under git', 'Without version control there is no history and no way back from a bad change.', ['no .git folder'],
      'Initialise a git repository, add a `.gitignore` suited to this stack, and make a first commit containing only the files that belong in the repository.', 5)
  else {
    if (!f.git.commits)
      S('git-no-commits', 'tooling', 'medium', 'Git has no commits yet', 'Nothing is saved in history until the first commit.', ['repository has no commits'], 'Make sure `.gitignore` is right, then create a first commit with a clear message containing the project files.', 5)
    else if (!f.git.remote)
      S('git-no-remote', 'tooling', 'low', 'No remote repository', 'Everything lives on one disk, so a dead laptop would take the project with it.', ['no remote configured'],
        'Prepare the project to be pushed to a remote: make sure `.gitignore` and the README are correct and no secrets are committed, and write the exact commands to add a GitHub remote and push in the final report (do not push yourself).', 10)
    if (f.git.uncommitted >= 20)
      S('git-many-uncommitted', 'tooling', 'low', 'A lot of uncommitted work', 'Large uncommitted changes are hard to undo and easy to lose.', [`${plural(f.git.uncommitted, 'changed file')}`],
        'Group the uncommitted changes into a few logical commits with clear messages (do not push), leaving out generated files and anything that belongs in `.gitignore`.', 10)
  }
  if (htmlNoLang.length)
    S('html-lang', 'accessibility', 'medium', 'Pages without a language', 'Screen readers pick the wrong voice and browsers offer wrong translations without the lang attribute.', [...htmlNoLang.slice(0, 5), ...more(htmlNoLang.length)],
      'Add the right `lang` attribute (for example `lang="en"`) to the `<html>` element of every full page listed in the evidence and of any template that renders a page shell.', 5)
  if (htmlNoViewport.length)
    S('html-viewport', 'ux', 'medium', 'Pages that are not mobile-ready', 'Without a viewport tag phones show a tiny zoomed-out desktop page.', [...htmlNoViewport.slice(0, 5), ...more(htmlNoViewport.length)],
      'Add `<meta name="viewport" content="width=device-width, initial-scale=1">` to every page listed in the evidence, then check each page at 360px width and fix anything that overflows horizontally.', 15)
  if (imgNoAlt)
    S('img-alt', 'accessibility', 'medium', 'Images without alt text', 'People using screen readers get nothing from an image with no alternative text.', [`${plural(imgNoAlt, 'image')} in ${[...imgNoAltFiles].slice(0, 4).join(', ')}${imgNoAltFiles.size > 4 ? ` and ${imgNoAltFiles.size - 4} more` : ''}`],
      'Add a meaningful `alt` attribute to every `<img>` in the files listed in the evidence: describe informative images briefly and use `alt=""` for purely decorative ones. Do not stuff keywords.', 15)
  if (htmlNoTitle.length)
    S('html-title', 'ux', 'low', 'Pages without a title', 'The title is what appears in browser tabs, bookmarks and search results.', [...htmlNoTitle.slice(0, 5), ...more(htmlNoTitle.length)],
      'Give every full page listed in the evidence a short, unique `<title>` that says what the page is.', 5)
  if (bigImages.length && (webish || stack.includes('html')))
    S('big-images', 'performance', 'medium', 'Very large images', 'Multi-megabyte images are the usual reason a page feels slow on a phone.', [...bigImages.slice(0, 5), ...more(bigImages.length)],
      'Resize and compress the images listed in the evidence to the size they are really shown at (at most 1600px wide for photos), convert photos to WebP with a fallback if needed, keep the originals outside the served folder, and add `loading="lazy"` plus `width` and `height` attributes.', 25)

  const rank = { high: 0, medium: 1, low: 2 }
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.effortMinutes - b.effortMinutes)
  return { stack, facts: f, suggestions: out.slice(0, 25) }
}
