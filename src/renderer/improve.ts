import type { Area, HealthReport, Suggestion } from '../main/projectHealth'
import { folderName } from './format'
import { button, goalItem, startCrewGoal } from './goalActions'
import { combineGoals, loadIds, REVIEW_GOAL, saveIds } from './ideasLogic'
import { toolDialog } from './rulesPanel'
import { cleanErr, h, seg } from './ui'

// "Improve this project": what Forge can see is worth fixing, and features worth adding, each as a goal for the crew.
const AREAS: [Area, string][] = [['security', 'Security'], ['tests', 'Tests'], ['quality', 'Code quality'], ['docs', 'Documentation'], ['accessibility', 'Accessibility'], ['ux', 'User experience'], ['performance', 'Performance'], ['tooling', 'Tooling']]
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const effort = (m: number) => (m < 60 ? `about ${m} min` : `about ${Math.round(m / 30) / 2} h`)

export async function openImprove(project: string) {
  const { dlg, head } = toolDialog('improve-panel', 'Improve this project', 'bolt')
  dlg.classList.add('improve-dialog')
  const hiddenKey = `forge.improveHidden:${project}`
  const skipped = loadIds(hiddenKey)
  const picked = new Set<string>()
  let report: HealthReport | null = null
  let features: Awaited<ReturnType<typeof window.forge.projectFeatureIdeas>> | null = null
  let tab: 'fix' | 'add' = 'fix'
  let loadError = ''
  let featureError = ''

  const stackRow = h('div', 'im-stack')
  const summary = h('p', 'tool-intro im-summary')
  const tabs = seg<'fix' | 'add'>([['fix', 'Problems'], ['add', 'Add a feature']], 'fix', (v) => { tab = v; if (v === 'add' && !features && !featureError) void loadFeatures(); render() })
  tabs.classList.add('im-tabs')
  const bar = h('div', 'im-bar')
  const list = h('div', 'im-list')
  const body = h('div', 'im-body')
  body.append(stackRow, summary, tabs, bar, list)
  const foot = h('div', 'modal-foot')
  const review = button('Ask the crew to review it deeply', () => { startCrewGoal({ goal: REVIEW_GOAL, path: project, reviewPlan: true }); dlg.close() })
  foot.append(h('span', 'modal-hint', 'Read-only: the crew writes REVIEW.md and changes no code.'), h('span', 'grow'), review)
  dlg.replaceChildren(head, body, foot)

  const skip = (id: string) => { skipped.add(id); picked.delete(id); saveIds(hiddenKey, skipped); render() }
  const visible = () => (report?.suggestions ?? []).filter((s) => !skipped.has(s.id))

  function problemRow(s: Suggestion) {
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.className = 'im-check'
    check.checked = picked.has(s.id)
    check.setAttribute('aria-label', `Select: ${s.title}`)
    check.onchange = () => { check.checked ? picked.add(s.id) : picked.delete(s.id); renderBar() }
    return goalItem({ title: s.title, why: s.why, goal: s.goal, evidence: s.evidence, severity: s.severity, meta: effort(s.effortMinutes), check, startLabel: 'Fix with the crew', path: project, onSkip: () => skip(s.id), onStart: () => dlg.close() })
  }

  function renderBar() {
    bar.replaceChildren()
    if (tab === 'add') {
      const n = [...skipped].filter((id) => id.startsWith('feature:')).length
      if (n) bar.append(button(`Show ${plural(n, 'skipped idea')}`, () => { for (const id of [...skipped]) if (id.startsWith('feature:')) skipped.delete(id); saveIds(hiddenKey, skipped); render() }, 'link-btn'))
      return
    }
    const items = visible()
    const high = items.filter((s) => s.severity === 'high')
    const chosen = items.filter((s) => picked.has(s.id))
    const fix = button(chosen.length ? `Fix ${chosen.length} selected` : 'Fix all high-severity', () => {
      const use = chosen.length ? chosen : high
      if (!use.length) return
      startCrewGoal({ goal: combineGoals(use), path: project })
      dlg.close()
    }, 'btn primary') as HTMLButtonElement
    fix.disabled = !chosen.length && !high.length
    fix.title = fix.disabled ? 'There is nothing high-severity to fix' : 'One crew run that works through the checked items in order'
    const selHigh = button('Select all high', () => { for (const s of high) picked.add(s.id); render() }) as HTMLButtonElement
    selHigh.disabled = !high.length
    bar.append(fix, selHigh)
    if (skipped.size) bar.append(button(`Show ${plural([...skipped].filter((id) => !id.startsWith('feature:')).length, 'skipped item')}`, () => { for (const id of [...skipped]) if (!id.startsWith('feature:')) skipped.delete(id); saveIds(hiddenKey, skipped); render() }, 'link-btn'))
  }

  function render() {
    stackRow.replaceChildren(...(report?.stack ?? []).map((s) => h('span', 'id-chip stack', s)))
    renderBar()
    if (tab === 'add') return renderFeatures()
    if (loadError) { summary.textContent = ''; const e = h('div', 'errcard'); e.append(h('p', '', loadError), button('Try again', () => void load(true))); list.replaceChildren(e); return }
    if (!report) { summary.textContent = `Looking through ${folderName(project)}…`; list.replaceChildren(h('div', 'skel skel-row'), h('div', 'skel skel-row'), h('div', 'skel skel-row')); return }
    const items = visible()
    const n = (sev: string) => items.filter((s) => s.severity === sev).length
    summary.textContent = items.length ? `${plural(items.length, 'thing')} found: ${n('high')} high, ${n('medium')} medium, ${n('low')} low.${report.facts.truncated ? ' Large project: only the first part was looked at.' : ''}` : 'Nothing obvious to fix.'
    if (!items.length) {
      const e = h('div', 'empty-state')
      e.append(h('p', '', skipped.size ? 'Nothing left to fix. The items you skipped are hidden.' : 'Nothing obvious to fix. A deeper review by the crew can still find things this quick look cannot.'))
      list.replaceChildren(e)
      return
    }
    const groups: Node[] = []
    for (const [area, label] of AREAS) {
      const rows = items.filter((s) => s.area === area)
      if (!rows.length) continue
      const g = h('section', 'im-group')
      g.append(h('h4', 'im-area', label), ...rows.map(problemRow))
      groups.push(g)
    }
    list.replaceChildren(...groups)
  }

  function renderFeatures() {
    summary.textContent = 'Features that fit this project. The crew builds them in the project itself.'
    if (featureError) { const e = h('div', 'errcard'); e.append(h('p', '', featureError), button('Try again', () => void loadFeatures())); list.replaceChildren(e); return }
    if (!features) { list.replaceChildren(h('div', 'skel skel-row'), h('div', 'skel skel-row')); return }
    const rows = features.ideas.filter((i) => !skipped.has(`feature:${i.id}`))
    if (!rows.length) { const e = h('div', 'empty-state'); e.append(h('p', '', 'No feature ideas left for this stack.')); list.replaceChildren(e); return }
    list.replaceChildren(...rows.map((i) => goalItem({ title: i.title, why: i.why, goal: i.goal, startLabel: 'Build with the crew', path: project, onSkip: () => skip(`feature:${i.id}`), onStart: () => dlg.close() })))
  }

  async function load(fresh = false) {
    loadError = ''
    report = null
    render()
    try { report = await window.forge.projectHealth(fresh) } catch (e) { loadError = cleanErr(e) }
    render()
  }
  async function loadFeatures() {
    featureError = ''
    features = null
    render()
    try { features = await window.forge.projectFeatureIdeas() } catch (e) { featureError = cleanErr(e) }
    render()
  }

  render()
  dlg.showModal()
  void load()
}
