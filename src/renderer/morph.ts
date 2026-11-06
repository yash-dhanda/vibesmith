// Patches a live part of the page to match a freshly built copy, keeping every node that is still there.
//
// Why: the Crew page and the sidebar are drawn by building their whole tree again on every change. Swapping the
// old tree for the new one makes the page flash, restarts animations and spinners, closes popovers and folds,
// and drops scroll, hover and focus. morph() keeps the nodes and changes only what differs.
//
// Rules a renderer follows:
// - Items of a list that can grow, shrink or reorder carry data-key (unique among their siblings).
// - A node built once and kept on purpose (the message box, a panel with its own state) goes into the new tree through keep(key, node).
//   Its placeholder becomes that node, moved with moveBefore and never patched.
// - A widget whose handlers hold its own nodes carries data-sig. Same signature: the live one stays whole. New signature: it is swapped.
// - data-hold marks a node in use (a rename, an armed Delete?): left alone. data-transient marks a node the person opened (a picker): never removed.
// - Property handlers are copied from the new node, so they must reach their nodes through e.currentTarget, a live query or module state.
// - Once a <details>/<dialog> exists, its open state belongs to the person.
// - A field takes new data only when the data changed since the last draw, and never while it has the focus.
// - .enter (motion.css) belongs to the live node until main.ts drops it.

const HANDLERS = [
  'onclick', 'ondblclick', 'oncontextmenu', 'onmousedown', 'onmouseup', 'onmouseenter', 'onmouseleave', 'onpointerdown', 'onpointerup',
  'oninput', 'onchange', 'onkeydown', 'onkeyup', 'onsubmit', 'onfocus', 'onblur', 'ontoggle', 'onscroll', 'onload', 'onerror',
  'ondragstart', 'ondragover', 'ondragleave', 'ondrop', 'onpaste',
] as const

const kept = new Map<string, Element>() // islands: built once by their renderer, moved into place, never patched
const keptNodes = new WeakSet<Node>()
const shown = new WeakMap<Element, string>() // the value each field was last drawn with
export function keep(key: string, node: Element): Element {
  kept.set(key, node); keptNodes.add(node)
  const slot = document.createElement('x-keep'); slot.setAttribute('data-keep', key); return slot
}
export function forget() { kept.clear() } // another run or page: its islands go
const keyOf = (n: Node) => (n.nodeType === 1 ? (n as Element).getAttribute('data-key') : null)
const has = (n: Node | null, attr: string) => !!n && n.nodeType === 1 && (n as Element).hasAttribute(attr)
const island = (n: Node) => (has(n, 'data-keep') ? kept.get((n as Element).getAttribute('data-keep')!) ?? null : null)
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
const isField = (n: Node): n is Field => n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement || n instanceof HTMLSelectElement
const valueOf = (f: Field) => (f instanceof HTMLInputElement && (f.type === 'checkbox' || f.type === 'radio') ? String(f.checked) : f.value)
// Two nodes are the same thing when they are the same kind, the same tag and have the same key (or both none).
function same(a: Node, b: Node) {
  if (a.nodeType !== b.nodeType) return false
  if (a.nodeType !== 1) return true
  return (a as Element).tagName === (b as Element).tagName && keyOf(a) === keyOf(b)
}
// moveBefore keeps focus, the caret, running animations and transitions (measured in Chromium 154); insertBefore of a live node blurs it and restarts them
function place(parent: Element, node: Node, ref: Node | null) {
  const p = parent as Element & { moveBefore?: (n: Node, r: Node | null) => void }
  if (p.moveBefore && node.isConnected && parent.isConnected) p.moveBefore(node, ref); else parent.insertBefore(node, ref)
}
// A fresh node just went in: its placeholders become their islands, and its fields remember what they were drawn with.
function adopt(node: Node) {
  if (node.nodeType !== 1) return
  const el = node as Element
  for (const s of Array.from(el.querySelectorAll('x-keep[data-keep]'))) { const k = island(s); if (k) place(s.parentElement!, k, s); s.remove() }
  for (const f of [el, ...Array.from(el.querySelectorAll('input, textarea, select'))]) if (isField(f)) shown.set(f, valueOf(f))
}
function syncAttributes(from: Element, to: Element) {
  const mine = from.tagName === 'DETAILS' || from.tagName === 'DIALOG' ? 'open' : '' // opened or closed by the person: theirs
  for (const { name } of Array.from(from.attributes)) if (name !== mine && !to.hasAttribute(name)) from.removeAttribute(name)
  for (const { name, value } of Array.from(to.attributes)) if (name !== mine && from.getAttribute(name) !== value) from.setAttribute(name, value)
}
// New data reaches a field only when it changed since the last draw, and never while the field has the focus.
function syncField(f: Field, want: string) {
  if (shown.get(f) === want) return
  shown.set(f, want)
  if (f.ownerDocument.activeElement === f) return
  if (f instanceof HTMLInputElement && (f.type === 'checkbox' || f.type === 'radio')) f.checked = want === 'true'; else f.value = want
}
function patch(from: Node, to: Node) {
  if (from.nodeType === 3 || from.nodeType === 8) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return }
  const el = from as HTMLElement, next = to as HTMLElement
  if (el.matches?.(':popover-open') || el.hasAttribute('data-hold')) return // in use right now
  const sig = next.getAttribute('data-sig')
  if (sig !== null) { if (el.getAttribute('data-sig') !== sig) { el.replaceWith(next); adopt(next) } return } // its handlers hold its own nodes: keep it whole or swap it whole
  // the one-shot entrance belongs to the live node: a redraw neither restarts it nor cuts it short
  if (el.classList.contains('enter')) { next.classList.add('enter'); const s = el.getAttribute('style'); if (s !== null) next.setAttribute('style', s) } else next.classList.remove('enter')
  syncAttributes(el, next)
  const f = el as unknown as Record<string, unknown>, t = next as unknown as Record<string, unknown>
  for (const name of HANDLERS) if (f[name] !== t[name]) f[name] = t[name]
  const want = isField(next) ? valueOf(next) : null // read first: a select's new options move out of `next`
  patchChildren(el, next)
  if (want !== null && isField(el)) syncField(el, want)
}
function patchChildren(from: Element, to: Element) {
  const wanted = Array.from(to.childNodes)
  const keyed = new Map<string, Node>()
  for (const c of Array.from(from.childNodes)) { const k = keyOf(c); if (k !== null && !keyed.has(k)) keyed.set(k, c) }
  const wantedKeys = new Set(wanted.map(keyOf))
  for (const [k, n] of keyed) if (!wantedKeys.has(k) && !has(n, 'data-transient')) { from.removeChild(n); keyed.delete(k) } // dropped rows go first, so the rows that stay are not moved
  let cursor: Node | null = from.firstChild
  for (const want of wanted) {
    while (has(cursor, 'data-transient')) cursor = cursor!.nextSibling // a picker the person opened stays where it is
    const own = island(want)
    if (own) { if (own === cursor) cursor = own.nextSibling; else place(from, own, cursor); continue }
    const k = keyOf(want)
    let match: Node | null = null
    if (k !== null) { const hit = keyed.get(k); if (hit && hit.parentNode === from && same(hit, want)) match = hit }
    else if (cursor && keyOf(cursor) === null && !keptNodes.has(cursor) && same(cursor, want)) match = cursor
    if (match) { if (match === cursor) cursor = match.nextSibling; else place(from, match, cursor); if (k !== null) keyed.delete(k); patch(match, want) }
    else { from.insertBefore(want, cursor); adopt(want) }
  }
  while (cursor) { const next: Node | null = cursor.nextSibling; if (!has(cursor, 'data-transient')) from.removeChild(cursor); cursor = next }
}
// Make `host`'s children match `next`'s children (next is a detached container, e.g. a fresh <div> holding the new page).
export function morphChildren(host: Element, next: Element) { patchChildren(host, next) }
// Make `live` itself match `next`, or swap it when they are different kinds of element.
export function morph(live: Element, next: Element) { if (!same(live, next)) { live.replaceWith(next); adopt(next); return } patch(live, next) }
