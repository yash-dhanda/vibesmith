// Where the AI engine lives. Normally this computer; the user can point Forge at Ollama on another machine
// (for example a desktop with a big graphics card). Kept free of Electron so the eval script and tests can use it.

export const DEFAULT_HOST = 'http://127.0.0.1:11434'
let host = DEFAULT_HOST
let vramGB = 24 // Ollama does not report a remote card's memory, so the user says what it has (used to rate models for it)

export const getHost = () => host
export const isRemote = () => host !== DEFAULT_HOST
export const remoteVramGB = () => vramGB

// Returns the cleaned address, or throws with a message fit to show the user. '' means this computer.
export function normalizeHost(input: string): string {
  const t = input.trim()
  if (!t) return DEFAULT_HOST
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t)) throw new Error('The address must start with http:// or https://.')
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(t) ? t : `http://${t}`)
  } catch {
    throw new Error('That is not a valid address. Try something like 192.168.1.20:11434.')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The address must start with http:// or https://.')
  if (u.username || u.password) throw new Error('Do not put a username or password in the address.')
  if (!u.port && u.protocol === 'http:') u.port = '11434'
  return u.origin
}

export function setHost(input: string, vram?: number) {
  host = normalizeHost(input)
  if (vram && vram > 0 && vram <= 1024) vramGB = Math.round(vram)
  return host
}
