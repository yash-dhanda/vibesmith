import type { SkillRepo } from '../main/skills'
import { timeAgo } from './format'
import type { SkillSuggestion } from '../main/githubTop'
import { openGithubTop } from './githubTop'
import { icon } from './icons'
import { checkOwners, isVerified, ownerMap, ownerStatus, ownersToCheck, verifiedCount, type OwnerProgress } from './ownerFilter'
import { repoFilterPanel } from './repoFilterPanel'
import { applyRepoFilters, SKILL_FILTERS } from './repoFilters'
import { clearSeen, excludeList, readSeen, rememberSeen, skillNote } from './skillSuggest'
import { starBadge } from './stars'
import { cleanErr, h, onOff } from './ui'

export { openGithubTop }

const EXAMPLES = ['https://github.com/anthropics/skills']
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// Skills: GitHub repos of SKILL.md files that Forge clones; agents read the ones that fit each task.
// One panel, used by Settings → Skills and reachable from the crew start card.
export function renderSkillsPanel(): HTMLElement {
  const root = h('div', 'skills')
  if (typeof window.forge.skillsList !== 'function') { root.append(h('p', 'note', 'This build does not include skills.')); return root }

  const add = h('section', 'sgroup')
  add.append(h('h4', 'gt', 'Add a skills repo'), h('div', 'gd', 'Paste a link to a public GitHub repo. Forge clones it and finds every SKILL.md inside.'))
  const form = h('form', 'skill-add') as HTMLFormElement
  const field = document.createElement('input')
  field.type = 'url'
  field.placeholder = 'Paste a GitHub link'
  field.setAttribute('aria-label', 'GitHub link')
  field.autocomplete = 'off'
  const go = h('button', 'btn primary', 'Add') as HTMLButtonElement
  go.type = 'submit'
  const err = h('div', 'errtext skill-err')
  err.setAttribute('role', 'alert')
  form.append(field, go)
  add.append(form, err)
  if (typeof window.forge.githubTop === 'function') {
    const browse = h('button', 'btn sact skill-browse', 'Browse top GitHub repos') as HTMLButtonElement
    browse.type = 'button'
    browse.prepend(icon('globe', 'sm'))
    browse.onclick = () => void openGithubTop(() => void reload())
    add.append(browse)
  }

  const list = h('section', 'sgroup skill-list')
  const recs = h('section', 'sgroup skill-recs')
  root.append(add, recs, list)

  let repos: SkillRepo[] = []
  const draw = () => {
    drawRecs()
    list.replaceChildren(h('h4', 'gt', repos.length ? `Added · ${plural(repos.filter((r) => r.enabled).length, 'repo', 'repos')} on` : 'Added'))
    if (!repos.length) {
      const empty = h('div', 'empty-state')
      const mark = h('div', 'empty-glyph')
      mark.append(icon('spark'))
      const chips = h('div', 'skill-examples')
      for (const url of EXAMPLES) {
        const chip = h('button', 'skill-chip', url.replace('https://github.com/', '')) as HTMLButtonElement
        chip.type = 'button'
        chip.title = `Add ${url}`
        chip.prepend(icon('plus', 'sm'))
        chip.onclick = () => { field.value = url; form.requestSubmit() }
        chips.append(chip)
      }
      empty.append(mark, h('div', 'empty-title', 'No skills yet'), h('p', 'empty-copy', 'Add a GitHub repo of skills and your agents read the ones that fit each task.'), chips)
      list.append(empty)
      return
    }
    for (const repo of repos) list.append(repoRow(repo))
  }

  const repoRow = (repo: SkillRepo) => {
    const box = h('div', `skill-repo${repo.enabled ? '' : ' off'}`)
    const r = h('div', 'srow')
    const left = h('div', 'srl')
    const n = repo.total ?? repo.skills.length
    left.append(h('div', 'st-t', repo.name), h('div', 'st-d', `${repo.url} · ${plural(n, 'skill', 'skills')}${n > repo.skills.length ? ` (${repo.skills.length} listed)` : ''} · updated ${timeAgo(repo.updatedAt)}`))
    if (repo.error) left.append(h('div', 'errtext', repo.error))
    const ctl = h('div', 'ctl')
    const toggle = onOff(repo.enabled, (on) => void run(() => window.forge.skillsToggle(repo.id, on).then((next) => { repos = next })))
    toggle.setAttribute('aria-label', `Use ${repo.name}`)
    const update = h('button', 'btn sact', 'Update') as HTMLButtonElement
    update.prepend(icon('download', 'sm'))
    update.onclick = () => {
      update.disabled = true
      update.replaceChildren(h('span', 'st running'), document.createTextNode('Updating…'))
      void run(() => window.forge.skillsUpdate(repo.id).then((next) => { repos = repos.map((x) => (x.id === next.id ? next : x)) }))
    }
    // Two clicks, no native popup: the first asks, the second removes.
    const remove = h('button', 'btn sact danger', 'Remove') as HTMLButtonElement
    remove.prepend(icon('trash', 'sm'))
    let armed: ReturnType<typeof setTimeout> | null = null
    remove.onclick = () => {
      if (!armed) {
        remove.replaceChildren(document.createTextNode('Remove? Click again'))
        armed = setTimeout(() => { armed = null; remove.replaceChildren(icon('trash', 'sm'), document.createTextNode('Remove')) }, 3000)
        return
      }
      clearTimeout(armed)
      void run(() => window.forge.skillsRemove(repo.id).then((next) => { repos = next }))
    }
    ctl.append(toggle, update, remove)
    r.append(left, ctl)
    box.append(r)
    if (repo.skills.length) {
      const more = h('details', 'skill-items')
      more.append(h('summary', '', `Show ${plural(repo.skills.length, 'skill', 'skills')}`))
      const ul = h('ul')
      for (const s of repo.skills) {
        const li = h('li')
        li.append(h('strong', '', s.name), h('span', '', s.description))
        li.title = s.path
        ul.append(li)
      }
      more.append(ul)
      box.append(more)
    }
    return box
  }

  const reload = () => window.forge.skillsList().then((r) => { repos = r; draw() }, () => {})

  // Every action reloads the list it returns; errors land under the field, never in a popup.
  const run = async (fn: () => Promise<unknown>) => {
    err.textContent = ''
    try { await fn() } catch (e) { err.textContent = cleanErr(e) }
    draw()
  }

  form.onsubmit = (e) => {
    e.preventDefault()
    const url = field.value.trim()
    if (!url) { err.textContent = 'Paste a GitHub link first.'; field.focus(); return }
    go.disabled = true
    field.disabled = true
    go.replaceChildren(h('span', 'st running'), document.createTextNode('Cloning…'))
    void run(async () => {
      try {
        const repo = await window.forge.skillsAdd(url)
        repos = [...repos.filter((x) => x.id !== repo.id), repo]
        field.value = ''
      } finally {
        go.disabled = false
        field.disabled = false
        go.replaceChildren(document.createTextNode('Add'))
      }
    })
  }

  // ---- Recommended: starter packs and a checked catalog. One clone runs at a time; a pack keeps going past a failure. ----
  type Catalog = Awaited<ReturnType<typeof window.forge.skillsCatalog>>
  let catalog: Catalog | null = null
  const state = new Map<string, 'queued' | 'adding' | { error: string }>()
  const found = new Map<string, ReturnType<typeof skillNote>>() // what each Add found, for the suggestion rows
  const names = new Map<string, string>() // display names of suggested repos, for the progress line
  const packNote = new Map<string, HTMLElement>()
  const urlOf = (repo: string) => `https://github.com/${repo}`
  const slug = (url: string) => url.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/i)?.[1].toLowerCase() ?? ''
  const added = (repo: string) => repos.some((r) => slug(r.url) === repo.toLowerCase())
  let chain: Promise<unknown> = Promise.resolve()
  const addRepo = (repo: string): Promise<boolean> => {
    if (added(repo)) return Promise.resolve(true)
    state.set(repo, 'queued'); drawRecs()
    const job = chain.then(async () => {
      state.set(repo, 'adding'); drawRecs()
      try { const r = await window.forge.skillsAdd(urlOf(repo)); repos = [...repos.filter((x) => x.id !== r.id), r]; state.delete(repo); found.set(repo.toLowerCase(), skillNote(r)); return true }
      catch (e) { state.set(repo, { error: cleanErr(e) }); return false }
      finally { draw() }
    })
    chain = job
    return job
  }
  const OPEN_KEY = 'forge.skillGroupsOpen'
  const openGroups = (() => { try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null'); return Array.isArray(v) ? new Set<string>(v) : null } catch { return null } })() ?? new Set<string>()
  let firstVisit = !localStorage.getItem(OPEN_KEY)
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.placeholder = 'Filter recommended skills'
  filter.setAttribute('aria-label', 'Filter recommended skills')
  filter.className = 'skill-filter'
  filter.oninput = () => drawRecs()
  const filterBox = h('label', 'skill-filter-box')
  filterBox.append(icon('search', 'sm'), filter)
  const packsBox = h('div', 'skill-packs')
  const groupsBox = h('div', 'skill-groups')
  recs.append(h('h4', 'gt', 'Recommended'), h('div', 'gd', 'Public repos checked by hand. Adding one clones it like a pasted link; big collections take longer.'), packsBox, filterBox, groupsBox)

  const addButton = (repo: string) => {
    const st = state.get(repo)
    const b = h('button', 'btn sact skill-add-btn') as HTMLButtonElement
    b.type = 'button'
    if (added(repo)) { b.append(icon('check', 'sm'), document.createTextNode('Added')); b.disabled = true; b.setAttribute('aria-label', `${repo} is added`) }
    else if (st === 'adding' || st === 'queued') { b.append(h('span', 'st running'), document.createTextNode(st === 'adding' ? 'Adding…' : 'Queued')); b.disabled = true }
    else { b.append(icon(st ? 'undo' : 'plus', 'sm'), document.createTextNode(st ? 'Retry' : 'Add')); b.setAttribute('aria-label', `${st ? 'Retry adding' : 'Add'} ${repo}`); b.onclick = () => void addRepo(repo) }
    return b
  }

  async function addPack(pack: Catalog['packs'][number], only?: string[]) {
    const note = packNote.get(pack.id)!
    const todo = (only ?? pack.repos).filter((r) => !added(r))
    const already = (only ?? pack.repos).length - todo.length
    const failed: string[] = []
    let done = 0
    for (const [i, repo] of todo.entries()) {
      const name = catalog?.entries.find((x) => x.repo === repo)?.name ?? names.get(repo) ?? repo
      note.replaceChildren(h('span', 'st running'), document.createTextNode(` Adding ${i + 1} of ${todo.length}: ${name}`))
      if (await addRepo(repo)) done++
      else failed.push(repo)
    }
    note.replaceChildren(document.createTextNode([`Added ${done}`, already ? `${already} already there` : '', failed.length ? `${failed.length} failed` : ''].filter(Boolean).join(', ') + (failed.length ? ' ' : '.')))
    if (failed.length) { const retry = h('button', 'link-btn', 'Retry') as HTMLButtonElement; retry.type = 'button'; retry.onclick = () => void addPack(pack, failed); note.append(retry) }
  }

  function drawPacks() {
    if (!catalog) return
    packsBox.replaceChildren(...catalog.packs.map((pack) => {
      const card = h('div', 'skill-pack')
      const names = pack.repos.map((r) => catalog!.entries.find((x) => x.repo === r)?.name ?? r)
      const have = pack.repos.filter(added).length
      const btn = h('button', 'btn sact', have === pack.repos.length ? 'All added' : 'Add all') as HTMLButtonElement
      btn.type = 'button'
      btn.prepend(icon(have === pack.repos.length ? 'check' : 'plus', 'sm'))
      btn.disabled = have === pack.repos.length
      btn.setAttribute('aria-label', `Add all of ${pack.name}`)
      const note = packNote.get(pack.id) ?? h('div', 'skill-pack-note')
      note.setAttribute('role', 'status')
      packNote.set(pack.id, note)
      btn.onclick = () => { btn.disabled = true; void addPack(pack).finally(() => drawPacks()) }
      const foot = h('div', 'skill-pack-foot') // the button sits on the card's bottom edge, level across the row
      foot.append(btn, h('span', 'skill-pack-count', `${have} of ${pack.repos.length} added`))
      card.append(h('div', 'st-t', pack.name), h('div', 'st-d', pack.blurb), h('div', 'skill-pack-repos', names.join(', ')), foot, note)
      return card
    }))
  }

  function drawRecs() {
    if (!catalog) return
    drawPacks()
    const q = filter.value.trim().toLowerCase()
    const cats = Object.keys(catalog.categories)
    if (firstVisit && cats[0]) { openGroups.add(cats[0]); firstVisit = false }
    const groups: HTMLElement[] = []
    for (const cat of cats) {
      const label = catalog.categories[cat]
      const items = catalog.entries.filter((x) => x.category === cat && (!q || `${x.name} ${x.blurb} ${x.repo} ${label}`.toLowerCase().includes(q)))
      if (!items.length) continue
      const d = h('details', 'skill-group') as HTMLDetailsElement
      d.open = q ? true : openGroups.has(cat)
      const sum = h('summary', '', label)
      sum.append(h('span', 'page-count', String(items.length)))
      d.append(sum)
      d.ontoggle = () => { if (q) return; if (d.open) openGroups.add(cat); else openGroups.delete(cat); try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openGroups])) } catch {} }
      for (const x of items) {
        const r = h('div', 'srow skill-rec')
        const left = h('div', 'srl')
        const title = h('div', 'st-t', x.name)
        title.append(h('span', 'skill-repo-id', x.repo))
        left.append(title, h('div', 'st-d', x.blurb))
        const meta = h('div', 'skill-meta', plural(x.skills, 'skill', 'skills'))
        if (x.skills >= 400) meta.append(h('span', 'badge tag', 'Large download'))
        left.append(meta)
        const st = state.get(x.repo)
        if (st && typeof st === 'object') left.append(h('div', 'errtext', st.error))
        const ctl = h('div', 'ctl')
        ctl.append(addButton(x.repo))
        r.append(left, ctl)
        d.append(r)
      }
      groups.push(d)
    }
    drawMore()
    groupsBox.replaceChildren(...(groups.length ? groups : [h('p', 'note', `No recommended skills match “${filter.value.trim()}”.`)]))
  }

  // ---- More suggestions: skill-like repos found on GitHub, 20 per press, never the same one twice (kept in localStorage). ----
  type Batch = { pack: Catalog['packs'][number]; items: SkillSuggestion[] }
  const ROUND_KEY = 'forge.skillRound'
  let round = Number(localStorage.getItem(ROUND_KEY)) || 0
  const batches: Batch[] = []
  const more = h('div', 'skill-more')
  const moreMsg = h('div', 'skill-more-msg')
  moreMsg.setAttribute('role', 'status')
  const moreList = h('div', 'skill-more-list')
  const findBtn = h('button', 'btn sact', 'Find more') as HTMLButtonElement
  findBtn.type = 'button'
  findBtn.prepend(icon('search', 'sm'))
  const startOver = h('button', 'link-btn', 'Start over') as HTMLButtonElement
  startOver.type = 'button'
  startOver.title = 'Forget which suggestions were already shown'
  startOver.onclick = () => { clearSeen(localStorage); round = 0; try { localStorage.removeItem(ROUND_KEY) } catch {} ; moreMsg.textContent = 'Suggestions start from the top again.' }
  const moreBar = h('div', 'skill-more-bar')
  moreBar.append(findBtn, startOver)
  let moreProgress: OwnerProgress | null = null
  let moreTicket = 0
  let limitedUntil = 0
  const panel = repoFilterPanel({ storeKey: 'forge.skillFilters', defaults: SKILL_FILTERS, onChange: () => { drawMore(); startMoreChecks() } })
  panel.el.hidden = true
  // Owners are looked up only while the verified switch is On (each lookup is one GitHub request); known ones always get their badge.
  function startMoreChecks() {
    const mine = ++moreTicket
    const all = batches.flatMap((b) => b.items)
    if (!panel.get().verified || !all.length) { moreProgress = null; panel.setOwnerNote(''); return }
    const pre = applyRepoFilters(all, { ...panel.get(), verified: false }, ownerMap)
    if (!ownersToCheck(pre).length || Date.now() < limitedUntil) { if (!ownersToCheck(pre).length) moreProgress = null; panel.setOwnerNote(ownerStatus(moreProgress)); return }
    void checkOwners(pre, (p) => { if (mine !== moreTicket) return; moreProgress = p; if (p.stop === 'rate') limitedUntil = Date.now() + 60_000; drawMore() }, () => mine !== moreTicket)
  }
  more.append(h('h4', 'gt', 'More suggestions'), h('div', 'gd', 'Repos on GitHub that look like skills, most starred first. Each press finds 20 you have not seen.'), moreBar, panel.el, moreMsg, moreList)
  recs.append(more)

  findBtn.onclick = async () => {
    findBtn.disabled = true
    moreMsg.replaceChildren(h('span', 'st running'), document.createTextNode(' Searching GitHub…'))
    try {
      const shown = batches.flatMap((b) => b.items.map((x) => x.fullName))
      const items = await window.forge.githubSkillSuggestions(round, excludeList(catalog?.entries.map((x) => x.repo) ?? [], repos.map((r) => slug(r.url)), readSeen(localStorage), shown))
      round++
      try { localStorage.setItem(ROUND_KEY, String(round)) } catch {}
      rememberSeen(localStorage, items.map((x) => x.fullName))
      moreMsg.textContent = items.length ? '' : 'Nothing new on this page of results. Press Find more again for the next one.'
      if (items.length) {
        for (const x of items) names.set(x.fullName, x.fullName.split('/')[1])
        batches.push({ pack: { id: `more-${Date.now()}`, name: 'Suggestions', blurb: '', repos: items.map((x) => x.fullName) }, items })
        drawMore()
        startMoreChecks()
      }
    } catch (e) { moreMsg.textContent = cleanErr(e) } finally { findBtn.disabled = false }
  }

  function drawMore() {
    const everything = batches.flatMap((b) => b.items)
    const f = panel.get()
    let visibleTotal = 0
    panel.el.hidden = !batches.length
    panel.setVerified(verifiedCount(everything), everything.length)
    panel.setOwnerNote(f.verified ? ownerStatus(moreProgress) : '')
    moreList.replaceChildren(...batches.map((batch, i) => {
      const items = applyRepoFilters(batch.items, f, ownerMap)
      visibleTotal += items.length
      const b = { pack: { ...batch.pack, repos: items.map((x) => x.fullName) }, items } // "Add all" adds what is shown
      const box = h('div', 'skill-batch')
      const have = b.pack.repos.filter(added).length
      const head = h('div', 'skill-batch-head')
      const all = h('button', 'btn sact', have === b.pack.repos.length ? 'All added' : `Add all ${b.pack.repos.length}`) as HTMLButtonElement
      all.type = 'button'
      all.prepend(icon(have === b.pack.repos.length ? 'check' : 'plus', 'sm'))
      all.disabled = have === b.pack.repos.length
      const note = packNote.get(b.pack.id) ?? h('div', 'skill-pack-note')
      note.setAttribute('role', 'status')
      packNote.set(b.pack.id, note)
      all.onclick = () => { all.disabled = true; void addPack(b.pack).finally(drawMore) }
      all.disabled = all.disabled || !b.pack.repos.length
      if (!b.pack.repos.length) all.textContent = 'None shown'
      head.append(h('span', 'skill-batch-title', `Round ${i + 1} · ${have} of ${b.pack.repos.length} added`), all)
      box.append(head, note)
      for (const x of b.items) {
        const r = h('div', 'srow skill-rec')
        const left = h('div', 'srl')
        const title = h('div', 'st-t', x.fullName.split('/')[1])
        title.append(h('span', 'skill-repo-id', x.fullName))
        if (isVerified(x.fullName)) { const v = h('span', 'gh-verified', 'Verified organization'); v.prepend(icon('check', 'sm')); title.append(v) }
        left.append(title, h('div', 'st-d', x.description || 'No description.'))
        if (x.language) left.append(h('div', 'skill-meta', x.language))
        const st = state.get(x.fullName)
        if (st && typeof st === 'object') left.append(h('div', 'errtext', st.error))
        const n = found.get(x.fullName.toLowerCase())
        if (n && added(x.fullName)) left.append(h('div', n.muted ? 'skill-found muted' : 'skill-found', n.text))
        const ctl = h('div', 'ctl gh-act-inline')
        ctl.append(starBadge(x.stars), addButton(x.fullName))
        r.append(left, ctl)
        box.append(r)
      }
      return box
    }))
    panel.setCount(visibleTotal, everything.length)
  }

  if (typeof window.forge.skillsCatalog === 'function') void window.forge.skillsCatalog().then((c) => { catalog = c; drawRecs() }).catch(() => recs.remove())
  else recs.remove()

  list.append(h('div', 'skel skel-row'))
  window.forge.skillsList().then((r) => { repos = r; draw() }, (e) => { err.textContent = cleanErr(e); repos = []; draw() })
  return root
}

// "N on" for the crew start card chip.
export async function enabledSkillCount(): Promise<number | null> {
  if (typeof window.forge.skillsList !== 'function') return null
  try { return (await window.forge.skillsList()).filter((r) => r.enabled).length } catch { return null }
}
