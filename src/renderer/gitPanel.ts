import type { GitResult, GitState } from '../main/team/gitpr'
import type { Run } from '../main/team/types'
import { icon } from './icons'
import { isRemote } from './phone'
import { cleanErr, h } from './ui'

// A small card for a landed run: commit it to a branch, push the branch, open a pull request. Each step is a button; nothing happens by itself.
type State = GitState & { landed: boolean; neverPush?: boolean }
const PROTECTED = /^(main|master|develop|release\/)/

const ownBranch = (s: State) => !!s.branch && s.branch !== s.defaultBranch && !PROTECTED.test(s.branch)
const reasons = (s: State): [string | null, string | null, string | null] => [
  !s.landed ? 'Land the run first.' : !s.isRepo ? 'This folder is not a git repository.' : ownBranch(s) && !s.dirty && s.ahead > 0 && s.branch?.startsWith('forge/') ? `Already committed on ${s.branch}.` : null,
  !s.isRepo ? 'This folder is not a git repository.' : !s.hasRemote ? 'This project has no remote called origin.' : !ownBranch(s) ? 'Commit to a branch first.' : s.ahead === 0 ? 'Nothing new to push.' : null,
  !s.ghReady ? 'Needs the GitHub CLI, signed in (gh auth login).' : !s.hasRemote ? 'This project has no remote called origin.' : !ownBranch(s) ? 'Commit to a branch first.' : s.ahead > 0 ? 'Push the branch first.' : null,
]

export function renderGitPanel(run: Run): HTMLElement {
  const root = h('section', 'git-card')
  root.setAttribute('aria-label', 'Commit and pull request')
  const head = h('div', 'git-head')
  head.append(icon('code', 'sm'), h('strong', '', 'Commit and share'))
  const line = h('p', 'git-line', 'Checking the project…')
  const steps = ([
    ['Commit to a branch', 'Committing…', 'teamGitCommit'],
    ['Push', 'Pushing…', 'teamGitPush'],
    ['Open pull request', 'Opening…', 'teamGitPr'],
  ] as const).map(([label, busy, call], i) => {
    const row = h('div', 'git-step')
    const btn = h('button', 'btn' + (i === 0 ? ' primary' : ''), label) as HTMLButtonElement
    btn.type = 'button'
    btn.disabled = true
    const note = h('span', 'git-note')
    note.setAttribute('role', 'status')
    row.append(btn, note)
    return { row, btn, note, label, busy, call }
  })
  root.append(head, line, ...steps.map((s) => s.row))

  let state: State | null = null
  let working = false
  const paint = () => {
    if (!state) return
    const s = state
    line.textContent = !s.isRepo ? 'This folder is not a git repository.' : [s.branch ? `On ${s.branch}` : 'No branch', s.hasRemote ? `origin ${s.remoteUrl ?? ''}`.trim() : 'no remote', s.neverPush ? 'push off' : s.ghReady ? 'GitHub CLI ready' : 'GitHub CLI not ready'].join(' · ')
    const why = reasons(s)
    steps.forEach((st, i) => {
      st.row.hidden = !!s.neverPush && i > 0 // Push and Open pull request are hidden when the project never pushes
      st.btn.disabled = working || !!why[i]
      st.btn.title = why[i] ?? st.label
      if (!st.note.dataset.result) st.note.textContent = why[i] ?? ''
    })
  }
  const refresh = async () => {
    try { state = await window.forge.teamGitState(run.id) } catch (e) { line.textContent = cleanErr(e); return }
    paint()
  }
  const show = (note: HTMLElement, r: GitResult) => {
    note.dataset.result = '1'
    note.className = 'git-note ' + (r.ok ? 'ok' : 'err')
    note.replaceChildren(r.message)
    if (r.url && /^https?:\/\//.test(r.url)) {
      const a = h('a', '', r.url) as HTMLAnchorElement
      a.href = r.url
      a.onclick = (e) => { e.preventDefault(); if (isRemote()) window.open(r.url, '_blank', 'noopener'); else void window.forge.openExternal(r.url!) }
      note.append(' ', a)
    }
  }
  steps.forEach((st) => {
    st.btn.onclick = async () => {
      working = true
      st.btn.disabled = true
      st.btn.textContent = st.busy
      steps.forEach((o) => { o.btn.disabled = true; delete o.note.dataset.result; o.note.className = 'git-note'; o.note.textContent = '' })
      try { show(st.note, await window.forge[st.call](run.id)) } catch (e) { show(st.note, { ok: false, message: cleanErr(e) }) }
      working = false
      st.btn.textContent = st.label
      await refresh()
    }
  })
  void refresh()
  return root
}
