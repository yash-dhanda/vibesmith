import type { ProjectOverview } from '../main/dashboard'
import { folderName, timeAgo } from './format'
import { icon } from './icons'
import { openRestorePoints } from './restorePanel'
import { cleanErr, h, toast } from './ui'

// Every project Forge knows, on one page: what is running, what needs you, what changed on disk.

export type DashboardHandlers = {
  // Default: remember the folder, then start a new Solo chat in it.
  openSolo?: (path: string) => void | Promise<void>
  // Default: announce it; the Crew screen listens for 'forge-start-crew' and starts a run in that folder.
  startCrew?: (path: string) => void
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

async function defaultOpenSolo(path: string) {
  const root = await window.forge.setProject(path)
  document.getElementById('mode-chat')?.click() // leave Crew if that is where we are
  document.getElementById('new-chat')?.click() // a new chat starts in the folder just set
  window.dispatchEvent(new CustomEvent('forge-project-picked', { detail: root }))
}

export async function openDashboard(handlers: DashboardHandlers = {}) {
  const openSolo = handlers.openSolo ?? defaultOpenSolo
  const startCrew = handlers.startCrew ?? ((path: string) => window.dispatchEvent(new CustomEvent('forge-start-crew', { detail: path })))
  const d = h('dialog', 'project-dashboard') as HTMLDialogElement
  d.setAttribute('aria-label', 'Projects')
  const x = h('button', 'icon-btn sm') as HTMLButtonElement
  x.type = 'button'
  x.title = x.ariaLabel = 'Close'
  x.append(icon('x', 'sm'))
  x.onclick = () => d.close()
  const refresh = h('button', 'btn', 'Refresh') as HTMLButtonElement
  refresh.type = 'button'
  const head = h('div', 'db-head')
  head.append(icon('grid', 'sm'), h('strong', '', 'Projects'), h('span', 'db-sub'), refresh, x)
  const grid = h('div', 'db-grid')
  d.append(head, grid)
  d.addEventListener('click', (e) => { if (e.target === d) d.close() })
  d.addEventListener('close', () => d.remove())

  const card = (p: ProjectOverview) => {
    const c = h('article', 'db-card' + (p.exists ? '' : ' missing') + (p.runs.needsYou ? ' needs' : ''))
    const chips = h('div', 'db-chips')
    const chip = (text: string, cls = '') => chips.append(h('span', 'db-chip ' + cls, text))
    if (!p.exists) chip('Folder not found', 'warn')
    else {
      if (p.runs.needsYou) chip(`${plural(p.runs.needsYou, 'run')} need${p.runs.needsYou === 1 ? 's' : ''} you`, 'warn')
      if (p.runs.active - p.runs.needsYou > 0) chip(`${plural(p.runs.active - p.runs.needsYou, 'run')} active`, 'live')
      if (!p.runs.active && p.runs.total) chip(`${plural(p.runs.total, 'run')}${p.runs.lastStatus ? ` · last ${p.runs.lastStatus.replace('_', ' ')}` : ''}`)
      if (p.chats) chip(plural(p.chats, 'chat'))
      if (p.git?.branch) chip(`branch ${p.git.branch}`)
      if (p.git?.dirty) chip(`${p.git.dirty} changed`)
      if (p.git?.ahead) chip(`${p.git.ahead} to push`)
    }
    const title = h('div', 'db-title')
    title.append(icon('folder', 'sm'), h('strong', '', p.name || folderName(p.path)))
    const path = h('div', 'db-path', p.path)
    path.title = p.path
    const when = h('div', 'db-when', p.lastActivity ? `Last activity ${timeAgo(p.lastActivity)}` : 'No activity yet')
    const act = h('div', 'db-actions')
    const button = (label: string, run: () => unknown, primary = false) => {
      const b = h('button', 'btn' + (primary ? ' primary' : ''), label) as HTMLButtonElement
      b.type = 'button'
      b.disabled = !p.exists
      b.onclick = async () => {
        try { await run() } catch (e) { toast(cleanErr(e), 4000) }
      }
      act.append(b)
    }
    button('Open in Solo', async () => { d.close(); await openSolo(p.path) }, true)
    button('Start a Crew run', () => { d.close(); startCrew(p.path) })
    button('Restore points', () => openRestorePoints(p.path))
    button('Open folder', () => window.forge.projectsOpenFolder(p.path))
    c.append(title, path, chips, when, act)
    return c
  }

  const load = async (fresh: boolean) => {
    refresh.disabled = true
    try {
      const list = await window.forge.projectsOverview(fresh)
      d.querySelector('.db-sub')!.textContent = `${plural(list.length, 'project')}${list.some((p) => p.runs.needsYou) ? ` · ${list.reduce((n, p) => n + p.runs.needsYou, 0)} need you` : ''}`
      grid.replaceChildren(...(list.length ? list.map(card) : [h('p', 'db-empty', 'No projects yet. Open a folder in Solo or start a Crew run and it shows up here.')]))
    } catch (e) {
      grid.replaceChildren(h('div', 'errcard', cleanErr(e)))
    }
    refresh.disabled = false
  }
  refresh.onclick = () => void load(true)
  document.body.append(d)
  d.showModal()
  grid.replaceChildren(h('p', 'db-empty', 'Looking at your projects…'))
  await load(false)
}
