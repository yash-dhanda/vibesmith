import { $ } from './ui'

const modelSel = $<HTMLSelectElement>('model')
const CLOUD = { openai: 'OpenAI', openrouter: 'OpenRouter' } as const
export let noModels = false

const customIds = (p: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem('forge.custom.' + p) ?? '[]')
  } catch {
    return []
  }
}
export function setCustomIds(p: string, ids: string[]) {
  try {
    localStorage.setItem('forge.custom.' + p, JSON.stringify(ids))
  } catch {}
}
export const getCustomIds = customIds

export const selectedModel = () => modelSel.value

export async function loadModels() {
  const [list, keys] = await Promise.all([window.forge.agentModels(), window.forge.keysStatus()])
  for (const p of ['openai', 'openrouter'] as const) if (keys[p]) for (const id of customIds(p)) list.push({ id: `${p}:${id}`, label: id, group: CLOUD[p] })
  let saved = ''
  try {
    saved = localStorage.getItem('forge.model') ?? ''
  } catch {}
  modelSel.replaceChildren()
  const groups = new Map<string, HTMLOptGroupElement>()
  for (const m of list) {
    let g = groups.get(m.group)
    if (!g) {
      g = document.createElement('optgroup')
      g.label = m.group
      groups.set(m.group, g)
      modelSel.append(g)
    }
    g.append(new Option(m.label, m.id))
  }
  noModels = !list.length
  if (noModels) modelSel.append(new Option('No model found', 'ollama:qwen3:8b'))
  if (list.some((m) => m.id === saved)) modelSel.value = saved
  window.dispatchEvent(new Event('forge-models'))
  updateHonesty()
}

export function initModels() {
  modelSel.onfocus = loadModels
  modelSel.onchange = () => {
    updateHonesty()
    try {
      localStorage.setItem('forge.model', modelSel.value)
    } catch {}
  }
  return loadModels()
}

let honestyRequest = 0
async function updateHonesty() {
  const request = ++honestyRequest
  const id = selectedModel()
  const line = $('model-honesty')
  if (noModels) { line.textContent = 'Choose a model to start building'; return }
  if (!id.startsWith('ollama:')) { line.textContent = 'Cloud model · internet required · provider bills usage'; return }
  line.textContent = 'Local model · checking where it runs…'
  try {
    const status = await window.forge.ollamaStatus()
    if (request !== honestyRequest) return
    const loaded = status.loaded.find(m => m.name === id.slice(7))
    line.textContent = !status.up ? 'Local engine unavailable · open Models' : loaded ? loaded.gpuPercent === 100 ? 'On your GPU · local and private' : loaded.gpuPercent === 0 ? 'On your CPU · expect a slower build' : `${loaded.gpuPercent}% on GPU · partly on CPU` : 'Local model · hardware use shown once loaded'
  } catch { if (request === honestyRequest) line.textContent = 'Local model · hardware status unavailable' }
}
