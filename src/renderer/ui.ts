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

export const cleanErr =(e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// A toast is a small card: icon tile, a bold first sentence, the rest muted, an optional white action and a close button.
export function toast(msg: string, ms = 1800, action?: { label: string; run: () => void }) {
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

export async function copy(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
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
export const agentLimits = () => ({ maxSteps: pick('forge.maxsteps', STEP_CHOICES, 50), maxMinutes: pick('forge.maxmin', MINUTE_CHOICES, 30) })
