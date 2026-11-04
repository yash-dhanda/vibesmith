import { icon, type IconName } from './icons'
import { folderName } from './format'
import { cleanErr, h, toast } from './ui'

const STARTER = `## Always
- 

## Never
- 

## Coding style
- 

## How to run the tests
- 

## Files to leave alone
- 
`

// A modal shared by the project tools: header with icon, title and close; the caller fills the rest. `mayClose` can veto Esc and the close button.
export function toolDialog(id: string, title: string, glyph: IconName, mayClose: () => boolean = () => true) {
  let dlg = document.getElementById(id) as HTMLDialogElement | null
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = id; dlg.className = 'tool-dialog'; document.body.append(dlg) }
  const d = dlg
  d.setAttribute('aria-label', title)
  const head = h('div', 'modal-head')
  const t = h('h3', '', title)
  t.prepend(icon(glyph))
  const close = h('button', 'icon-btn') as HTMLButtonElement
  close.type = 'button'
  close.append(icon('x'))
  close.title = 'Close (Esc)'
  close.setAttribute('aria-label', 'Close')
  close.onclick = () => { if (mayClose()) d.close() }
  d.oncancel = (e) => { if (!mayClose()) e.preventDefault() }
  head.append(t, h('span', 'grow'), close)
  return { dlg: d, head, close }
}

const bytes = (s: string) => new TextEncoder().encode(s).length

// The project's rules file, for Solo and Crew alike: a big text box, a count, Save, and the text as the agents get it.
export async function openRules(project: string) {
  let dirty = false
  let armed = false // the first close with unsaved changes only warns
  const hint = h('span', 'modal-hint')
  const { dlg, head, close } = toolDialog('rules-panel', 'Project rules', 'edit', () => {
    if (!dirty || armed) return true
    armed = true
    hint.textContent = 'You have unsaved changes. Close again to discard them.'
    return false
  })
  const body = h('div', 'rules-body')
  body.append(h('div', 'skel skel-row'))
  const foot = h('div', 'modal-foot')
  dlg.replaceChildren(head, body, foot)
  if (!dlg.open) dlg.showModal()
  close.focus()

  let state
  try { state = await window.forge.rulesGet() } catch (e) { body.replaceChildren(h('p', 'errtext', cleanErr(e))); return }

  const intro = h('p', 'tool-intro', `Standing instructions for every agent working in ${folderName(project)}, in Solo and in a Crew. Write them in plain words; agents read them before each step.`)
  const note = h('p', 'tool-intro faint', state.fromBrief ? 'These came from the project brief. Saving moves them to the rules file.' : '')
  note.hidden = !state.fromBrief
  const area = document.createElement('textarea')
  area.className = 'rules-text'
  area.value = state.text
  area.spellcheck = true
  area.setAttribute('aria-label', 'Project rules')
  area.placeholder = 'For example: Never edit files in the vendor folder. Always run the tests before saying a task is done.'
  const count = h('span', 'rules-count')
  const starter = h('button', 'link-btn', 'Insert starter template') as HTMLButtonElement
  starter.type = 'button'
  starter.onclick = () => { area.value = STARTER; update(); area.focus(); area.setSelectionRange(STARTER.indexOf('- ') + 2, STARTER.indexOf('- ') + 2) }
  const bar = h('div', 'rules-bar')
  bar.append(count, h('span', 'grow'), starter)
  const preview = h('details', 'rules-preview')
  const pre = h('pre', 'rules-seen')
  preview.append(h('summary', '', 'What agents see'), pre)
  body.replaceChildren(intro, note, area, bar, preview)

  const save = h('button', 'btn primary', 'Save') as HTMLButtonElement
  save.type = 'button'
  const rest = `${state.saved ? '.forge/rules.md' : 'Saved as .forge/rules.md'} in the project, kept out of git`
  hint.textContent = rest
  hint.title = 'You can also edit .forge/rules.md in any editor'
  foot.append(hint, h('span', 'grow'), save)

  function update() {
    const b = bytes(area.value)
    const over = b > state!.maxBytes
    dirty = area.value !== (state!.saved || state!.fromBrief ? state!.text : '')
    armed = false
    count.textContent = `${area.value.length.toLocaleString()} characters${b > state!.maxBytes * 0.8 ? ` · ${Math.round(b / 1024)} KB of ${state!.maxBytes / 1024} KB` : ''}`
    count.classList.toggle('over', over)
    save.disabled = !dirty || over
    starter.hidden = !!area.value.trim()
    pre.textContent = `User's rules for this project:\n${area.value.trim() || '(none)'}`
    if (!dirty) hint.textContent = rest
  }
  const doSave = async () => {
    if (save.disabled) return
    save.disabled = true
    try {
      await window.forge.rulesSet(area.value)
      state = { ...state!, text: area.value, saved: true, fromBrief: false }
      note.hidden = true
      update()
      toast('Rules saved. Agents use them from their next step.')
    } catch (e) { toast(cleanErr(e), 5000); update() }
  }
  save.onclick = () => void doSave()
  area.oninput = update
  area.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void doSave() } }
  update()
  area.focus()
}
