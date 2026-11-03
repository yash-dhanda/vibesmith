import type { ForgeApi } from '../preload'
import { initChat } from './chat'
import { applyTheme, $, cleanErr, toast } from './ui'
import { hydrateIcons } from './icons'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'

declare global { interface Window { forge: ForgeApi } }

// Chat is interactive before the optional editor/terminal bundle is even fetched.
let root: string | null = null
let workspace: typeof import('./workspace') | null = null
let loading: Promise<typeof import('./workspace')> | null = null
async function loadWorkspace() {
  if (workspace) return workspace
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
applyTheme()
initChat({
  onFileChanged: path => { if (workspace) workspace.agentChangedFile(path).catch(e => toast(cleanErr(e), 4000)) },
  onFilesRestored: paths => { if (workspace) workspace.filesRestored(paths).catch(e => toast(cleanErr(e), 4000)) },
  onProject: async project => { root = project; if (workspace) await workspace.setProject(project) },
  openWorkspace,
}).catch(e => toast(`Couldn’t load Forge: ${cleanErr(e)}`, 6000))
$('ws-toggle').onclick = () => {
  if ($('app').classList.contains('ws-open')) workspace?.setWorkspace(false)
  else void openWorkspace()
}
try { if (localStorage.getItem('forge.ws') === '1') void openWorkspace() } catch {}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  try { if (localStorage.getItem('forge.theme') === 'system') applyTheme('system') } catch {}
})
