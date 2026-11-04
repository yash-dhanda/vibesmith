import type { SkillRepo } from '../main/skills'
import { timeAgo } from './format'
import { icon } from './icons'
import { cleanErr, h, onOff } from './ui'

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

  const list = h('section', 'sgroup skill-list')
  root.append(add, list)

  let repos: SkillRepo[] = []
  const draw = () => {
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
    left.append(h('div', 'st-t', repo.name), h('div', 'st-d', `${repo.url} · ${plural(repo.skills.length, 'skill', 'skills')} · updated ${timeAgo(repo.updatedAt)}`))
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

  list.append(h('div', 'skel skel-row'))
  window.forge.skillsList().then((r) => { repos = r; draw() }, (e) => { err.textContent = cleanErr(e); repos = []; draw() })
  return root
}

// "N on" for the crew start card chip.
export async function enabledSkillCount(): Promise<number | null> {
  if (typeof window.forge.skillsList !== 'function') return null
  try { return (await window.forge.skillsList()).filter((r) => r.enabled).length } catch { return null }
}
