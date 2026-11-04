// The live coding view: ONE shared document for the whole team. Every file an agent writes is a block in it, in the order the agents
// started; each running agent has its own caret with a name tag, typing left to right at the same time as the others. Incoming text is
// queued and revealed a few characters per frame, so even a whole file that arrives at once is typed out instead of popping in.
export type StageAgent = 'claude' | 'codex' | 'local'
export type StageCode = { id: string; agent: StageAgent; path: string; text: string; kind: 'content' | 'diff'; done: boolean }
export type StageAgentInfo = { agent: StageAgent; name: string; running: boolean }

type Block = { id: string; agent: StageAgent; path: string; kind: 'content' | 'diff'; target: string; shown: number; done: boolean; settled: boolean; root: HTMLElement; state: HTMLElement; code: HTMLElement; caret: HTMLElement | null; lines: number; touched: number }
type Chip = { el: HTMLElement; rate: HTMLElement; typed: number; timer: ReturnType<typeof setTimeout> | null }
type Stage = { root: HTMLElement; scroll: HTMLElement; gutter: HTMLElement; doc: HTMLElement; view: HTMLElement; where: HTMLElement; follow: HTMLButtonElement; blocks: Map<string, Block>; order: Block[]; chips: Map<StageAgent, Chip>; following: boolean; live: boolean; raf: number; idleTimer: ReturnType<typeof setTimeout> | null; rateTimer: ReturnType<typeof setInterval> | null }

const stages = new WeakMap<HTMLElement, Stage>()
const MAX_FRESH = 90 // fading fragments alive in one block before they are folded back into plain text
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e }
const NAMES: Record<StageAgent, string> = { claude: 'Claude', codex: 'Codex', local: 'Local' }
const countLines = (t: string) => (t ? t.split('\n').length : 1)

function colorizeLater(b: Block) {
  const text = b.target
  void import('./teamDiff').then(({ colorizeTeamCode }) => colorizeTeamCode(text.slice(-30000), b.path)).then((html) => {
    if (b.target !== text || !b.code.isConnected) return
    b.code.innerHTML = html
    b.code.classList.add('settled')
  }).catch(() => {})
}

function paintDiff(b: Block) {
  b.code.replaceChildren()
  for (const line of b.target.slice(-30000).split('\n')) b.code.append(el('span', line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : '', line + '\n'))
  b.code.classList.add('settled')
}

function makeBlock(stage: Stage, ev: StageCode, agentName: string): Block {
  const root = el('section', `stage-block ${ev.agent}`)
  const head = el('div', 'stage-bhead'); const state = el('span', 'stage-bstate')
  head.append(el('i', 'stage-bdot'), el('span', 'stage-bpath', ev.path), el('span', 'stage-bwho', agentName), state); head.title = ev.path
  const pre = el('pre', 'stage-code'); const code = el('code'); pre.append(code)
  root.append(head, pre, el('div', 'stage-gap'))
  const b: Block = { id: ev.id, agent: ev.agent, path: ev.path, kind: ev.kind, target: '', shown: 0, done: false, settled: false, root, state, code, caret: null, lines: 1, touched: 0 }
  stage.doc.append(root); stage.blocks.set(ev.id, b); stage.order.push(b)
  return b
}

// Line numbers run through the whole document: one for each block's header, its code lines, and the blank gap after it.
function numberLines(stage: Stage) {
  let n = 0; const out: string[] = []
  for (const b of stage.order) { out.push(String(++n)); for (let i = 0; i < b.lines; i++) out.push(String(++n)); out.push('') ; n++ }
  stage.gutter.textContent = out.join('\n')
}

function summary(stage: Stage) {
  const typing = stage.order.filter((b) => !b.settled && stage.live).length
  const n = stage.order.length
  stage.where.textContent = `${n} ${n === 1 ? 'file' : 'files'}${typing ? `  ·  ${typing} being written` : ''}`
}

function reveal(stage: Stage, b: Block, n: number) {
  const add = b.target.slice(b.shown, b.shown + n)
  if (!add) return
  b.shown += add.length
  const frag = el('span', 'fresh', add)
  frag.addEventListener('animationend', () => frag.replaceWith(document.createTextNode(frag.textContent ?? '')), { once: true })
  b.code.append(frag)
  const alive = b.code.querySelectorAll('.fresh')
  if (alive.length > MAX_FRESH) alive.forEach((x, i) => { if (i < alive.length - 12) x.replaceWith(document.createTextNode(x.textContent ?? '')) })
  const chip = stage.chips.get(b.agent); if (chip) chip.typed += add.length
}

function settle(b: Block) {
  b.settled = true; b.caret?.remove(); b.caret = null
  b.root.classList.add('done'); b.state.textContent = '✓'
  if (b.kind === 'diff') paintDiff(b); else colorizeLater(b)
}

function placeCaret(stage: Stage, b: Block, name: string) {
  if (b.settled || !stage.live) return
  if (!b.caret) { b.caret = el('span', 'stage-cursor'); b.caret.append(el('b', 'stage-tag', name)) }
  b.code.append(b.caret)
}

function scrollToLive(stage: Stage) {
  if (!stage.following) return
  const b = [...stage.order].sort((x, y) => y.touched - x.touched)[0]; if (!b) return
  const want = b.root.offsetTop + b.root.offsetHeight - stage.scroll.clientHeight + 56
  const to = Math.max(0, Math.min(want, stage.scroll.scrollHeight))
  const d = to - stage.scroll.scrollTop
  if (Math.abs(d) > 1) stage.scroll.scrollTop += d * 0.25
}

function tick(stage: Stage) {
  stage.raf = 0
  if (!stage.root.isConnected) return
  let pending = false; let relined = false
  for (const b of stage.order) {
    const backlog = b.target.length - b.shown
    if (backlog > 0) {
      reveal(stage, b, Math.max(3, Math.ceil(backlog / 30)))
      b.touched = Date.now()
      const l = countLines(b.target.slice(0, b.shown)); if (l !== b.lines) { b.lines = l; relined = true }
      placeCaret(stage, b, stage.chips.get(b.agent)?.el.dataset.name ?? NAMES[b.agent])
      pending = true
    } else if (b.done && !b.settled) settle(b)
  }
  if (relined) numberLines(stage)
  summary(stage); scrollToLive(stage)
  if (pending || stage.following) stage.raf = requestAnimationFrame(() => tick(stage))
  if (!pending && !stage.order.some((b) => b.done && !b.settled)) stage.raf = 0
}

const kick = (stage: Stage) => { if (!stage.raf) stage.raf = requestAnimationFrame(() => tick(stage)) }

function typing(stage: Stage, agent: StageAgent) {
  stage.root.classList.add('active')
  if (stage.idleTimer) clearTimeout(stage.idleTimer)
  stage.idleTimer = setTimeout(() => stage.root.classList.remove('active'), 4000)
  const chip = stage.chips.get(agent); if (!chip) return
  chip.el.classList.add('typing'); if (chip.timer) clearTimeout(chip.timer)
  chip.timer = setTimeout(() => { chip.el.classList.remove('typing'); chip.rate.textContent = '' }, 1400)
  if (!stage.rateTimer) stage.rateTimer = setInterval(() => {
    if (!stage.root.isConnected) { clearInterval(stage.rateTimer!); stage.rateTimer = null; return }
    for (const c of stage.chips.values()) if (c.el.classList.contains('typing')) { c.rate.textContent = c.typed ? `${c.typed * 2}/s` : ''; c.typed = 0 }
  }, 500)
}

function apply(stage: Stage, ev: StageCode, animate: boolean) {
  stage.view.querySelector('.stage-idle')?.remove(); stage.scroll.hidden = false
  const name = stage.chips.get(ev.agent)?.el.dataset.name ?? NAMES[ev.agent]
  let b = stage.blocks.get(ev.id)
  const fresh = !b
  if (!b) b = makeBlock(stage, ev, name)
  b.path = ev.path; b.kind = ev.kind
  if (b.settled && b.target !== ev.text) { b.settled = false; b.root.classList.remove('done'); b.state.textContent = ''; b.code.classList.remove('settled'); b.shown = 0; b.code.replaceChildren() }
  if (!ev.text.startsWith(b.target.slice(0, b.shown))) { b.shown = 0; b.code.replaceChildren() } // the text was rewritten, not extended: type it again
  b.target = ev.text; b.done = ev.done; b.touched = Date.now()
  if (!animate || reduced()) { b.shown = 0; b.code.textContent = ''; reveal(stage, b, b.target.length); b.code.querySelectorAll('.fresh').forEach((x) => x.replaceWith(document.createTextNode(x.textContent ?? ''))); b.code.normalize(); b.lines = countLines(b.target); if (ev.done) settle(b) }
  placeCaret(stage, b, name)
  if (fresh && animate && !reduced()) b.root.classList.add('arriving')
  b.lines = countLines(b.target.slice(0, b.shown)); numberLines(stage); summary(stage)
  if (animate) { typing(stage, ev.agent); kick(stage) }
}

// The document built from what the log already holds (opening a run, or a redraw): nothing is typed out, everything is shown as it stands.
export function buildStage(files: StageCode[], opts: { agents: StageAgentInfo[]; running: boolean; status: string; details: HTMLElement; live: string }): HTMLElement {
  const root = el('section', `stage-editor${opts.running ? ' active' : ''}`)
  const title = el('header', 'stage-title')
  const dots = el('span', 'stage-dots'); dots.append(el('i'), el('i'), el('i'))
  const chips = el('div', 'stage-chips')
  const name = el('strong', 'stage-name', 'Live coding')
  title.append(dots, name, chips, el('span', `lane-live${opts.running ? ' on' : ''}`, opts.live), opts.details)
  const view = el('div', 'stage-view')
  const scroll = el('div', 'stage-scroll'); scroll.hidden = true
  const gutter = el('pre', 'stage-gutter'); const doc = el('div', 'stage-doc'); scroll.append(gutter, doc); view.append(scroll)
  const where = el('span', 'stage-where')
  const follow = el('button', 'stage-follow', 'Follow'); follow.type = 'button'; follow.title = 'Follow the live typing'; follow.setAttribute('aria-label', 'Follow live'); follow.hidden = true
  const status = el('footer', 'stage-status'); status.append(where, follow)
  root.append(title, view, status)
  const stage: Stage = { root, scroll, gutter, doc, view, where, follow, blocks: new Map(), order: [], chips: new Map(), following: true, live: opts.running, raf: 0, idleTimer: null, rateTimer: null }
  for (const a of opts.agents) {
    const chip = el('span', `stage-chip ${a.agent}${a.running ? ' working' : ''}`); chip.dataset.name = a.name
    const rate = el('em'); chip.append(el('i'), el('span', '', a.name), rate); chips.append(chip)
    stage.chips.set(a.agent, { el: chip, rate, typed: 0, timer: null })
  }
  // Scrolling up by hand stops the view from chasing the typing; the button (or scrolling back to the end) resumes it.
  const stopFollow = () => { stage.following = false; follow.hidden = false }
  scroll.addEventListener('wheel', (e) => { if (e.deltaY < 0) stopFollow() }, { passive: true })
  scroll.addEventListener('touchmove', stopFollow, { passive: true })
  scroll.addEventListener('scroll', () => { if (!stage.following && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 8) { stage.following = true; follow.hidden = true; kick(stage) } })
  follow.onclick = () => { stage.following = true; follow.hidden = true; kick(stage) }
  stages.set(root, stage)
  const last = new Map<string, StageCode>(); for (const e of files) last.set(e.id, e)
  const list = [...last.values()]
  if (!list.length) {
    const idle = el('div', `stage-idle${opts.running ? ' working' : ''}`)
    const orbit = el('div', 'stage-orbit'); for (const a of opts.agents) orbit.append(el('i', a.agent))
    idle.append(orbit, el('span', 'stage-idle-text', opts.status)); view.append(idle)
    where.textContent = opts.agents.map((a) => a.name).join(' · ')
  }
  for (const ev of list) apply(stage, ev, false)
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight })
  return root
}

// One more piece of code from a running agent. Returns false when there is no editor to put it in (the caller redraws).
export function pushCode(ev: StageCode): boolean {
  const root = document.querySelector<HTMLElement>('.stage-editor')
  const stage = root && stages.get(root)
  if (!stage) return false
  stage.live = true
  apply(stage, ev, true)
  return true
}
