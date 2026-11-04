// The live coding view: ONE shared document for the whole team. Every file an agent writes is a block in it, in the order the agents
// started; each running agent has its own caret with a name tag, typing left to right at the same time as the others. Incoming text is
// queued and revealed a few characters per frame, so even a whole file that arrives at once is typed out instead of popping in.
import { N } from './names'
import { colorize } from './codeColor'

export type StageAgent = 'claude' | 'codex' | 'local'
export type StageCode = { id: string; agent: StageAgent; path: string; text: string; kind: 'content' | 'diff'; done: boolean }
export type StageAgentInfo = { agent: StageAgent; name: string; running: boolean }

// The code element holds `base` (text already typed and faded) followed by the `fresh` fragments still fading in, in order.
type Block = { id: string; agent: StageAgent; path: string; kind: 'content' | 'diff'; target: string; shown: number; done: boolean; settled: boolean; root: HTMLElement; state: HTMLElement; code: HTMLElement; base: Text; fresh: HTMLElement[]; caret: HTMLElement | null; lines: number; touched: number }
type Chip = { el: HTMLElement; rate: HTMLElement; typed: number; timer: ReturnType<typeof setTimeout> | null }
type Stage = { root: HTMLElement; scroll: HTMLElement; gutter: HTMLElement; doc: HTMLElement; view: HTMLElement; where: HTMLElement; follow: HTMLButtonElement; blocks: Map<string, Block>; order: Block[]; chips: Map<StageAgent, Chip>; following: boolean; live: boolean; raf: number; idleTimer: ReturnType<typeof setTimeout> | null; rateTimer: ReturnType<typeof setInterval> | null; lastTick: number; earlier: StageCode[]; capped: boolean; more: HTMLButtonElement | null }

const stages = new WeakMap<HTMLElement, Stage>()
// A phone (the remote link) keeps less on screen: fewer fading fragments, the last few files, no line-number gutter.
const remote = (window as { __forgeRemote?: boolean }).__forgeRemote === true
const MAX_FRESH = remote ? 12 : 90 // fading fragments alive in one block before they are folded back into plain text
const MAX_BLOCKS = 12 // files kept in the phone's document; older finished ones wait behind "Show earlier files"
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e }
const NAMES: Record<StageAgent, string> = { claude: 'Claude', codex: 'Codex', local: 'Local' }
const countLines = (t: string) => (t ? t.split('\n').length : 1)
const newlines = (t: string) => { let n = 0; for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) n++; return n }
function resetCode(b: Block) { b.base = document.createTextNode(''); b.code.replaceChildren(b.base); b.fresh = []; b.shown = 0; b.lines = 1 }
// Fragments that finished fading (and every older one) become part of the plain text.
function fold(b: Block, upto: HTMLElement) {
  const i = b.fresh.indexOf(upto); if (i < 0) return
  const done = b.fresh.splice(0, i + 1)
  b.base.appendData(done.map((x) => x.textContent ?? '').join(''))
  for (const x of done) x.remove()
  // A phone moves finished lines into their own block, so each typed step lays out the last few lines, not the whole file.
  // (A block that ends with a newline looks exactly like the same text run on.)
  const cut = remote && b.base.length > 600 ? b.base.data.lastIndexOf('\n') + 1 : 0
  if (cut > 0) { b.code.insertBefore(el('div', 'stage-chunk', b.base.data.slice(0, cut)), b.base); b.base.deleteData(0, cut) }
}

function colorizeLater(b: Block) {
  const text = b.target
  void colorize(text.slice(-30000), b.path).then((html) => {
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
  const b: Block = { id: ev.id, agent: ev.agent, path: ev.path, kind: ev.kind, target: '', shown: 0, done: false, settled: false, root, state, code, base: document.createTextNode(''), fresh: [], caret: null, lines: 1, touched: 0 }
  code.append(b.base)
  stage.doc.append(root); stage.blocks.set(ev.id, b); stage.order.push(b)
  if (remote && stage.capped) trim(stage)
  return b
}

// Phones: past MAX_BLOCKS files, the oldest finished ones leave the document (kept as text) behind a button at the top.
function trim(stage: Stage) {
  while (stage.order.length > MAX_BLOCKS) {
    const i = stage.order.findIndex((b) => b.settled)
    if (i < 0) break
    const [b] = stage.order.splice(i, 1)
    stage.blocks.delete(b.id); b.root.remove()
    stage.earlier.push({ id: b.id, agent: b.agent, path: b.path, text: b.target, kind: b.kind, done: b.done })
  }
  if (!stage.earlier.length) return
  if (!stage.more) {
    stage.more = el('button', 'stage-more'); stage.more.type = 'button'
    stage.more.onclick = () => showEarlier(stage)
    stage.doc.prepend(stage.more)
  }
  stage.more.textContent = `Show ${stage.earlier.length} earlier ${stage.earlier.length === 1 ? 'file' : 'files'}`
}
function showEarlier(stage: Stage) {
  stage.capped = false; stage.more?.remove(); stage.more = null
  const keep = stage.order; stage.order = []
  for (const ev of stage.earlier) apply(stage, ev, false)
  stage.earlier = []
  for (const b of keep) { stage.doc.append(b.root); stage.order.push(b) }
  numberLines(stage); summary(stage)
}

// Line numbers run through the whole document: one for each block's header, its code lines, and the blank gap after it.
function numberLines(stage: Stage) {
  if (remote) return // a phone has no gutter: its blocks are skipped off screen, which would leave the numbers out of step
  let n = 0; const out: string[] = []
  for (const b of stage.order) { out.push(String(++n)); for (let i = 0; i < b.lines; i++) out.push(String(++n)); out.push('') ; n++ }
  stage.gutter.textContent = out.join('\n')
}

function summary(stage: Stage) {
  const typing = stage.order.filter((b) => !b.settled && stage.live).length
  const n = stage.order.length + stage.earlier.length
  const text = `${n} ${n === 1 ? 'file' : 'files'}${typing ? `  ·  ${typing} being written` : ''}`
  if (stage.where.textContent !== text) stage.where.textContent = text
}

function reveal(stage: Stage, b: Block, n: number) {
  const add = b.target.slice(b.shown, b.shown + n)
  if (!add) return
  b.shown += add.length; b.lines += newlines(add)
  const frag = el('span', 'fresh', add)
  frag.addEventListener('animationend', () => fold(b, frag), { once: true })
  b.code.append(frag); b.fresh.push(frag)
  if (b.fresh.length > MAX_FRESH) fold(b, b.fresh[b.fresh.length - 13])
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

function scrollToLive(stage: Stage): boolean {
  if (!stage.following) return false
  let b: Block | undefined; for (const x of stage.order) if (!b || x.touched > b.touched) b = x
  if (!b) return false
  const want = b.root.offsetTop + b.root.offsetHeight - stage.scroll.clientHeight + 56
  const to = Math.max(0, Math.min(want, stage.scroll.scrollHeight - stage.scroll.clientHeight))
  const from = stage.scroll.scrollTop, d = to - from
  if (Math.abs(d) <= 1) return false
  stage.scroll.scrollTop += d * 0.25
  return stage.scroll.scrollTop !== from
}

function tick(stage: Stage) {
  stage.raf = 0
  if (!stage.root.isConnected) return
  const now = performance.now()
  // A phone types 30 times a second, not 60: text needs no more, and every step costs a layout and a paint.
  if (remote && stage.lastTick && now - stage.lastTick < 30) { stage.raf = requestAnimationFrame(() => tick(stage)); return }
  // Read the layout before writing to it, so a frame lays out once.
  const moving = scrollToLive(stage)
  const dt = stage.lastTick ? Math.min(100, now - stage.lastTick) : 16.7
  stage.lastTick = now
  let pending = false; let relined = false
  for (const b of stage.order) {
    const backlog = b.target.length - b.shown
    if (backlog > 0) {
      // A phone types by the clock (the same speed at any frame rate), in bigger steps, so the work ends sooner.
      const before = b.lines
      reveal(stage, b, remote ? Math.ceil(Math.max(6, backlog / 20) * dt / 16.7) : Math.max(3, Math.ceil(backlog / 30)))
      b.touched = Date.now()
      if (b.lines !== before) relined = true
      placeCaret(stage, b, stage.chips.get(b.agent)?.el.dataset.name ?? NAMES[b.agent])
      pending = true
    } else if (b.done && !b.settled) settle(b)
  }
  if (relined) numberLines(stage)
  if (remote && stage.capped && stage.order.length > MAX_BLOCKS) trim(stage) // files that just finished can leave now
  summary(stage)
  // Keep going while text is queued or the view is still easing to it; an idle editor costs nothing.
  if (pending || moving) stage.raf = requestAnimationFrame(() => tick(stage))
  else stage.lastTick = 0
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
  if (b.settled && b.target !== ev.text) { b.settled = false; b.root.classList.remove('done'); b.state.textContent = ''; b.code.classList.remove('settled'); resetCode(b) }
  if (!ev.text.startsWith(b.target.slice(0, b.shown))) resetCode(b) // the text was rewritten, not extended: type it again
  b.target = ev.text; b.done = ev.done; b.touched = Date.now()
  if (!animate || reduced()) { resetCode(b); b.base.data = b.target; b.shown = b.target.length; b.lines = countLines(b.target); if (ev.done) settle(b) }
  placeCaret(stage, b, name)
  if (fresh && animate && !reduced()) b.root.classList.add('arriving')
  numberLines(stage)
  summary(stage)
  if (animate) { typing(stage, ev.agent); kick(stage) }
}

// The document built from what the log already holds (opening a run, or a redraw): nothing is typed out, everything is shown as it stands.
export function buildStage(files: StageCode[], opts: { agents: StageAgentInfo[]; running: boolean; status: string; details: HTMLElement; live: string }): HTMLElement {
  const root = el('section', `stage-editor${opts.running ? ' active' : ''}`)
  const title = el('header', 'stage-title')
  const dots = el('span', 'stage-dots'); dots.append(el('i'), el('i'), el('i'))
  const chips = el('div', 'stage-chips')
  const name = el('strong', 'stage-name', N.live)
  title.append(dots, name, chips, el('span', `lane-live${opts.running ? ' on' : ''}`, opts.live), opts.details)
  const view = el('div', 'stage-view')
  const scroll = el('div', 'stage-scroll'); scroll.hidden = true
  const gutter = el('pre', 'stage-gutter'); const doc = el('div', 'stage-doc'); scroll.append(gutter, doc); view.append(scroll)
  const where = el('span', 'stage-where')
  const follow = el('button', 'stage-follow', 'Follow'); follow.type = 'button'; follow.title = 'Follow the live typing'; follow.setAttribute('aria-label', 'Follow live'); follow.hidden = true
  const status = el('footer', 'stage-status'); status.append(where, follow)
  root.append(title, view, status)
  const stage: Stage = { root, scroll, gutter, doc, view, where, follow, blocks: new Map(), order: [], chips: new Map(), following: true, live: opts.running, raf: 0, idleTimer: null, rateTimer: null, lastTick: 0, earlier: [], capped: remote, more: null }
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
