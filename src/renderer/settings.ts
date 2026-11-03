import { loadModels, getCustomIds, setCustomIds } from './models'
import { $, applyTheme, cleanErr, h, numCtxPref, setThemePref, themePref, type ThemePref } from './ui'

const NAMES = [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['openrouter', 'OpenRouter']] as const

function seg<T extends string>(options: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  const wrap = h('div', 'seg')
  for (const [v, label] of options) {
    const b = h('button', v === value ? 'on' : '', label) as HTMLButtonElement
    b.type = 'button'
    b.onclick = () => {
      wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'))
      b.classList.add('on')
      onPick(v)
    }
    wrap.append(b)
  }
  return wrap
}

export async function openSettings() {
  const dlg = $<HTMLDialogElement>('settings')
  const render = async () => {
    const keys = await window.forge.keysStatus()
    const box = h('div', 'dlg')

    box.append(h('h3', '', 'Appearance'))
    box.append(seg<ThemePref>([['dark', 'Dark'], ['light', 'Light'], ['system', 'System']], themePref(), setThemePref))

    box.append(h('h3', '', 'Local models'), h('p', 'note', 'How much the model can remember at once. Bigger needs more video memory. If a chat starts forgetting things, raise it or start a new chat.'))
    box.append(
      seg<string>([['4096', '4k'], ['8192', '8k'], ['16384', '16k'], ['32768', '32k']], String(numCtxPref()), (v) => {
        try {
          localStorage.setItem('forge.numctx', v)
        } catch {}
      }),
    )

    box.append(h('h3', '', 'API keys'), h('p', 'note', 'Stored encrypted by your OS keychain. A key is only sent to the provider you pick. Local Ollama models need no key.'))
    for (const [p, name] of NAMES) {
      const row = h('div', 'keyrow')
      const input = document.createElement('input')
      input.type = 'password'
      input.autocomplete = 'off'
      input.placeholder = keys[p] ? '•••••••• saved (paste to replace)' : 'Paste API key'
      const msg = h('div', 'errtext')
      const save = h('button', '', 'Save')
      save.onclick = async () => {
        try {
          await window.forge.keysSet(p, input.value)
          await loadModels()
          await render()
        } catch (e) {
          msg.textContent = cleanErr(e)
        }
      }
      row.append(h('label', '', name), input, save)
      if (keys[p]) {
        const rm = h('button', '', 'Remove')
        rm.onclick = async () => {
          await window.forge.keysClear(p)
          await loadModels()
          await render()
        }
        row.append(rm)
      }
      box.append(row, msg)
      if (p !== 'anthropic') {
        const mrow = h('div', 'modelrow')
        const ids = document.createElement('input')
        ids.placeholder = 'Model IDs, comma-separated'
        ids.value = getCustomIds(p).join(', ')
        ids.onchange = () => {
          setCustomIds(p, ids.value.split(',').map((s) => s.trim()).filter(Boolean))
          loadModels()
        }
        mrow.append(h('label', 'note', 'Models'), ids)
        box.append(mrow)
      }
    }

    const verify = await window.forge.verifyGet()
    if (verify) {
      box.append(h('h3', '', 'This project'), h('p', 'note', 'After the agent edits files and says it is done, Forge runs this command. If it fails, the output goes back to the agent. Full auto requires one.'))
      const vrow = h('div', 'modelrow')
      const vin = document.createElement('input')
      vin.placeholder = verify.detected ? `${verify.detected} (detected)` : 'e.g. npm test'
      vin.value = verify.configured ?? ''
      vin.onchange = () => window.forge.verifySet(vin.value)
      vrow.append(h('label', 'note', 'Verify'), vin)
      box.append(vrow)
    }

    box.append(h('h3', '', 'Keyboard shortcuts'))
    const sc = h('div', 'shortcuts')
    for (const [k, v] of [['Ctrl N', 'New chat'], ['Ctrl K', 'Search chats'], ['Ctrl L', 'Focus the message box'], ['Ctrl B', 'Show or hide chat history'], ['Ctrl J', 'Show or hide the workspace'], ['Ctrl ,', 'Settings'], ['Esc', 'Stop the agent']]) sc.append(h('span', '', k), h('span', '', v))
    box.append(sc)

    const close = h('button', 'close', 'Done')
    close.onclick = () => dlg.close()
    box.append(close)
    dlg.replaceChildren(box)
  }
  await render()
  dlg.showModal()
}

export { applyTheme }
