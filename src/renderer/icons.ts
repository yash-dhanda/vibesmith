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
  undo: 'M9 14 4.5 9.5 9 5M4.5 9.5h10a5 5 0 0 1 0 10H11',
  pause: 'M9 6v12M15 6v12',
  bug: 'M8.5 9.5a3.5 3.5 0 0 1 7 0v5a3.5 3.5 0 0 1-7 0zM12 9.5v8.5M4.5 13h4M15.5 13h4M5.5 8.5l3 1.5M18.5 8.5l-3 1.5M5.5 18l3-2M18.5 18l-3-2M10 6 9 4.5M14 6l1-1.5',
  file: 'M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4',
  clip: 'M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6',
  film: 'M4.5 4.5h15v15h-15zM8.5 4.5v15M15.5 4.5v15M4.5 9h4M4.5 15h4M15.5 9h4M15.5 15h4',
  menu: 'M4.5 7h15M4.5 12h15M4.5 17h15',
  phone: 'M8 3.5h8a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5zM11 17.5h2',
  edit: 'M4.5 19.5h4l10-10-4-4-10 10zM13 7l4 4',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.8c1.8.7 3 2.6 3 5.2',
  grid: 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z',
  list: 'M9 6.5h10.5M9 12h10.5M9 17.5h10.5M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01',
  sort: 'M7.5 4.5v15M4 8l3.5-3.5L11 8M16.5 19.5v-15M13 16l3.5 3.5L20 16',
  filter: 'M12 4 3.5 8.5 12 13l8.5-4.5zM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5',
  crown: 'M4.5 18.5h15M5 15.5 4 7.5l4.5 3.5L12 5l3.5 6L20 7.5l-1 8z',
  bot: 'M6 8.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 17v-7A1.5 1.5 0 0 1 6 8.5zM12 8.5V5M12 5h.01M9.5 13h.01M14.5 13h.01',
  bell: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5h-14zM10 20.5h4',
  arrowleft: 'M19 12H5M11 6l-6 6 6 6',
  gear: 'M18.66 10.62L20.73 10.9V13.1L18.66 13.38L17.68 15.73L18.95 17.39L17.39 18.95L15.73 17.68L13.38 18.66L13.1 20.73H10.9L10.62 18.66L8.27 17.68L6.61 18.95L5.05 17.39L6.32 15.73L5.34 13.38L3.27 13.1V10.9L5.34 10.62L6.32 8.27L5.05 6.61L6.61 5.05L8.27 6.32L10.62 5.34L10.9 3.27H13.1L13.38 5.34L15.73 6.32L17.39 5.05L18.95 6.61L17.68 8.27zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  updown: 'm8 9.5 4-4 4 4M8 14.5l4 4 4-4',
  user: 'M12 11.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5',
  shield: 'M12 3.5 19 6v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z',
  help: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.6 9.5a2.5 2.5 0 0 1 4.9.7c0 1.6-2.5 2.2-2.5 3.8M12 17h.01',
  contrast: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5a4.5 4.5 0 0 1 0 9z',
  coin: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM14.5 9.2c-.5-.9-1.4-1.4-2.5-1.4-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 1.9 2.5.8 2.5 2-1.1 2-2.5 2c-1.1 0-2-.5-2.5-1.4M12 6.5v1.3M12 16.2v1.3',
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

// The same drawing as markup, for HTML built as a string (code blocks in replies).
export const iconSvg = (name: IconName, cls = '') => `<svg viewBox="0 0 24 24" class="ic ${cls}" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`

// A changed file's status: new, removed or updated.
export function fileIcon(status: string) { const i = icon(status === 'added' ? 'plus' : status === 'deleted' ? 'trash' : 'edit', 'sm'); return i }

export const hasIcon = (name: string): name is IconName => name in PATHS
