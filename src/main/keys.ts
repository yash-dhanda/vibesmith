import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type KeyProvider = 'anthropic' | 'openai' | 'openrouter'
export const KEY_PROVIDERS: KeyProvider[] = ['anthropic', 'openai', 'openrouter']

// Keys live encrypted with the OS keychain (safeStorage). The renderer can set, clear and ask "is there one"; it can never read one back.
const file = () => join(app.getPath('userData'), 'keys.json')
const load = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    return {}
  }
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
  const v = load()[p]
  if (!v) return null
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'))
  } catch {
    return null // keychain changed or file copied from another machine
  }
}

export const keyStatus = (): Record<KeyProvider, boolean> => ({ anthropic: !!getKey('anthropic'), openai: !!getKey('openai'), openrouter: !!getKey('openrouter') })
