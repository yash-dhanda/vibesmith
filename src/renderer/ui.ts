// Small DOM helpers shared by every renderer module.
import { icon } from './icons'
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export const h = (tag: string, cls = '', text = '') => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

// An emoji for meaning; the words stay in the control's title / aria-label.
export const emo = (glyph: string) => {
  const s = h('span', 'emo', glyph)
  s.setAttribute('aria-hidden', 'true')
  return s
}

// A call the phone could not send (the link is down) says so in words; the link reconnects by itself.
export const NO_LINK = 'No connection. Retrying.'
export const cleanErr = (e: unknown) => { const m = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); return /^(Failed to fetch|Load failed|NetworkError|The network connection was lost)/i.test(m) ? NO_LINK : m }

// A toast is a small card: icon tile, a bold first sentence, the rest muted, an optional white action and a close button.
export function toast(msg: string, ms = 1800, action?: { label: string; run: () => void }) {
  if (msg === NO_LINK && [...$('toasts').children].some((t) => t.textContent?.startsWith('No connection'))) return // one at a time
  const m = msg.match(/^(.+?[.!?])\s+(.+)$/s) ?? msg.match(/^(.+?) · (.+)$/s)
  const t = h('div', 'toast')
  t.setAttribute('role', 'status')
  const tile = h('span', 'toast-icon')
  tile.append(icon(action ? 'info' : 'bell', 'sm'))
  const copy = h('div', 'toast-copy')
  copy.append(h('strong', '', m ? m[1] : msg))
  if (m) copy.append(h('p', '', m[2]))
  let timer: ReturnType<typeof setTimeout>
  const close = () => {
    clearTimeout(timer)
    t.classList.add('out')
    t.addEventListener('animationend', () => t.remove(), { once: true })
    setTimeout(() => t.remove(), 400) // reduced motion: no animationend fires
  }
  if (action) {
    const b = h('button', 'btn primary tbtn', action.label)
    b.onclick = () => {
      t.remove()
      action.run()
    }
    copy.append(b)
  }
  const x = h('button', 'icon-btn sm toast-x')
  x.append(icon('x', 'sm'))
  x.title = 'Dismiss'
  x.setAttribute('aria-label', 'Dismiss')
  x.onclick = close
  t.append(tile, copy, x)
  $('toasts').append(t)
  timer = setTimeout(close, action ? Math.max(ms, 6000) : Math.max(ms, 2400))
}

// A segmented choice; the selected part has the lighter fill.
export function seg<T extends string>(options: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  const wrap = h('div', 'seg')
  wrap.setAttribute('role', 'group')
  for (const [v, label] of options) {
    const b = h('button', v === value ? 'on' : '', label) as HTMLButtonElement
    b.setAttribute('aria-pressed', String(v === value))
    b.type = 'button'
    b.onclick = () => {
      wrap.querySelectorAll('button').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false') })
      b.classList.add('on')
      b.setAttribute('aria-pressed', 'true')
      onPick(v)
    }
    wrap.append(b)
  }
  return wrap
}

// Booleans are an Off | On pair, not a checkbox.
export const onOff = (on: boolean, onChange: (v: boolean) => void) => seg<'off' | 'on'>([['off', 'Off'], ['on', 'On']], on ? 'on' : 'off', (v) => onChange(v === 'on'))

// The phone link is plain http on the Tailscale address, which browsers do not count as secure: no crypto.randomUUID and no
// navigator.clipboard there. These fall back to what works everywhere.
export const uuid = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}
export async function writeClipboard(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
  const t = document.createElement('textarea')
  t.value = text
  t.setAttribute('readonly', '')
  t.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'
  document.body.append(t)
  t.select()
  t.setSelectionRange(0, text.length)
  const ok = document.execCommand('copy')
  t.remove()
  if (!ok) throw new Error('copy refused')
}

export async function copy(text: string, what = 'Copied') {
  try {
    await writeClipboard(text)
    toast(what)
  } catch {
    toast('Could not copy')
  }
}

// A small popup under an element. It closes on the next click anywhere or on Escape.
export function showMenu(anchor: HTMLElement, items: { label: string; danger?: boolean; run: () => void }[]) {
  const menu = $('menu')
  menu.replaceChildren(
    ...items.map((i) => {
      const b = h('button', i.danger ? 'danger' : '', i.label)
      b.onclick = () => {
        menu.hidden = true
        i.run()
      }
      return b
    }),
  )
  const r = anchor.getBoundingClientRect()
  menu.hidden = false
  menu.style.top = r.bottom + 4 + 'px'
  menu.style.left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth)) + 'px'
  const close = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== 'Escape') return
    menu.hidden = true
    removeEventListener('click', close, true)
    removeEventListener('keydown', close, true)
  }
  setTimeout(() => {
    addEventListener('click', close, true)
    addEventListener('keydown', close, true)
  })
}

// ---- theme: dark by default, light, or follow the system ----
export type ThemePref = 'dark' | 'light' | 'system'
export const themePref = (): ThemePref => {
  try {
    const t = localStorage.getItem('forge.theme')
    return t === 'light' || t === 'system' ? t : 'dark'
  } catch {
    return 'dark'
  }
}
export function applyTheme(pref: ThemePref = themePref()) {
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  window.dispatchEvent(new Event('forge-theme')) // the editor and terminal listen for this
}
export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem('forge.theme', pref)
  } catch {}
  applyTheme(pref)
}

export function numCtxPref(): number {
  try {
    const n = Number(localStorage.getItem('forge.numctx'))
    return [4096, 8192, 16384, 32768].includes(n) ? n : 8192
  } catch {
    return 8192
  }
}

const pick = (key: string, allowed: number[], fallback: number) => {
  try {
    const n = Number(localStorage.getItem(key))
    return allowed.includes(n) ? n : fallback
  } catch {
    return fallback
  }
}
export const STEP_CHOICES = [25, 50, 100, 200]
export const MINUTE_CHOICES = [15, 30, 60, 120]
// How long one run may go on: more steps and time for big builds, fewer to stay cautious.
export const agentLimits = () => ({ maxSteps: pick('forge.maxsteps', STEP_CHOICES, 50), maxMinutes: pick('forge.maxmin', MINUTE_CHOICES, 30), cloudContext: cloudContextPref() })
// Tokens sent to cloud models before old tool output is trimmed; 0 means automatic by model.
export function cloudContextPref(): number {
  try {
    const n = Math.round(Number(localStorage.getItem('forge.cloudctx')))
    return n > 0 ? n : 0
  } catch {
    return 0
  }
}
