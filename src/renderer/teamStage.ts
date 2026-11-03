// The live coding view: ONE editor window for the whole team. Every file an agent is writing gets a tab; the editor follows
// whoever typed last. Cards and text are updated in place, so what was just typed can fade in without a rebuild restarting
// every animation.
export type StageAgent = 'claude' | 'codex' | 'local'
export type StageCode = { id: string; agent: StageAgent; path: string; text: string; kind: 'content' | 'diff'; done: boolean }
export type StageAgentInfo = { agent: StageAgent; name: string; running: boolean }

type FileView = { id: string; agent: StageAgent; path: string; kind: 'content' | 'diff'; text: string; done: boolean; root: HTMLElement; scroll: HTMLElement; gutter: HTMLElement; code: HTMLElement; tab: HTMLButtonElement; tabState: HTMLElement; lines: number; touched: number }
type Chip = { el: HTMLElement; rate: HTMLElement; typed: number; timer: ReturnType<typeof setTimeout> | null }
type Stage = { root: HTMLElement; tabs: HTMLElement; view: HTMLElement; where: HTMLElement; follow: HTMLButtonElement; files: Map<string, FileView>; chips: Map<StageAgent, Chip>; active: string | null; following: boolean; idleTimer: ReturnType<typeof setTimeout> | null; rateTimer: ReturnType<typeof setInterval> | null }

const stages = new WeakMap<HTMLElement, Stage>()
const MAX_FRESH = 50 // fading fragments alive in one file before they are folded back into plain text
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e }
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p
const countLines = (t: string) => (t ? t.split('\n').length : 1)

function colorizeLater(f: FileView) {
  const text = f.text
  void import('./teamDiff').then(({ colorizeTeamCode }) => colorizeTeamCode(text.slice(-30000), f.path)).then((html) => {
    if (f.text !== text || !f.code.isConnected) return
    f.code.innerHTML = html
    f.code.classList.add('settled')
  }).catch(() => {})
}

function paintDiff(f: FileView) {
  f.code.replaceChildren()
  for (const line of f.text.slice(-30000).split('\n')) f.code.append(el('span', line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : '', line + '\n'))
}

function makeFile(stage: Stage, ev: StageCode): FileView {
  const root = el('div', `stage-file ${ev.agent}`); root.hidden = true
  const scroll = el('div', 'stage-scroll'); const gutter = el('pre', 'stage-gutter'); const pre = el('pre', 'stage-code'); const code = el('code'); pre.append(code)
  scroll.append(gutter, pre); root.append(scroll)
  const tab = el('button', `stage-tab ${ev.agent} writing`); tab.type = 'button'; tab.setAttribute('role', 'tab')
  const tabState = el('span', 'stage-tab-state')
  tab.append(el('i', 'stage-tab-dot'), el('span', 'stage-tab-name', base(ev.path)), tabState); tab.title = ev.path
  const file: FileView = { id: ev.id, agent: ev.agent, path: ev.path, kind: ev.kind, text: '', done: false, root, scroll, gutter, code, tab, tabState, lines: 0, touched: 0 }
  tab.onclick = () => { stage.following = false; showFollow(stage); activate(stage, file.id) }
  stage.tabs.append(tab); stage.view.append(root)
  return file
}

function activate(stage: Stage, id: string, fx = true) {
  const next = stage.files.get(id); if (!next) return
  if (stage.active !== id) {
    for (const f of stage.files.values()) { const on = f.id === id; f.root.hidden = !on; f.tab.setAttribute('aria-selected', String(on)); f.tab.classList.toggle('current', on) }
    next.root.classList.remove('entering'); if (fx && !reduced()) { void next.root.offsetWidth; next.root.classList.add('entering') }
    stage.active = id
  }
  next.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  stage.where.textContent = `${next.path}  ·  ${next.lines} ${next.lines === 1 ? 'line' : 'lines'}`
}

function showFollow(stage: Stage) { stage.follow.hidden = stage.following; stage.follow.textContent = 'Follow live' }

function paint(stage: Stage, f: FileView, ev: StageCode, animate: boolean) {
  if (f.kind === 'diff') { f.text = ev.text; paintDiff(f) }
  else {
    const grew = ev.text.length > f.text.length && ev.text.startsWith(f.text)
    if (grew && animate && !reduced()) {
      const added = ev.text.slice(f.text.length)
      const frag = el('span', 'fresh', added)
      frag.addEventListener('animationend', () => frag.replaceWith(document.createTextNode(frag.textContent ?? '')), { once: true })
      f.code.append(frag)
      const alive = f.code.querySelectorAll('.fresh')
      if (alive.length > MAX_FRESH) alive.forEach((x) => x.replaceWith(document.createTextNode(x.textContent ?? '')))
    } else f.code.textContent = ev.text
    const chip = stage.chips.get(ev.agent); if (chip && animate) chip.typed += Math.max(0, ev.text.length - f.text.length)
    f.text = ev.text
  }
  const n = countLines(f.text)
  if (n !== f.lines) { f.lines = n; f.gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n') }
}

function settle(f: FileView) {
  f.done = true
  f.tab.classList.remove('writing'); f.tab.classList.add('done'); f.tabState.textContent = '✓'
  f.root.classList.add('done'); f.root.querySelector('.stage-cursor')?.remove()
  if (f.kind === 'content') colorizeLater(f)
}

function typing(stage: Stage, agent: StageAgent) {
  stage.root.classList.add('active')
  if (stage.idleTimer) clearTimeout(stage.idleTimer)
  stage.idleTimer = setTimeout(() => stage.root.classList.remove('active'), 4000)
  const chip = stage.chips.get(agent); if (!chip) return
  chip.el.classList.add('typing'); if (chip.timer) clearTimeout(chip.timer)
  chip.timer = setTimeout(() => { chip.el.classList.remove('typing'); chip.rate.textContent = '' }, 1200)
  if (!stage.rateTimer) stage.rateTimer = setInterval(() => {
    if (!stage.root.isConnected) { clearInterval(stage.rateTimer!); stage.rateTimer = null; return }
    for (const c of stage.chips.values()) if (c.el.classList.contains('typing')) { c.rate.textContent = c.typed ? `${c.typed * 2}/s` : ''; c.typed = 0 }
  }, 500)
}

function apply(stage: Stage, ev: StageCode, animate: boolean) {
  stage.view.querySelector('.stage-idle')?.remove()
  let f = stage.files.get(ev.id)
  if (!f) { f = makeFile(stage, ev); stage.files.set(ev.id, f); f.tab.classList.add('arriving') }
  f.path = ev.path; f.kind = ev.kind
  paint(stage, f, ev, animate)
  f.touched = animate ? Date.now() : f.touched
  if (!ev.done && !f.done) {
    let cursor = f.root.querySelector('.stage-cursor')
    if (!cursor) { cursor = el('span', 'stage-cursor'); cursor.append(el('b', 'stage-tag', stage.chips.get(ev.agent)?.el.dataset.name ?? ev.agent)) }
    f.code.parentElement!.append(cursor)
  }
  if (ev.done && !f.done) settle(f)
  if (animate) typing(stage, ev.agent)
  if (stage.following || stage.active === null) activate(stage, ev.id, animate)
  else if (stage.active === ev.id) stage.where.textContent = `${f.path}  ·  ${f.lines} ${f.lines === 1 ? 'line' : 'lines'}`
  if (stage.active === ev.id && !f.done) f.scroll.scrollTop = f.scroll.scrollHeight
}

// The editor built from what the log already holds (opening a run, or a redraw): nothing fades in, everything is shown as it stands.
export function buildStage(files: StageCode[], opts: { agents: StageAgentInfo[]; running: boolean; status: string; details: HTMLElement; live: string }): HTMLElement {
  const root = el('section', `stage-editor${opts.running ? ' active' : ''}`)
  const title = el('header', 'stage-title')
  const dots = el('span', 'stage-dots'); dots.append(el('i'), el('i'), el('i'))
  const chips = el('div', 'stage-chips')
  title.append(dots, el('strong', 'stage-name', 'Live coding'), chips, el('span', 'lane-live', opts.live), opts.details)
  const tabs = el('nav', 'stage-tabs'); tabs.setAttribute('role', 'tablist')
  const view = el('div', 'stage-view')
  const where = el('span', 'stage-where')
  const follow = el('button', 'stage-follow', 'Follow live'); follow.type = 'button'; follow.hidden = true
  const status = el('footer', 'stage-status'); status.append(where, follow)
  root.append(title, tabs, view, status)
  const stage: Stage = { root, tabs, view, where, follow, files: new Map(), chips: new Map(), active: null, following: true, idleTimer: null, rateTimer: null }
  for (const a of opts.agents) {
    const chip = el('span', `stage-chip ${a.agent}${a.running ? ' working' : ''}`); chip.dataset.name = a.name
    const rate = el('em'); chip.append(el('i'), el('span', '', a.name), rate); chips.append(chip)
    stage.chips.set(a.agent, { el: chip, rate, typed: 0, timer: null })
  }
  follow.onclick = () => { stage.following = true; showFollow(stage); const newest = [...stage.files.values()].sort((a, b) => b.touched - a.touched)[0]; if (newest) activate(stage, newest.id) }
  stages.set(root, stage)
  const last = new Map<string, StageCode>(); for (const e of files) last.set(e.id, e)
  const list = [...last.values()]
  if (!list.length) {
    const idle = el('div', `stage-idle${opts.running ? ' working' : ''}`)
    const orbit = el('div', 'stage-orbit'); for (const a of opts.agents) orbit.append(el('i', a.agent))
    idle.append(orbit, el('span', 'stage-idle-text', opts.status)); view.append(idle)
    where.textContent = opts.agents.map((a) => a.name).join(' · ')
  }
  list.forEach((ev, i) => { apply(stage, ev, false); if (i === list.length - 1) activate(stage, ev.id) })
  for (const f of stage.files.values()) f.tab.classList.remove('arriving')
  return root
}

// One more piece of code from a running agent. Returns false when there is no editor to put it in (the caller redraws).
export function pushCode(ev: StageCode): boolean {
  const root = document.querySelector<HTMLElement>('.stage-editor')
  const stage = root && stages.get(root)
  if (!stage) return false
  apply(stage, ev, true)
  return true
}
