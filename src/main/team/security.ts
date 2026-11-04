import type { Task } from './types'

const SENSITIVE_PATH = /auth(?!or)|session|passw|token|payment|checkout|withdraw|admin|secret|credential|\.env|login|jwt|oauth|crypto|billing/i
const DEPENDENCY_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[\w.-]*\.txt|pyproject\.toml|poetry\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/
const ROUTE_LINE = /^\+.*(\b(app|router|server|api|fastify|express)\.(get|post|put|patch|delete|all|use)\s*\(|@(Get|Post|Put|Patch|Delete|RequestMapping)\b|@(app|bp|router)\.(route|get|post|put|delete)\b|ipcMain\.(handle|on)\s*\(|\bhttp\.HandleFunc\s*\()/m

// Does this change touch what a security look is for: login, sessions, tokens, money, admin or secrets, new routes or handlers, or dependencies?
export function touchesSecurity(files: Pick<Task['changed'][number], 'path'>[], diff = ''): boolean {
  return files.some((f) => SENSITIVE_PATH.test(f.path) || DEPENDENCY_FILE.test(f.path)) || ROUTE_LINE.test(diff)
}

// A change that is only documentation or configuration cannot gain tests.
const DOCS_OR_CONFIG = /(^|\/)(docs?\/|\.github\/|LICENSE|CHANGELOG)|\.(md|mdx|rst|json|ya?ml|toml|ini|cfg|lock|env[\w.]*|gitignore|editorconfig)$/i
export const onlyDocsOrConfig = (files: Pick<Task['changed'][number], 'path'>[]): boolean => files.every((f) => DOCS_OR_CONFIG.test(f.path))
