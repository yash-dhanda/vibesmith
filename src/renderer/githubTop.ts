import { repoRisk } from './repoRisk'
import { confirmLine, formatBytes, formatKb, LARGE_KB } from '../main/cloneSize'
import type { TopRepo, TopResult } from '../main/githubTop'
import type { SafetyReport } from '../main/repoSafety'
import type { SavedRepo } from '../main/savedRepos'
import { icon } from './icons'
import { toolDialog } from './rulesPanel'
import { skillNote } from './skillSuggest'
import { checkOwners, isVerified, ownerMap, ownerStatus, ownersToCheck, verifiedCount, type OwnerProgress } from './ownerFilter'
import { repoFilterPanel } from './repoFilterPanel'
import { applyRepoFilters, DIALOG_FILTERS } from './repoFilters'
import { starBadge } from './stars'
import { cleanErr, h, seg, toast } from './ui'

type Period = 'day' | 'week' | 'month' | 'all' | 'saved'
type Mode = 'new' | 'trending'
type Sort = 'stars' | 'gained' | 'updated' | 'saved'
type Action = 'skills' | 'project' | 'reference'
type Findings = { verdict: SafetyReport['verdict']; findings: SafetyReport['findings'] }
type St = { kind: 'adding'; text: string } | ({ kind: 'confirm'; text: string; ok: () => void; cancel: () => void; okLabel?: string } & Partial<Findings>) | { kind: 'error'; msg: string }
type Safety = { state: 'loading' } | { state: 'ok'; report: SafetyReport } | { state: 'error'; msg: string }
type Outcome = { kind: Action; path?: string } | null
type Summary = { state: 'loading' } | { state: 'ok'; text: string } | { state: 'error'; msg: string }

const PERIODS: [Period, string][] = [['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All time'], ['saved', 'Saved']]
const GAINED: Record<Period, string> = { day: 'today', week: 'this week', month: 'this month', all: '', saved: '' }
const NO_FILTERS = { verified: false, hideFake: false, hideForks: false, licensed: false, recent: false, minStars: 0 } // the Saved tab shows everything that was saved
const VERDICT = { ok: 'Ok', caution: 'Caution', danger: 'Danger' } as const
const projectOf = (refPath: string) => refPath.replace(/[\\/]\.forge[\\/]references[\\/]repos[\\/][^\\/]+$/, '')
const ACTIONS: Action[] = ['skills', 'project', 'reference']
const isRemote = () => (globalThis as { __forgeRemote?: boolean }).__forgeRemote === true
const slug = (url: string) => url.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/i)?.[1].toLowerCase() ?? ''
const dot = (lang: string) => { let x = 0; for (const c of lang) x = (x * 31 + c.charCodeAt(0)) % 360; return `hsl(${x} 55% 55%)` }
const openUrl = (url: string) => { if (isRemote()) window.open(url, '_blank', 'noopener'); else void window.forge.openExternal(url).catch((e) => toast(cleanErr(e), 4000)) }

// Clone progress arrives as events; one listener serves whichever dialog is open.
let onProgress: (m: { fullName: string; bytes: number }) => void = () => {}
let listening = false

// Browse the most popular GitHub repositories and add any of them: to the skills library, as a new project, or as a reference for the current project.
export async function openGithubTop(onSkillsChanged?: () => void) {
  const { dlg, head, close } = toolDialog('github-top', 'Top GitHub repos', 'globe')
  dlg.classList.add('gh-dialog')
  if (!listening && typeof window.forge.onGithubCloneProgress === 'function') { listening = true; window.forge.onGithubCloneProgress((m) => onProgress(m)) }

  let period: Period = 'day'
  let mode: Mode = 'trending' // GitHub's own trending list is the honest one; "newest hits" is mostly spam on a daily basis
  let query = ''
  let sort: Sort = 'gained' // GitHub's own trending order
  let progress: OwnerProgress | null = null
  let checkTicket = 0
  let lang = ''
  let result: TopResult | null = null
  let loadError = ''
  let loading = true
  let ticket = 0
  const states = new Map<string, St>()
  const expanded = new Set<string>() // rows whose Add actions are showing
  const whatOpen = new Set<string>()
  const summaries = new Map<string, Summary>()
  const sizes = new Map<string, number>() // sizes learned from a README summary, for trending rows that carry none
  const cloned = new Map<string, string>() // new projects made this session
  const inLibrary = new Set<string>()
  const refs = new Set<string>()
  const refPaths = new Map<string, string>() // where each reference clone lives, to find the project it belongs to
  const safety = new Map<string, Safety>()
  const saved = new Map<string, SavedRepo>() // by lower-case name
  const notes = new Map<string, { text: string; muted: boolean }>()
  let hasProject = false
  const rows = new Map<string, HTMLElement>()
  const key = (n: string, a: Action) => `${n}|${a}`

  const intro = h('p', 'tool-intro', 'Browse what is popular and add it to Forge: as skills, as a new project, or as a reference for the current project.')
  const tabs = h('div', 'gh-tabs')
  const modeSel = document.createElement('select')
  modeSel.setAttribute('aria-label', 'List')
  modeSel.className = 'gh-select'
  for (const [v, t] of [['new', 'Newest hits'], ['trending', 'Trending on GitHub']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; modeSel.append(o) }
  const refresh = h('button', 'btn', 'Refresh') as HTMLButtonElement
  refresh.type = 'button'
  const sortSel = document.createElement('select')
  sortSel.setAttribute('aria-label', 'Sort by')
  sortSel.className = 'gh-select'
  for (const [v, t] of [['stars', 'Most stars'], ['gained', 'Stars gained'], ['updated', 'Recently updated'], ['saved', 'Recently saved']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; sortSel.append(o) }
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.placeholder = 'Filter by name, topic or language'
  filter.setAttribute('aria-label', 'Filter repositories')
  filter.className = 'gh-filter'
  const langSel = document.createElement('select')
  langSel.setAttribute('aria-label', 'Language')
  langSel.className = 'gh-select'
  const help = h('p', 'tool-intro faint gh-help')
  const noteEl = h('p', 'tool-intro faint gh-note')
  const list = h('div', 'gh-list')
  list.setAttribute('role', 'list')
  const bar = h('div', 'gh-bar')
  const riskBtn = h('button', 'link-btn gh-riskbtn') as HTMLButtonElement
  riskBtn.type = 'button'
  riskBtn.title = 'New repositories with many stars in a day are often fake downloads or star-botted. Forge hides the ones that look like it.'
  riskBtn.onclick = () => panel.set({ hideFake: !panel.get().hideFake })
  const panel = repoFilterPanel({ storeKey: 'forge.ghFilters', defaults: DIALOG_FILTERS, onChange: () => { draw(); startChecks() } })
  bar.append(modeSel, sortSel, refresh, filter, langSel, riskBtn)
  const body = h('div', 'gh-body')
  body.append(intro, tabs, bar, help, panel.el, noteEl, list)
  dlg.replaceChildren(head, body)
  if (!dlg.open) dlg.showModal()
  close.focus()

  // ---- one row ----
  const busy = (n: string) => ACTIONS.some((a) => { const s = states.get(key(n, a)); return s && s.kind !== 'error' })
  function redraw(name: string) {
    const old = rows.get(name)
    const it = result?.items.find((x) => x.fullName === name)
    if (!old || !it) return
    const focus = old.contains(document.activeElement)
    const next = rowEl(it, Number(old.dataset.rank))
    old.replaceWith(next)
    rows.set(name, next)
    if (focus) (next.querySelector('.gh-add-btn:not(:disabled)') as HTMLElement | null)?.focus()
  }
  const setSt = (name: string, a: Action, st?: St) => { if (st) states.set(key(name, a), st); else states.delete(key(name, a)); redraw(name) }
  const ask = (name: string, a: Action, text: string, extra: { okLabel?: string } & Partial<Findings> = {}) =>
    new Promise<boolean>((res) => setSt(name, a, { kind: 'confirm', text, ok: () => res(true), cancel: () => res(false), ...extra }))

  // A quick scan of the repo's files through GitHub; a failure is shown and never blocks an add.
  async function ensureSafety(it: TopRepo): Promise<SafetyReport | null> {
    const name = it.fullName
    const cur = safety.get(name)
    if (cur?.state === 'ok') return cur.report
    safety.set(name, { state: 'loading' }); redraw(name)
    try { const report = await window.forge.githubSafety(name); safety.set(name, { state: 'ok', report }); redraw(name); return report } catch (e) { safety.set(name, { state: 'error', msg: cleanErr(e) }); redraw(name); return null }
  }

  async function run(it: TopRepo, a: Action): Promise<Outcome> {
    const name = it.fullName
    const risk = repoRisk({ ...it, sizeKb: it.sizeKb ?? sizes.get(name) })
    if (risk && !confirm(`${name}\n\n${risk.reason}\n\nForge only downloads the files and never runs them. Never run programs from a repository like this. Add it anyway?`)) return null
    expanded.delete(name)
    const working = a === 'skills' ? 'Adding…' : 'Preparing…'
    setSt(name, a, { kind: 'adding', text: working })
    try {
      // Repos from verified organizations skip the scan; any other gets one first, and a finding is shown before anything is added.
      if (!isVerified(name)) {
        setSt(name, a, { kind: 'adding', text: 'Checking safety…' })
        const rep = await ensureSafety(it)
        if (rep && rep.verdict !== 'ok') {
          const text = `Safety scan: ${VERDICT[rep.verdict].toLowerCase()}. This is a quick scan, not a guarantee. Read the findings before you continue.`
          if (!(await ask(name, a, text, { verdict: rep.verdict, findings: rep.findings, okLabel: rep.verdict === 'danger' ? 'Add anyway' : 'Continue' }))) { setSt(name, a); return null }
        }
        setSt(name, a, { kind: 'adding', text: working })
      }
      let out: Outcome
      if (a === 'skills') {
        const repo = await window.forge.skillsAdd(it.url)
        inLibrary.add(slug(it.url))
        notes.set(name, skillNote(repo))
        onSkillsChanged?.()
        out = { kind: a }
      } else {
        const plan = await window.forge.githubPlan(name, a, it.sizeKb ?? sizes.get(name)) // a new project opens the folder dialog here
        if (a === 'project' && !plan.parent) { setSt(name, a); return null }
        const line = confirmLine({ fullName: name, sizeKb: plan.sizeKb, freeBytes: plan.freeBytes })
        if (line && !(await ask(name, a, line))) { setSt(name, a); return null }
        setSt(name, a, { kind: 'adding', text: 'Cloning…' })
        const r = await window.forge.githubClone(name, a, it.description, plan.parent ?? undefined)
        if (a === 'project') {
          const root = await window.forge.setProject(r.path!)
          cloned.set(name, root)
          window.dispatchEvent(new CustomEvent('forge-project-picked', { detail: root }))
          hasProject = true
          out = { kind: a, path: root }
        } else { refs.add(slug(it.url)); if (r.path) refPaths.set(slug(it.url), r.path); out = { kind: a, path: r.path ?? undefined } }
      }
      setSt(name, a)
      return out
    } catch (e) { setSt(name, a, { kind: 'error', msg: cleanErr(e) }); return null }
  }

  // "Build something with this": the repo becomes a reference for the current project (or the new project itself), then the Crew screen is asked to open with a goal to finish.
  async function build(it: TopRepo) {
    const name = it.fullName
    const [owner, repo] = name.split('/')
    const here = slug(it.url)
    let path: string | undefined
    let how: 'reference' | 'project' = 'reference'
    if (!hasProject) { const out = await run(it, 'project'); if (!out?.path) return; path = out.path; how = 'project' }
    else if (refPaths.has(here)) path = projectOf(refPaths.get(here)!)
    else { const out = await run(it, 'reference'); if (!out?.path) return; path = projectOf(out.path) }
    const lic = it.license ?? 'no license stated'
    const where = how === 'project' ? 'this project folder is a clone of it' : `cloned as a reference in .forge/references/repos/${owner}__${repo}`
    const goal = `Use ${name} (${where}, read its README first) as the starting point for: \n\nReuse what fits, do not copy code blindly, keep its licence in mind (${lic}).`
    window.dispatchEvent(new CustomEvent('forge-start-crew-goal', { detail: { path, goal } }))
    dlg.close()
  }

  async function toggleSave(it: TopRepo) {
    const k = it.fullName.toLowerCase()
    try {
      if (saved.has(k)) {
        await window.forge.githubSavedRemove(it.fullName)
        saved.delete(k)
        if (period === 'saved' && result) { result = { ...result, items: result.items.filter((x) => x.fullName.toLowerCase() !== k) }; draw(); return }
      } else saved.set(k, await window.forge.githubSavedSet({ fullName: it.fullName, url: it.url, description: it.description, stars: it.stars, topics: it.topics, language: it.language }))
      redraw(it.fullName)
    } catch (e) { toast(cleanErr(e), 4000) }
  }

  function loadSummary(it: TopRepo) {
    if (summaries.has(it.fullName)) return
    summaries.set(it.fullName, { state: 'loading' })
    redraw(it.fullName)
    window.forge.githubSummary(it.fullName).then(
      (s) => { if (s.sizeKb) sizes.set(it.fullName, s.sizeKb); summaries.set(it.fullName, { state: 'ok', text: s.whatItDoes || 'This repository has no README paragraph to show.' }) },
      (e) => summaries.set(it.fullName, { state: 'error', msg: cleanErr(e) }),
    ).finally(() => redraw(it.fullName))
  }

  function rowEl(it: TopRepo, rank: number): HTMLElement {
    const name = it.fullName
    const size = it.sizeKb || sizes.get(name)
    const row = h('div', 'gh-row')
    row.setAttribute('role', 'listitem')
    row.tabIndex = rank === 1 ? 0 : -1
    row.dataset.name = name
    row.dataset.rank = String(rank)

    const main = h('div', 'gh-main')
    const title = h('div', 'gh-title')
    const link = h('a', 'gh-name', name) as HTMLAnchorElement
    link.href = it.url
    link.title = 'Open on GitHub'
    link.onclick = (e) => { e.preventDefault(); openUrl(it.url) }
    title.append(link)
    if (size && size >= LARGE_KB) title.append(h('span', 'badge tag', 'Large download'))
    const risk = repoRisk({ ...it, sizeKb: it.sizeKb ?? sizes.get(name) })
    if (risk) { const w = h('span', risk.hide ? 'badge tag gh-risk' : 'badge tag', risk.hide ? 'Looks fake' : 'Check the code'); w.title = risk.reason; title.append(w) }
    if (isVerified(name)) { const v = h('span', 'gh-verified', 'Verified organization'); v.prepend(icon('check', 'sm')); v.title = 'The owner is a GitHub organization that GitHub has verified'; title.append(v) }
    const sf = safety.get(name)
    if (sf?.state === 'ok') { const v = h('span', `gh-verdict ${sf.report.verdict}`, `Safety: ${VERDICT[sf.report.verdict]}`); v.title = 'A quick scan of the files, not a guarantee'; title.append(v) }
    const meta = h('div', 'gh-meta')
    if (size) meta.append(h('span', 'gh-size', formatKb(size)))
    if (it.language) { const l = h('span', 'gh-lang', it.language); const d = h('span', 'gh-dot'); d.style.background = dot(it.language); l.prepend(d); meta.append(l) }
    for (const t of it.topics.slice(0, 4)) meta.append(h('span', 'gh-chip', t))
    if (typeof window.forge.githubSafety === 'function' && sf?.state !== 'ok') {
      const chk = h('button', 'link-btn gh-safety-link', sf?.state === 'loading' ? 'Checking safety…' : 'Check safety') as HTMLButtonElement
      chk.type = 'button'
      chk.disabled = sf?.state === 'loading'
      chk.onclick = () => void ensureSafety(it)
      meta.append(chk)
    }
    main.append(title, meta, h('p', it.description ? 'gh-desc' : 'gh-desc faint', it.description || 'No description.'))

    const what = h('details', 'gh-what') as HTMLDetailsElement
    what.open = whatOpen.has(name)
    what.append(h('summary', '', 'What it does'))
    const s = summaries.get(name)
    if (s) what.append(h('p', s.state === 'error' ? 'errtext' : 'gh-sum', s.state === 'loading' ? 'Loading…' : s.state === 'ok' ? s.text : s.msg))
    what.ontoggle = () => { if (what.open) { whatOpen.add(name); loadSummary(it) } else whatOpen.delete(name) }
    main.append(what)

    // Per-action status: progress, the size question, errors with Retry, and what an add found.
    const status = h('div', 'gh-status')
    status.setAttribute('role', 'status')
    const line = (cls: string, text: string) => { const d = h('div', cls); d.append(document.createTextNode(text)); status.append(d); return d }
    const findingsList = (verdict: SafetyReport['verdict'], fs: SafetyReport['findings']) => {
      const box = h('div', 'gh-findings')
      const ul = h('ul')
      for (const f of fs) ul.append(h('li', `gh-f ${f.severity}`, f.text))
      box.append(h('div', `gh-fhead ${verdict}`, `Safety scan: ${VERDICT[verdict]}. A quick scan, not a guarantee.`), ul)
      return box
    }
    if (sf?.state === 'ok') status.append(findingsList(sf.report.verdict, sf.report.findings))
    if (sf?.state === 'error') line('gh-line errtext', `Safety check skipped: ${sf.msg}`)
    for (const a of ACTIONS) {
      const st = states.get(key(name, a))
      if (!st) continue
      if (st.kind === 'adding') { const d = line('gh-line gh-progress', ` ${st.text}`); d.prepend(h('span', 'st running')) }
      else if (st.kind === 'error') {
        const d = line('gh-line errtext', st.msg)
        const retry = h('button', 'link-btn', 'Retry') as HTMLButtonElement
        retry.type = 'button'
        retry.onclick = () => void run(it, a)
        d.append(retry)
      } else {
        const d = line('gh-line', st.text)
        if (st.findings && st.verdict) status.append(findingsList(st.verdict, st.findings))
        const go = h('button', st.verdict === 'danger' ? 'btn sact danger' : 'btn primary sact', st.okLabel ?? 'Clone') as HTMLButtonElement
        const no = h('button', 'btn sact', 'Cancel') as HTMLButtonElement
        go.type = no.type = 'button'
        go.onclick = st.ok
        no.onclick = st.cancel
        d.append(go, no)
      }
    }
    const n = notes.get(name)
    if (n && inLibrary.has(slug(it.url))) line(n.muted ? 'gh-line faint' : 'gh-line', n.text)
    if (refs.has(slug(it.url))) line('gh-line', 'Added as a reference for the current project.')
    const dir = cloned.get(name)
    if (dir) {
      const d = line('gh-line', `Cloned to ${dir}. It is now the current project.`)
      const solo = h('button', 'btn sact', 'Open in Solo') as HTMLButtonElement
      const crew = h('button', 'btn sact', 'Start a Crew run here') as HTMLButtonElement
      solo.type = crew.type = 'button'
      solo.onclick = () => { window.dispatchEvent(new CustomEvent('forge-project-picked', { detail: dir })); dlg.close() }
      crew.onclick = () => { window.dispatchEvent(new CustomEvent('forge-start-crew', { detail: dir })); dlg.close() }
      d.append(solo, crew)
    }
    if (period === 'saved' && saved.has(name.toLowerCase())) {
      const note = document.createElement('input')
      note.type = 'text'
      note.className = 'gh-note-input'
      note.placeholder = 'Add a note'
      note.maxLength = 500
      note.setAttribute('aria-label', `Note for ${name}`)
      note.value = saved.get(name.toLowerCase())!.note
      note.onchange = () => void window.forge.githubSavedSet({ fullName: name, url: it.url, description: it.description, stars: it.stars, topics: it.topics, language: it.language, note: note.value })
        .then((s) => saved.set(name.toLowerCase(), s), (e) => toast(cleanErr(e), 4000))
      main.append(note)
    }
    main.append(status)

    // The Add menu opens inline under the row: a popup would be clipped by the row's content-visibility.
    const act = h('div', 'gh-act')
    const isBusy = busy(name)
    const add = h('button', 'btn sact gh-add-btn') as HTMLButtonElement
    add.type = 'button'
    add.disabled = isBusy
    add.setAttribute('aria-haspopup', 'true')
    add.setAttribute('aria-expanded', String(expanded.has(name)))
    add.setAttribute('aria-label', `Add ${name}`)
    if (isBusy) add.append(h('span', 'st running'), document.createTextNode('Working…'))
    else add.append(icon('plus', 'sm'), document.createTextNode('Add'), icon('down', 'sm'))
    add.onclick = () => { if (expanded.has(name)) expanded.delete(name); else expanded.add(name); redraw(name) }
    const isSaved = saved.has(name.toLowerCase())
    const save = h('button', `btn sact gh-save${isSaved ? ' on' : ''}`) as HTMLButtonElement
    save.type = 'button'
    save.setAttribute('aria-pressed', String(isSaved))
    save.setAttribute('aria-label', `${isSaved ? 'Remove from saved' : 'Save'} ${name}`)
    save.append(icon('star', 'sm'), document.createTextNode(isSaved ? 'Saved' : 'Save'))
    save.onclick = () => void toggleSave(it)
    const actions = h('div', 'gh-actrow')
    actions.append(save, add)
    act.append(starBadge(it.stars, it.starsToday ? `+${it.starsToday.toLocaleString()} ${GAINED[result?.period ?? period]}`.trim() : undefined), actions)
    if (expanded.has(name) && !isBusy) {
      const menu = h('div', 'gh-menu')
      menu.setAttribute('role', 'group')
      menu.setAttribute('aria-label', `Add ${name}`)
      const item = (label: string, onClick: () => void, o: { disabled?: boolean; why?: string } = {}) => {
        const b = h('button', 'gh-item', label) as HTMLButtonElement
        b.type = 'button'
        b.disabled = !!o.disabled
        if (o.why) { b.append(h('span', 'gh-why', o.why)); b.title = o.why }
        b.onclick = onClick
        menu.append(b)
      }
      const here = slug(it.url)
      item(inLibrary.has(here) ? 'In the skills library' : 'Add to skills library', () => void run(it, 'skills'), { disabled: inLibrary.has(here) })
      if (!isRemote()) item('Clone as a new project', () => void run(it, 'project'))
      item(refs.has(here) ? 'Already a reference' : 'Clone as a reference for this project', () => void run(it, 'reference'),
        { disabled: !hasProject || refs.has(here), why: hasProject ? undefined : 'Open a project first' })
      if (typeof window.forge.githubSafety === 'function') item(safety.get(name)?.state === 'ok' ? 'Check safety again' : 'Check safety', () => { expanded.delete(name); safety.delete(name); void ensureSafety(it) })
      item('Build something with this', () => void build(it), { disabled: isRemote() && !hasProject, why: isRemote() && !hasProject ? 'Open a project on the computer first' : 'Clone it and start a Crew run from it' })
      item('Open on GitHub', () => { expanded.delete(name); openUrl(it.url); redraw(name) })
      act.append(menu)
    }
    row.append(h('div', 'gh-rank', String(rank)), main, act)
    return row
  }

  // ---- list, filters, loading ----
  const sizeOf = (n: string) => sizes.get(n)
  const BY: Record<Sort, (a: TopRepo, b: TopRepo) => number> = {
    stars: (a, b) => b.stars - a.stars,
    gained: (a, b) => (b.starsToday ?? 0) - (a.starsToday ?? 0) || b.stars - a.stars,
    updated: (a, b) => (Date.parse(b.pushedAt ?? '') || 0) - (Date.parse(a.pushedAt ?? '') || 0),
    saved: () => 0, // the saved list arrives newest first
  }
  function draw() {
    rows.clear()
    langSel.disabled = !result
    if (loading) { list.replaceChildren(...Array.from({ length: 6 }, () => h('div', 'skel skel-row gh-skel'))); noteEl.textContent = ''; panel.setCount(0, 0); panel.setOwnerNote(''); return }
    if (loadError) {
      const box = h('div', 'empty-state')
      const retry = h('button', 'btn', 'Retry') as HTMLButtonElement
      retry.type = 'button'
      retry.onclick = () => void load(true)
      box.append(h('div', 'empty-title', 'Could not load the list'), h('p', 'errtext', loadError), retry)
      list.replaceChildren(box)
      noteEl.textContent = ''
      panel.setCount(0, 0)
      return
    }
    noteEl.textContent = result?.note ?? ''
    const all = result?.items ?? []
    const f = period === 'saved' ? NO_FILTERS : panel.get()
    const q = query.trim().toLowerCase()
    const shown = applyRepoFilters(all, f, ownerMap, { sizeOf })
      .filter((x) => (!lang || x.language === lang) && (!q || `${x.fullName} ${x.description} ${x.topics.join(' ')} ${x.language ?? ''}`.toLowerCase().includes(q)))
      .sort(BY[sort])
    const fake = all.filter((x) => repoRisk({ ...x, sizeKb: x.sizeKb ?? sizes.get(x.fullName) })?.hide).length
    riskBtn.textContent = f.hideFake ? `Show ${fake} hidden fake-looking repos` : `Hide ${fake} fake-looking repos`
    riskBtn.hidden = !fake || period === 'saved'
    panel.el.hidden = period === 'saved'
    modeSel.hidden = period === 'saved'
    panel.setCount(shown.length, all.length)
    panel.setVerified(verifiedCount(all), all.length)
    panel.setOwnerNote(f.verified ? ownerStatus(progress) : '')
    if (!shown.length) {
      const box = h('div', 'empty-state')
      box.append(h('div', 'empty-title', all.length ? 'No repositories match' : period === 'saved' ? 'Nothing saved yet' : 'Nothing to show'), h('p', 'empty-copy', all.length ? 'Try a different filter, or reset the filters.' : period === 'saved' ? 'Press Save on a repository to keep it here.' : 'GitHub returned an empty list for this period.'))
      list.replaceChildren(box)
      return
    }
    list.replaceChildren(...shown.map((it, i) => { const el = rowEl(it, i + 1); rows.set(it.fullName, el); return el }))
  }
  // Looks up the owners of the repos the other filters let through, in the background; the list re-filters as answers arrive.
  let limitedUntil = 0
  function startChecks() {
    const mine = ++checkTicket
    if (!result || loading || period === 'saved' || !panel.get().verified) { progress = null; panel.setOwnerNote(''); return }
    const pre = applyRepoFilters(result.items, { ...panel.get(), verified: false }, ownerMap, { sizeOf })
    if (!ownersToCheck(pre).length || Date.now() < limitedUntil) { if (!ownersToCheck(pre).length) progress = null; panel.setOwnerNote(ownerStatus(progress)); return }
    void checkOwners(pre, (p) => { if (mine !== checkTicket) return; progress = p; if (p.stop === 'rate') limitedUntil = Date.now() + 60_000; draw() }, () => mine !== checkTicket)
  }
  function drawLangs() {
    const counts = new Map<string, number>()
    for (const x of result?.items ?? []) if (x.language) counts.set(x.language, (counts.get(x.language) ?? 0) + 1)
    langSel.replaceChildren(new Option('All languages', ''), ...[...counts].sort((a, b) => b[1] - a[1]).map(([l, n]) => new Option(`${l} (${n})`, l)))
    if (!counts.has(lang)) lang = ''
    langSel.value = lang
  }
  // "Stars gained" exists only where the list carries it (trending); "Recently updated" only where it has push dates (not trending).
  function drawSort() {
    const gain = result ? result.items.some((x) => x.starsToday) : mode === 'trending'
    const dates = result ? result.items.some((x) => x.pushedAt) : mode !== 'trending'
    ;(sortSel.querySelector('option[value="gained"]') as HTMLOptionElement).disabled = !gain
    ;(sortSel.querySelector('option[value="updated"]') as HTMLOptionElement).disabled = !dates
    ;(sortSel.querySelector('option[value="saved"]') as HTMLOptionElement).hidden = period !== 'saved'
    ;(sortSel.querySelector('option[value="saved"]') as HTMLOptionElement).disabled = period !== 'saved'
    if ((sort === 'gained' && !gain) || (sort === 'updated' && !dates) || (sort === 'saved' && period !== 'saved')) sort = 'stars'
    sortSel.value = sort
  }
  const resetSort = () => { sort = period === 'saved' ? 'saved' : mode === 'trending' && period !== 'all' ? 'gained' : 'stars' }
  function drawHead() {
    tabs.replaceChildren(seg(PERIODS, period, (p) => { const was = period; period = p; if (p === 'all') mode = 'new'; else if (was === 'all') mode = 'trending'; resetSort(); drawHead(); void load(false) }))
    ;(modeSel.querySelector('option[value="trending"]') as HTMLOptionElement).disabled = period === 'all'
    modeSel.value = mode
    drawSort()
    help.textContent = period === 'saved' ? 'Repositories you saved. Star counts are refreshed when you open this tab; the note is yours.' : period === 'all' ? 'All time: the most starred repositories on GitHub. Trending is not defined for all time.'
      : mode === 'new' ? 'Newest hits: repositories created in this period, ranked by stars. Warning: a lot of brand-new repositories with many stars are fake downloads or star-botted, so Forge hides the obvious ones. Trending on GitHub is GitHub’s own list and is more trustworthy.'
      : 'Trending on GitHub: the list github.com/trending shows, about 25 repositories ranked by stars gained in the period. It includes older projects that are suddenly popular.'
  }
  async function load(force: boolean) {
    const mine = ++ticket
    checkTicket++
    loading = true; loadError = ''; refresh.disabled = true; progress = null
    drawHead(); draw()
    try {
      if (period === 'saved') {
        const r = await window.forge.githubSavedList(true) // refreshes the star counts; a rate limit leaves the older numbers
        saved.clear(); for (const x of r.items) saved.set(x.fullName.toLowerCase(), x)
        result = { items: r.items.map((x): TopRepo => ({ fullName: x.fullName, url: x.url, description: x.description, stars: x.starsNow ?? x.stars, forks: 0, language: x.language, topics: x.topics, createdAt: null, pushedAt: null })),
          period: 'all', mode: 'new', fetchedAt: Date.now(), ...(r.stopped ? { note: 'GitHub is limiting requests right now, so some star counts are older.' } : {}) }
      } else result = await window.forge.githubTop(period, mode, force)
    } catch (e) { result = null; loadError = cleanErr(e) }
    if (mine !== ticket) return
    loading = false; refresh.disabled = false
    drawLangs(); drawSort(); draw(); startChecks()
  }

  modeSel.onchange = () => { mode = modeSel.value as Mode; resetSort(); drawHead(); void load(false) }
  sortSel.onchange = () => { sort = sortSel.value as Sort; draw() }
  refresh.onclick = () => void load(true)
  filter.oninput = () => { query = filter.value; draw() }
  langSel.onchange = () => { lang = langSel.value; draw() }
  onProgress = (m) => { const el = rows.get(m.fullName)?.querySelector('.gh-progress'); if (el && el.textContent?.includes('Clon')) { el.replaceChildren(h('span', 'st running'), document.createTextNode(` Cloning, ${formatBytes(m.bytes)} so far`)) } }

  // Arrow keys move between rows, Enter opens or closes "What it does"; Esc closes the dialog.
  const rowsNow = () => [...list.querySelectorAll<HTMLElement>('.gh-row')]
  const focusRow = (el?: HTMLElement) => { if (!el) return; rowsNow().forEach((r) => (r.tabIndex = -1)); el.tabIndex = 0; el.focus(); el.scrollIntoView({ block: 'nearest' }) }
  list.onkeydown = (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.gh-row')
    if (!row) return
    const all = rowsNow()
    const i = all.indexOf(row)
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target === row) { e.preventDefault(); focusRow(all[i + (e.key === 'ArrowDown' ? 1 : -1)]) }
    else if (e.key === 'Enter' && e.target === row) { e.preventDefault(); const d = row.querySelector('details') as HTMLDetailsElement; d.open = !d.open }
  }
  filter.onkeydown = (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(rowsNow()[0]) } }

  drawHead()
  void load(false)
  // Which repos are already in the library or this project's references, and whether a project is open.
  if (typeof window.forge.skillsList === 'function') void window.forge.skillsList().then((r) => { for (const x of r) inLibrary.add(slug(x.url)); draw() }).catch(() => {})
  if (typeof window.forge.githubSavedList === 'function') void window.forge.githubSavedList(false).then((r) => { for (const x of r.items) saved.set(x.fullName.toLowerCase(), x); draw() }).catch(() => {})
  if (typeof window.forge.referencesList === 'function') {
    void window.forge.referencesList().then((r) => { hasProject = true; for (const x of r.items) if (x.path && x.url) { refs.add(slug(x.url)); refPaths.set(slug(x.url), x.path) } draw() }, () => { hasProject = false })
  }
}
