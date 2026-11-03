import type { UsageSummary } from '../preload'
import { formatRate, formatTokens } from './format'
import { $, h } from './ui'

let last: UsageSummary | null = null

export function setUsage(u: UsageSummary) {
  last = u
  const total = u.allTime.input + u.allTime.output
  const badge = $('usage-badge')
  badge.querySelector('.u-main')!.textContent = `⚡ ${formatTokens(total)} tokens`
  const top = u.byModel.find((m) => m.avgTps > 0)
  const today = u.today.input + u.today.output
  badge.querySelector('.u-sub')!.textContent = total ? `${formatTokens(today)} today${top ? ` · ${formatRate(top.avgTps)} tok/s` : ''}` : 'no usage yet'
}

export async function openUsage() {
  const u = (last = await window.forge.usageSummary())
  const dlg = $<HTMLDialogElement>('usage')
  const box = h('div', 'dlg')
  const total = u.allTime.input + u.allTime.output
  const big = h('div', 'big')
  big.append(document.createTextNode(formatTokens(total)), h('small', '', 'tokens used, all time'))
  box.append(h('h3', '', 'Usage'), big)
  if (total >= 1_000_000) box.append(h('p', 'note', `${total.toLocaleString()} tokens exactly (${u.allTime.input.toLocaleString()} read, ${u.allTime.output.toLocaleString()} written) across ${u.allTime.calls.toLocaleString()} model calls.`))
  else box.append(h('p', 'note', `${total.toLocaleString()} tokens (${u.allTime.input.toLocaleString()} read, ${u.allTime.output.toLocaleString()} written) across ${u.allTime.calls.toLocaleString()} model calls.`))

  const cards = h('div', 'cards')
  const card = (k: string, v: string) => {
    const c = h('div', 'card')
    c.append(h('div', 'k', k), h('div', 'v', v))
    cards.append(c)
  }
  card('Today', formatTokens(u.today.input + u.today.output))
  card('Last 7 days', formatTokens(u.last7.input + u.last7.output))
  card('Read (input)', formatTokens(u.allTime.input))
  card('Written (output)', formatTokens(u.allTime.output))
  box.append(cards)

  box.append(h('h3', '', 'Last 14 days'))
  const max = Math.max(1, ...u.byDay.map((d) => d.tokens))
  const bars = h('div', 'bars')
  for (const d of u.byDay) {
    const b = h('div', d.tokens ? '' : 'zero')
    b.style.height = d.tokens ? Math.max(3, (d.tokens / max) * 100) + '%' : '2px'
    b.title = `${d.day}: ${d.tokens.toLocaleString()} tokens`
    bars.append(b)
  }
  const axis = h('div', 'axis')
  axis.append(h('span', '', u.byDay[0]?.day.slice(5) ?? ''), h('span', '', u.byDay.at(-1)?.day.slice(5) ?? ''))
  box.append(bars, axis)

  box.append(h('h3', '', 'By model'))
  if (!u.byModel.length) box.append(h('p', 'note', 'Nothing yet. Send a message and the numbers appear here.'))
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
    box.append(t)
    box.append(h('p', 'note', 'Speed is output tokens divided by the time the model spent generating. Cloud models without timing are left out of it.'))
  }
  const close = h('button', 'close', 'Done')
  close.onclick = () => dlg.close()
  box.append(close)
  dlg.replaceChildren(box)
  dlg.showModal()
}

export function initUsage() {
  $('usage-badge').onclick = openUsage
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
