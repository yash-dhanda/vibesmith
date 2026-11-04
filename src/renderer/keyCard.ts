import { icon } from './icons'
import { h } from './ui'

// The "Key answer": the few things the user asked to receive, as small text with a copy button on each line.
export function keyCard(lines: string[]): HTMLElement {
  const card = h('section', 'key-card')
  card.setAttribute('aria-label', 'Key answer')
  card.append(h('div', 'key-title', 'Key answer'))
  for (const line of lines) {
    const row = h('div', 'key-row')
    const copy = h('button', 'icon-btn xs') as HTMLButtonElement
    copy.type = 'button'
    copy.title = 'Copy'
    copy.setAttribute('aria-label', `Copy: ${line}`)
    copy.append(icon('copy', 'sm'))
    copy.onclick = () => { void navigator.clipboard?.writeText(line).then(() => { copy.title = 'Copied' }, () => {}) }
    row.append(h('span', 'key-text', line), copy)
    card.append(row)
  }
  return card
}
