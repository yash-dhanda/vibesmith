// One icon set, one stroke weight. Glyphs like ＋ ⚙ ⚡ look different on every system, so the UI draws its own.
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M5 12.5 9.5 17 19 7',
  chevron: 'm9 6 6 6-6 6',
  down: 'm6 9 6 6 6-6',
  arrowup: 'M12 19V6M6 11.5 12 5.5l6 6',
  arrowdown: 'M12 5v13M6 12.5l6 6 6-6',
  arrowright: 'M5 12h14M13 6l6 6-6 6',
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  sidebar: 'M4.5 5.5h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM9.5 5.5v13',
  dots: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  code: 'm8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5',
  bolt: 'M13 3 5.5 13.5h5.8L10.5 21 18.5 10h-5.7z',
  cube: 'M12 3.2 19.8 7.6v8.8L12 20.8 4.2 16.4V7.6zM4.6 7.8 12 12l7.4-4.2M12 12v8.6',
  sliders: 'M4 8h9M17 8h3M4 16h3M11 16h9M15 5.5v5M9 13.5v5',
  chart: 'M5 19.5v-6M12 19.5v-14M19 19.5v-9',
  keyboard: 'M3.5 7h17a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM7 11h.01M11 11h.01M15 11h.01M7.5 14h9',
  info: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 11v5M12 8h.01',
  stop: 'M8.5 8.5h7v7h-7z',
  copy: 'M9 9h10.5v10.5H9zM5.5 15V5.5H15',
  trash: 'M4.5 7h15M9.5 11v6M14.5 11v6M6.5 7l.8 12.5h9.4L17.5 7M9 7V4.5h6V7',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.4-4.4',
  download: 'M12 4.5v11M7 11l5 5 5-5M5 20h14',
  spark: 'M12 3.5 13.8 10 20.5 12 13.8 14 12 20.5 10.2 14 3.5 12 10.2 10z',
  cpu: 'M8 8h8v8H8zM10 4.5V8M14 4.5V8M10 16v3.5M14 16v3.5M4.5 10H8M4.5 14H8M16 10h3.5M16 14h3.5',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.4 2.4 3.4 5.4 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.4-3.4-8.5s1-6.1 3.4-8.5z',
} as const

export type IconName = keyof typeof PATHS
const NS = 'http://www.w3.org/2000/svg'

export function icon(name: IconName, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', ('ic ' + cls).trim())
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', PATHS[name])
  if (name === 'dots') svg.style.strokeWidth = '2.8' // tiny round-capped strokes read as dots
  if (name === 'stop') svg.style.fill = 'currentColor'
  svg.append(path)
  return svg
}

// Static markup says <i data-icon="plus"></i>; this swaps in the drawing.
export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((el) => {
    const name = el.dataset.icon as IconName
    if (name in PATHS) el.replaceWith(icon(name, el.className))
  })
}

export const hasIcon = (name: string): name is IconName => name in PATHS
