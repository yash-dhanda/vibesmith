// Phones and small tablets: the sidebar becomes a drawer, and the page is fitted to the visible viewport so the on-screen keyboard
// never covers the composer. The same renderer runs on the desktop, where none of this does anything.
import { $, h } from './ui'
import { icon } from './icons'
import { N } from './names'

export const phone = matchMedia('(max-width: 800px)')
const touch = matchMedia('(hover: none)')
export const isRemote = () => (window as { __forgeRemote?: boolean }).__forgeRemote === true
// Set before anything is drawn: `html.remote` switches on the cheaper phone styles.
if (isRemote()) document.documentElement.classList.add('remote')

// What the phone last saw, so the next visit paints at once and refreshes behind it.
export function cacheGet<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem('forge.cache.' + key) ?? 'null') as T | null } catch { return null }
}
export function cacheSet(key: string, value: unknown) {
  try { localStorage.setItem('forge.cache.' + key, JSON.stringify(value)) } catch {}
}

// After the link was down, or iOS froze the page, every screen redraws what it shows from the computer.
const resyncs: (() => Promise<void>)[] = []
export const onResync = (fn: () => Promise<void>) => void resyncs.push(fn)
let resyncTimer: ReturnType<typeof setTimeout> | null = null
function resync(tries = 3) {
  if (resyncTimer) clearTimeout(resyncTimer)
  resyncTimer = setTimeout(async () => {
    resyncTimer = null
    const failed = (await Promise.allSettled(resyncs.map((fn) => fn()))).some((r) => r.status === 'rejected')
    if (failed && tries > 1) resync(tries - 1) // the network may still be waking up
  }, tries === 3 ? 250 : 3000)
}

function initConnection() {
  const bar = h('div', 'netbar'); bar.id = 'netbar'; bar.setAttribute('role', 'status'); bar.hidden = true
  bar.append(h('span', 'netbar-spin'), document.createTextNode('Reconnecting…'))
  document.body.append(bar)
  let off = false, show: ReturnType<typeof setTimeout> | null = null
  addEventListener('forge-remote-offline', () => { off = true; show ??= setTimeout(() => { bar.hidden = false }, 600) })
  addEventListener('forge-remote-online', () => {
    if (show) clearTimeout(show)
    show = null; bar.hidden = true
    if (off) { off = false; resync() }
  })
  addEventListener('forge-remote-resume', () => resync())
}

// The splash in index.html stays until the first screen is drawn.
export const bootDone = () => document.getElementById('boot')?.remove()

// Phone navigation: a bottom bar for Solo, Crew and Settings (hidden while the keyboard is up); the drawer keeps the chat list.
function initTabs() {
  const bar = h('nav', 'tabbar'); bar.id = 'tabbar'; bar.setAttribute('aria-label', 'Sections')
  const tab = (id: string, glyph: Parameters<typeof icon>[0], label: string, run: () => void) => {
    const b = h('button', 'tab-btn') as HTMLButtonElement; b.id = id; b.type = 'button'; b.append(icon(glyph), h('span', '', label)); b.onclick = run; bar.append(b); return b
  }
  const solo = tab('tab-solo', 'edit', N.solo, () => $('mode-chat').click())
  const crew = tab('tab-crew', 'users', N.crew, () => $('mode-team').click())
  tab('tab-settings', 'gear', 'Settings', () => $('gear').click())
  $('app').append(bar)
  const sync = () => {
    const team = $('app').classList.contains('team-mode')
    solo.setAttribute('aria-current', String(!team)); crew.setAttribute('aria-current', String(team))
    crew.hidden = $('mode-team').hidden
  }
  new MutationObserver(sync).observe($('app'), { attributes: true, attributeFilter: ['class'] })
  new MutationObserver(sync).observe($('mode-team'), { attributes: true, attributeFilter: ['hidden'] })
  sync()
}

export function toggleDrawer(open = !$('app').classList.contains('drawer')) {
  $('app').classList.toggle('drawer', open && phone.matches)
  $('scrim').hidden = !(open && phone.matches)
}

export function initPhone() {
  const side = $('history')
  $('scrim').onclick = () => toggleDrawer(false)
  // Going somewhere closes the drawer; deleting or renaming a chat does not.
  side.addEventListener('click', (e) => {
    if (phone.matches && (e.target as HTMLElement).closest('.chat-open, .side-btn, #side-new, .side-foot button')) toggleDrawer(false)
  })
  let x0 = 0, y0 = 0
  side.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY }, { passive: true })
  side.addEventListener('touchend', (e) => { const t = e.changedTouches[0]; if (t.clientX - x0 < -60 && Math.abs(t.clientY - y0) < 50) toggleDrawer(false) }, { passive: true })
  // A swipe in from the left edge opens it.
  let ex = -1, ey = 0
  addEventListener('touchstart', (e) => { const t = e.touches[0]; ex = phone.matches && t.clientX < 24 && !$('app').classList.contains('drawer') ? t.clientX : -1; ey = t.clientY }, { passive: true })
  addEventListener('touchend', (e) => { const t = e.changedTouches[0]; if (ex >= 0 && t.clientX - ex > 60 && Math.abs(t.clientY - ey) < 60) toggleDrawer(true); ex = -1 }, { passive: true })
  initTabs()
  if (isRemote()) initConnection()
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('app').classList.contains('drawer')) toggleDrawer(false) })
  phone.addEventListener('change', () => toggleDrawer(false))

  // The status bar and Safari's bars take their colour from theme-color (the phone link's index.html has it): keep it on the canvas in use.
  const tint = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (tint) {
    const paint = () => { tint.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }
    addEventListener('forge-theme', paint)
    paint()
  }

  // iOS keeps the layout viewport when the keyboard opens and scrolls the page instead: size the app to what is visible.
  const vv = window.visualViewport
  if (!vv) return
  const fit = () => {
    const on = phone.matches || touch.matches
    const root = document.documentElement
    if (!on) { root.style.removeProperty('--vvh'); root.classList.remove('kb'); return }
    // Pinch zoom shrinks the visual viewport too, but only the keyboard should shrink the app; and never past the page, or it scrolls.
    const h = Math.min(innerHeight, Math.round(vv.height * vv.scale))
    root.style.setProperty('--vvh', `${h}px`)
    root.classList.toggle('kb', innerHeight - h > 120)
    if (vv.offsetTop > 0 && vv.scale < 1.01) scrollTo(0, 0) // not while zoomed in: that offset is the user panning
  }
  vv.addEventListener('resize', fit)
  vv.addEventListener('scroll', fit)
  phone.addEventListener('change', fit)
  fit()
}
