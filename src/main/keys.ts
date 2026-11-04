import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type KeyProvider = 'anthropic' | 'openai' | 'openrouter'
export const KEY_PROVIDERS: KeyProvider[] = ['anthropic', 'openai', 'openrouter']

// Keys live encrypted with the OS keychain (safeStorage). The renderer can set, clear and ask "is there one"; it can never read one back.
const file = () => join(app.getPath('userData'), 'keys.json')
// A missing file means no keys yet. A file that cannot be read throws, so setKey/clearKey never write over keys that are still there;
// a file that is not valid JSON is moved aside (it could not be read anyway) and the store starts empty.
const load = (): Record<string, string> => {
  let text: string
  try {
    text = readFileSync(file(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  try {
    const j = JSON.parse(text) as unknown
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, string>
  } catch {
    /* fall through: not JSON */
  }
  try {
    renameSync(file(), `${file()}.bad-${Date.now()}`)
  } catch {}
  return {}
}

function canStore(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  // On Linux without a keyring Electron falls back to a hardcoded password, which is plaintext in practice. Refuse that.
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

export function setKey(p: KeyProvider, key: string) {
  if (!KEY_PROVIDERS.includes(p)) throw new Error(`unknown provider "${p}"`)
  if (!key.trim()) throw new Error('empty key')
  if (!canStore()) throw new Error('No OS keychain is available (install and unlock gnome-keyring or KWallet), so the key cannot be stored safely.')
  const all = load()
  all[p] = safeStorage.encryptString(key.trim()).toString('base64')
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(all), { mode: 0o600 })
}

export function clearKey(p: KeyProvider) {
  const all = load()
  delete all[p]
  writeFileSync(file(), JSON.stringify(all), { mode: 0o600 })
}

export function getKey(p: KeyProvider): string | null {
  try {
    const v = load()[p]
    if (typeof v !== 'string' || !v) return null
    return safeStorage.decryptString(Buffer.from(v, 'base64'))
  } catch {
    return null // keychain changed or file copied from another machine
  }
}

export const keyStatus = (): Record<KeyProvider, boolean> => ({ anthropic: !!getKey('anthropic'), openai: !!getKey('openai'), openrouter: !!getKey('openrouter') })
