// Small DOM helpers shared by every renderer module.
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export const h = (tag: string, cls = '', text = '') => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

export const cleanErr = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function toast(msg: string, ms = 1800) {
  const t = h('div', 'toast', msg)
  $('toasts').append(t)
  setTimeout(() => t.remove(), ms)
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
