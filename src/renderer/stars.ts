import { icon } from './icons'
import { h } from './ui'

// 12400 -> "12.4k". Shared by the repo rows of the Top GitHub repos dialog and More suggestions.
export const compactCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k`.replace('.0k', 'k') : String(n))

// The star count as the most visible part of a row: a star, the compact number, the exact number in the tooltip, and the gain when known.
export function starBadge(stars: number, gained?: string): HTMLElement {
  const box = h('div', 'gh-starbox')
  box.title = `${stars.toLocaleString()} stars`
  const main = h('div', 'gh-starnum')
  main.append(icon('star', 'sm'), document.createTextNode(compactCount(stars)))
  box.append(main)
  if (gained) box.append(h('div', 'gh-gain', gained))
  return box
}
