import type { ForgeApi } from '../preload'
import { initChat } from './chat'
import { applyTheme, $, cleanErr, toast } from './ui'
import { hydrateIcons } from './icons'
import { applyNames } from './names'
import { initTeam, setTeamProject } from './team'
import { bootDone, initPhone, isRemote } from './phone'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'

declare global { interface Window { forge: ForgeApi } }

// One-shot motion goes from its element when it ends or is cut, so a redraw, a move, a fold or a view shown again never replays it:
// .enter (motion.css) with its rise, and .just (a live editor file that finished while you watched, crew.css) with its check and its colours.
const ONCE: Record<string, string> = { rise: 'enter', 'check-pop': 'just', 'settle-in': 'just' }
for (const type of ['animationend', 'animationcancel']) document.addEventListener(type, e => { const { animationName, target } = e as AnimationEvent; if (ONCE[animationName]) (target as Element).classList?.remove(ONCE[animationName]) })

// Chat is interactive before the optional editor/terminal bundle is even fetched.
let root: string | null = null
let workspace: typeof import('./workspace') | null = null
let loading: Promise<typeof import('./workspace')> | null = null
async function loadWorkspace() {
  if (workspace) return workspace
  if (isRemote()) throw new Error('Files, the editor and the terminal open on the computer.') // never download Monaco and xterm to a phone
  loading ??= import('./workspace').then(async module => {
    await module.setProject(root)
    workspace = module
    return module
  }).catch(e => { loading = null; throw e })
  return loading
}
async function openWorkspace() {
  const button = $('ws-toggle')
  button.setAttribute('aria-busy', 'true')
  try { (await loadWorkspace()).setWorkspace(true) }
  catch (e) { toast(cleanErr(e), 4000) }
  finally { button.removeAttribute('aria-busy') }
}
hydrateIcons()
applyNames()
applyTheme()
initPhone()
initChat({
  onFileChanged: path => { if (workspace) workspace.agentChangedFile(path).catch(e => toast(cleanErr(e), 4000)) },
  onFilesRestored: paths => { if (workspace) workspace.filesRestored(paths).catch(e => toast(cleanErr(e), 4000)) },
  onProject: async project => { root = project; setTeamProject(project); if (workspace) await workspace.setProject(project) },
  openWorkspace,
}).catch(e => toast(`Couldn’t load Forge: ${cleanErr(e)}`, 6000))
initTeam({ project: () => root })
bootDone() // the shell is drawn (data still on its way, shown as skeleton rows or the last list seen)
$('ws-toggle').onclick = () => {
  if ($('app').classList.contains('ws-open')) workspace?.setWorkspace(false)
  else void openWorkspace()
}
try { if (localStorage.getItem('forge.ws') === '1' && !isRemote()) void openWorkspace() } catch {}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  try { if (localStorage.getItem('forge.theme') === 'system') applyTheme('system') } catch {}
})
