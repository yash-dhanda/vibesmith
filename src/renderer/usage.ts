import type { UsageSummary } from '../preload'
import { formatRate, formatTokens } from './format'
import { $, h } from './ui'

let last: UsageSummary | null = null

export function setUsage(u: UsageSummary) {
  last = u
  const total = u.allTime.input + u.allTime.output
  const badge = $('usage-badge')
  const main = badge.querySelector<HTMLElement>('.u-main')!
  const text = formatTokens(total)
  if (main.dataset.v !== undefined && main.dataset.v !== text) { main.classList.remove('bump'); void main.offsetWidth; main.classList.add('bump') } // the count nudges when it changes
  main.dataset.v = text
  main.textContent = text
  const top = u.byModel.find((m) => m.avgTps > 0)
  const today = u.today.input + u.today.output
  const sub = total ? `${formatTokens(today)} today${top ? ` · ${formatRate(top.avgTps)} tok/s` : ''}` : 'no usage yet'
  badge.querySelector('.u-sub')!.textContent = sub
  badge.title = `${total.toLocaleString()} tokens used · ${sub}`
}

// The usage page inside Settings.
export async function renderUsage(into: HTMLElement) {
  const u = (last = await window.forge.usageSummary())
  const total = u.allTime.input + u.allTime.output
  const hero = h('div', 'sgroup')
  const big = h('div', 'big')
  big.append(document.createTextNode(formatTokens(total)), h('small', '', ' tokens used, all time'))
  hero.append(big, h('div', 'note', `${total.toLocaleString()} tokens (${u.allTime.input.toLocaleString()} read, ${u.allTime.output.toLocaleString()} written) across ${u.allTime.calls.toLocaleString()} model calls.`))
  into.append(hero)

  const cards = h('div', 'cards')
  const card = (k: string, v: string) => {
    const c = h('div', 'card')
    c.append(h('div', 'k', k), h('div', 'v', v))
    cards.append(c)
  }
  card('Today', formatTokens(u.today.input + u.today.output))
  card('Last 7 days', formatTokens(u.last7.input + u.last7.output))
  card('Read', formatTokens(u.allTime.input))
  card('Written', formatTokens(u.allTime.output))
  into.append(cards)

  const chart = h('div', 'sgroup')
  chart.append(h('div', 'gt', 'Last 14 days'))
  const max = Math.max(1, ...u.byDay.map((d) => d.tokens))
  const bars = h('div', 'bars')
  for (const d of u.byDay) {
    const b = h('div', d.tokens ? '' : 'zero')
    b.style.height = d.tokens ? Math.max(3, (d.tokens / max) * 100) + '%' : '2px'
    b.style.animationDelay = `${u.byDay.indexOf(d) * 18}ms`
    b.title = `${d.day}: ${d.tokens.toLocaleString()} tokens`
    bars.append(b)
  }
  const axis = h('div', 'axis')
  axis.append(h('span', '', u.byDay[0]?.day.slice(5) ?? ''), h('span', '', u.byDay.at(-1)?.day.slice(5) ?? ''))
  chart.append(bars, axis)
  into.append(chart)

  const models = h('div', 'sgroup')
  models.append(h('div', 'gt', 'By model'))
  if (!u.byModel.length) models.append(h('div', 'note', 'Nothing yet. Send a message and the numbers appear here.'))
  else {
    const t = document.createElement('table')
    t.className = 'models'
    t.innerHTML = '<thead><tr><th>Model</th><th>Read</th><th>Written</th><th>Calls</th><th>Speed</th></tr></thead>'
    const body = document.createElement('tbody')
    for (const m of u.byModel) {
      const tr = document.createElement('tr')
      for (const [i, text] of [m.model.replace(/^ollama:/, ''), formatTokens(m.input), formatTokens(m.output), String(m.calls), m.avgTps ? `${formatRate(m.avgTps)} tok/s` : '–'].entries()) {
        const td = document.createElement('td')
        td.textContent = text
        if (i === 0) td.title = m.model
        tr.append(td)
      }
      body.append(tr)
    }
    t.append(body)
    models.append(t, h('div', 'note', 'Speed is output tokens divided by the time the model spent generating. Calls without timing are left out of it.'))
  }
  into.append(models)
}

export function initUsage() {
  let timer: ReturnType<typeof setTimeout> | null = null
  const refresh = async () => setUsage(await window.forge.usageSummary())
  window.forge.onUsageChanged(() => {
    timer ??= setTimeout(() => {
      timer = null
      refresh()
    }, 800) // a busy run reports every model call; redraw the badge at most about once a second
  })
  return refresh()
}
