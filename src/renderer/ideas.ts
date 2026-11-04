import { folderName } from './format'
import { button, copyText, goalBox, goalItem, startCrewGoal } from './goalActions'
import { icon } from './icons'
import { CATEGORIES, IDEAS, type Idea } from './ideasData'
import { filterIdeas, loadIds, saveIds, type IdeaFilter } from './ideasLogic'
import { toolDialog } from './rulesPanel'
import { h } from './ui'

// "What to build": browse project ideas, filter them, and hand one to the Crew as a ready-made goal.
const SAVED = 'forge.savedIdeas'
const LEVEL: Record<string, string> = { starter: 'Starter', intermediate: 'Intermediate', ambitious: 'Ambitious' }

export async function openIdeas(project?: string | null) {
  const { dlg, head } = toolDialog('ideas-panel', 'What to build', 'spark')
  dlg.classList.add('ideas-dialog')
  const saved = loadIds(SAVED)
  const f: IdeaFilter = { category: 'all', level: 'any', time: 'any', query: '' }
  let open = ''

  const body = h('div', 'ideas-body')
  dlg.replaceChildren(head, body)

  const intro = h('p', 'tool-intro', 'Pick something to build. Each idea comes with a complete goal that a crew can carry out in one run; you can change the goal first.')
  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = 'Search ideas, stacks and topics'
  search.className = 'ideas-search'
  search.setAttribute('aria-label', 'Search ideas')
  const select = (label: string, opts: [string, string][], on: (v: string) => void) => {
    const s = document.createElement('select')
    s.className = 'id-select'
    s.setAttribute('aria-label', label)
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; s.append(o) }
    s.onchange = () => on(s.value)
    return s
  }
  const level = select('Level', [['any', 'Any level'], ['starter', 'Starter'], ['intermediate', 'Intermediate'], ['ambitious', 'Ambitious']], (v) => { f.level = v as IdeaFilter['level']; render() })
  const time = select('Crew time', [['any', 'Any time'], ['2', 'Up to 2 hours'], ['4', 'Up to 4 hours'], ['long', 'Longer than 4 hours']], (v) => { f.time = v as IdeaFilter['time']; render() })
  const surprise = button('Surprise me', () => {
    const pool = filterIdeas(IDEAS, f, saved)
    const pick = (pool.length ? pool : IDEAS)[Math.floor(Math.random() * (pool.length ? pool.length : IDEAS.length))]
    if (!pool.includes(pick)) { Object.assign(f, { category: 'all', level: 'any', time: 'any', query: '' }); search.value = ''; level.value = time.value = 'any' }
    open = pick.id
    render()
    list.querySelector(`[data-id="${pick.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
  search.oninput = () => { f.query = search.value; render() }
  const bar = h('div', 'id-bar')
  bar.append(search, level, time, surprise)
  const chips = h('div', 'id-chips')
  chips.setAttribute('role', 'group')
  chips.setAttribute('aria-label', 'Category')
  const forProject = h('details', 'id-project') as HTMLDetailsElement
  forProject.hidden = true
  const list = h('div', 'id-list')
  body.append(intro, forProject, bar, chips, list)

  const toggleSaved = (id: string) => { saved.has(id) ? saved.delete(id) : saved.add(id); saveIds(SAVED, saved); render() }

  const card = (i: Idea) => {
    const c = h('article', 'id-card' + (open === i.id ? ' open' : ''))
    c.dataset.id = i.id
    const top = h('div', 'id-top')
    const t = h('button', 'id-toggle') as HTMLButtonElement
    t.type = 'button'
    t.setAttribute('aria-expanded', String(open === i.id))
    t.append(h('span', 'id-title', i.title), h('span', 'id-pitch', i.pitch))
    t.onclick = () => { open = open === i.id ? '' : i.id; render() }
    const star = h('button', 'icon-btn sm id-star' + (saved.has(i.id) ? ' on' : '')) as HTMLButtonElement
    star.type = 'button'
    star.append(icon('star', 'sm'))
    star.title = star.ariaLabel = saved.has(i.id) ? 'Remove from saved' : 'Save idea'
    star.setAttribute('aria-pressed', String(saved.has(i.id)))
    star.onclick = () => toggleSaved(i.id)
    top.append(t, star)
    const meta = h('div', 'id-meta')
    meta.append(h('span', `id-level ${i.level}`, LEVEL[i.level]), h('span', 'id-chip', `About ${i.hours} h of crew time`), h('span', 'id-chip', i.category))
    for (const s of i.stack.split(',').map((x) => x.trim()).slice(0, 4)) meta.append(h('span', 'id-chip stack', s))
    c.append(top, meta)
    if (open !== i.id) return c
    const box = goalBox(i.goal)
    const feats = h('ul', 'id-features')
    for (const x of i.features) feats.append(h('li', '', x))
    const act = h('div', 'gi-actions')
    const go = () => { startCrewGoal({ goal: box.text(), path: project || undefined, newFolder: true }); dlg.close() }
    act.append(button('Start a Crew run', go, 'btn primary'), button('Edit the goal first', box.edit), button('Copy goal', () => void copyText(box.text())),
      button(saved.has(i.id) ? 'Saved' : 'Save idea', () => toggleSaved(i.id), 'link-btn'))
    c.append(h('h4', 'id-sub', 'What it will do'), feats, h('h4', 'id-sub', 'Goal for the crew'), box.el, act)
    return c
  }

  function render() {
    const counts = new Map<string, number>()
    for (const i of IDEAS) counts.set(i.category, (counts.get(i.category) ?? 0) + 1)
    const opts: [IdeaFilter['category'], string][] = [['all', `All ${IDEAS.length}`], ['saved', `Saved ${saved.size}`], ...CATEGORIES.map((c): [IdeaFilter['category'], string] => [c, `${c} ${counts.get(c) ?? 0}`])]
    chips.replaceChildren(...opts.map(([v, label]) => {
      const b = button(label, () => { f.category = v; render() }, 'id-pill' + (f.category === v ? ' on' : ''))
      b.setAttribute('aria-pressed', String(f.category === v))
      return b
    }))
    const shown = filterIdeas(IDEAS, f, saved)
    if (!shown.length) {
      const e = h('div', 'empty-state')
      e.append(h('p', '', f.category === 'saved' && !saved.size ? 'Nothing saved yet. Press the star on an idea to keep it here.' : 'No ideas match. Try a wider search.'))
      list.replaceChildren(e)
    } else list.replaceChildren(...shown.map(card))
  }

  // Ideas for the open project come from its detected stack; they are additions, so they start in the project itself.
  async function projectSection() {
    if (!project) return
    try {
      const r = await window.forge.projectFeatureIdeas()
      const picks = [...r.ideas].sort((a, b) => Number(b.stacks.length > 0) - Number(a.stacks.length > 0)).slice(0, 6)
      if (!picks.length) return
      const s = h('summary', '', 'For this project')
      s.append(h('span', 'id-count', `${folderName(project)} · ${r.stack.join(', ') || 'any stack'}`))
      const rows = h('div', 'id-project-list')
      for (const p of picks) rows.append(goalItem({ title: p.title, why: p.why, goal: p.goal, startLabel: 'Build with the crew', path: project, onStart: () => dlg.close() }))
      forProject.replaceChildren(s, rows)
      forProject.open = true
      forProject.hidden = false
    } catch { /* no project folder yet, or it could not be read: the gallery still works */ }
  }

  render()
  dlg.showModal()
  search.focus()
  void projectSection()
}
