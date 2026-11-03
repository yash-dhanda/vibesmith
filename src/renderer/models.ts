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
}

export function initModels() {
  modelSel.onfocus = loadModels
  modelSel.onchange = () => {
    try {
      localStorage.setItem('forge.model', modelSel.value)
    } catch {}
  }
  return loadModels()
}
