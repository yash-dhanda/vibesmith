// Phones and small tablets: the sidebar becomes a drawer, and the page is fitted to the visible viewport so the on-screen keyboard
// never covers the composer. The same renderer runs on the desktop, where none of this does anything.
import { $ } from './ui'

export const phone = matchMedia('(max-width: 800px)')
const touch = matchMedia('(hover: none)')
export const isRemote = () => (window as { __forgeRemote?: boolean }).__forgeRemote === true

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
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('app').classList.contains('drawer')) toggleDrawer(false) })
  phone.addEventListener('change', () => toggleDrawer(false))

  // iOS keeps the layout viewport when the keyboard opens and scrolls the page instead: size the app to what is visible.
  const vv = window.visualViewport
  if (!vv) return
  const fit = () => {
    const on = phone.matches || touch.matches
    const root = document.documentElement
    if (!on) { root.style.removeProperty('--vvh'); root.classList.remove('kb'); return }
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
    root.classList.toggle('kb', innerHeight - vv.height > 120)
    if (vv.offsetTop > 0) scrollTo(0, 0)
  }
  vv.addEventListener('resize', fit)
  vv.addEventListener('scroll', fit)
  phone.addEventListener('change', fit)
  fit()
}
