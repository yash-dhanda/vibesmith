// Patches a live part of the page to match a freshly built copy, keeping every node that is still there.
//
// Why: the Crew page and the sidebar are drawn by building their whole tree again on every change. Swapping the
// old tree for the new one makes the page flash, restarts animations and spinners, closes popovers and folds,
// and drops scroll, hover and focus. morph() keeps the nodes and changes only what differs.
//
// Rules a renderer follows:
// - Items of a list that can grow, shrink or reorder carry data-key (unique among their siblings).
// - A node kept between renders on purpose (the message box, a cached panel) carries data-keep: it is moved into
//   place as it is and never patched, so its own state and listeners stay.
// - Handlers set as properties (el.onclick = ...) are copied from the new node, so they always see fresh data.
//   Listeners added with addEventListener on a node the renderer builds each time stay the first node's: use the
//   property form for anything that reads changing data.

const HANDLERS = [
  'onclick', 'ondblclick', 'oncontextmenu', 'onmousedown', 'onmouseup', 'onmouseenter', 'onmouseleave', 'onpointerdown', 'onpointerup',
  'oninput', 'onchange', 'onkeydown', 'onkeyup', 'onsubmit', 'onfocus', 'onblur', 'ontoggle', 'onscroll', 'onload', 'onerror',
  'ondragstart', 'ondragover', 'ondragleave', 'ondrop', 'onpaste',
] as const

const keyOf = (n: Node): string | null => (n.nodeType === 1 ? (n as Element).getAttribute('data-key') : null)
const keeps = (n: Node) => n.nodeType === 1 && (n as Element).hasAttribute('data-keep')

// Two nodes are the same thing when they are the same kind, the same tag and have the same key (or both none).
function same(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false
  if (a.nodeType !== 1) return true
  return (a as Element).tagName === (b as Element).tagName && keyOf(a) === keyOf(b)
}

function syncAttributes(from: Element, to: Element) {
  for (const { name } of Array.from(from.attributes)) if (!to.hasAttribute(name)) from.removeAttribute(name)
  for (const { name, value } of Array.from(to.attributes)) if (from.getAttribute(name) !== value) from.setAttribute(name, value)
}

function syncProperties(from: Element, to: Element) {
  const f = from as unknown as Record<string, unknown>, t = to as unknown as Record<string, unknown>
  for (const name of HANDLERS) if (f[name] !== t[name]) f[name] = t[name]
  const focused = from.ownerDocument?.activeElement === from
  if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
    if (!focused && from.value !== to.value) from.value = to.value
    if (from.checked !== to.checked) from.checked = to.checked
    if (from.disabled !== to.disabled) from.disabled = to.disabled
  } else if (from instanceof HTMLTextAreaElement && to instanceof HTMLTextAreaElement) {
    if (!focused && from.value !== to.value) from.value = to.value
    if (from.disabled !== to.disabled) from.disabled = to.disabled
  } else if (from instanceof HTMLSelectElement && to instanceof HTMLSelectElement) {
    if (from.disabled !== to.disabled) from.disabled = to.disabled
  } else if (from instanceof HTMLButtonElement && to instanceof HTMLButtonElement) {
    if (from.disabled !== to.disabled) from.disabled = to.disabled
  } else if (from instanceof HTMLDetailsElement && to instanceof HTMLDetailsElement) {
    if (from.open !== to.open) from.open = to.open
  }
}

function patch(from: Node, to: Node) {
  if (from.nodeType === 3 || from.nodeType === 8) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue
    return
  }
  const el = from as Element, next = to as Element
  // an open popover belongs to the person using it: a redraw must not close it or move its content
  if (el.matches?.(':popover-open')) return
  syncAttributes(el, next)
  syncProperties(el, next)
  // a select's value depends on its options, so it is set after them; read it first, because new options move out of `next`
  const value = next instanceof HTMLSelectElement ? next.value : null
  patchChildren(el, next)
  if (value !== null && el instanceof HTMLSelectElement && el.ownerDocument?.activeElement !== el && el.value !== value) el.value = value
}

function patchChildren(from: Element, to: Element) {
  const wanted = Array.from(to.childNodes)
  const keyed = new Map<string, Node>()
  for (const c of Array.from(from.childNodes)) { const k = keyOf(c); if (k !== null && !keyed.has(k)) keyed.set(k, c) }
  let cursor: Node | null = from.firstChild
  for (const want of wanted) {
    if (keeps(want)) {
      // the same node as last time, kept by its renderer: put it here untouched
      if (want !== cursor) from.insertBefore(want, cursor)
      else cursor = cursor.nextSibling
      continue
    }
    const k = keyOf(want)
    let match: Node | null = null
    if (k !== null) {
      const hit = keyed.get(k)
      if (hit && hit.parentNode === from && same(hit, want)) match = hit
    } else if (cursor && keyOf(cursor) === null && !keeps(cursor) && same(cursor, want)) match = cursor
    if (match) {
      if (match === cursor) cursor = cursor.nextSibling
      else from.insertBefore(match, cursor)
      if (k !== null) keyed.delete(k)
      patch(match, want)
    } else {
      from.insertBefore(want, cursor) // new: the freshly built node itself goes in
    }
  }
  // whatever is left after the last wanted node is gone from the new tree
  while (cursor) { const next: Node | null = cursor.nextSibling; from.removeChild(cursor); cursor = next }
}

// Make `host`'s children match `next`'s children (next is a detached container, e.g. a fresh <div> holding the new page).
export function morphChildren(host: Element, next: Element) {
  patchChildren(host, next)
}

// Make `live` itself match `next`, or swap it when they are different kinds of element.
export function morph(live: Element, next: Element) {
  if (!same(live, next)) { live.replaceWith(next); return }
  patch(live, next)
}
