import type { Run, RunEvent, Task } from '../main/team/types'
import type { TeamMemory } from '../main/team/service'

const usage = (runs = 0) => ({ input: runs * 18400, output: runs * 3200, cached: runs * 6100, costUsd: 0, runs })
const task = (id: string, title: string, agent: 'claude' | 'codex', status: Task['status'], phase: Task['phase'], deps: string[] = []): Task => ({
  id, title, agent, status, phase, deps, goal: title, acceptance: ['The change works and the project check passes'], kind: 'build', files: [], attempts: 0,
  fixRounds: status === 'running' && phase === 'fix' ? 1 : 0, reviews: status === 'done' ? [{ by: agent === 'claude' ? 'codex' : 'claude', verdict: 'pass', issues: '', round: 1, at: Date.now() }] : [],
  sessions: {}, branch: null, worktree: null, summary: status === 'done' ? 'Completed and reviewed.' : '', handoff: '',
  changed: status === 'done' ? [{ path: `${id}.ts`, status: 'modified', added: 24, removed: 7 }] : [], usage: usage(status === 'done' ? 2 : 1),
})

// Long on purpose: real goals run to several sentences, and the run header must clamp them.
export const REPLAY_GOAL = 'Build a shared planning space where two agents can work together: a task board with live lanes, approvals you can reach from the keyboard, and one final review before anything lands. Keep it calm in light and dark themes, make it work in a narrow window, and check the whole flow with npm test before handing it back.'

export function replayRun(state = 'running'): { run: Run; events: { t: number; ev: RunEvent }[]; memory: TeamMemory } {
  const now = Date.now()
  const tasks = [
    task('foundation', 'Shape the shared data model', 'claude', 'done', null),
    task('interface', 'Build the calm team workspace', 'codex', state === 'planning' ? 'queued' : 'running', state === 'planning' ? null : 'work', ['foundation']),
    task('verify', 'Connect and check the full flow', 'claude', 'queued', null, ['interface']),
  ]
  if (state === 'stress') {
    tasks.splice(0, tasks.length, ...Array.from({ length: 30 }, (_, i) => task(`task-${i + 1}`, `Build resilient part ${i + 1} with an unusually descriptive outcome`, i % 2 ? 'codex' : 'claude', i < 3 ? 'done' : i === 3 ? 'running' : 'queued', i === 3 ? 'work' : null, i ? [`task-${i}`] : [])))
  }
  if (state === 'planning') tasks.splice(0)
  if (state === 'final' || state === 'applied') for (const item of tasks) { item.status = 'done'; item.phase = null; item.summary = 'Completed and reviewed.' }
  const status = state === 'final' || state === 'approval' ? 'awaiting_approval' : state === 'applied' ? 'done' : state === 'paused' ? 'paused' : state === 'interrupted' ? 'interrupted' : state === 'planning' ? 'planning' : 'running'
  const run: Run = {
    id: 'replay-team-run', project: '/tmp/forge-team-replay', goal: REPLAY_GOAL, status,
    pausedReason: status === 'paused' ? 'The ChatGPT plan reached the limit set for this run.' : status === 'interrupted' ? 'Forge restarted while the team was working.' : undefined,
    createdAt: now - 193_000, updatedAt: now, baseCommit: '', integrationBranch: 'forge/replay-team-run', integrationWorktree: '',
    plan: { summary: 'Build the foundation, create the interface, then verify the result together.', plannedBy: 'claude' }, tasks,
    messages: [
      { id: 'm1', from: 'claude', to: 'codex', taskId: 'interface', kind: 'handoff', body: 'The data model is ready. Keep the controls usable with a keyboard.', at: now - 70_000, readBy: [] },
      { id: 'm2', from: 'codex', to: 'all', taskId: 'interface', kind: 'decision', body: 'I’m keeping the live activity secondary to the task story.', at: now - 42_000, readBy: [] },
    ], decisions: [], errors: [], approvals: state === 'approval' ? [{ id: 'a1', kind: 'permission', title: 'Allow the project check?', detail: 'Codex wants to run npm test in the isolated task worktree.', taskId: 'interface', agent: 'codex', status: 'pending', at: now - 3000 }] : [],
    usage: { claude: usage(2), codex: usage(2) }, limits: { codex: { primaryPct: 27, primaryResetsAt: now + 9_000_000 } },
    config: { planner: 'auto', codexModel: 'gpt-5.6-luna', claudeModel: 'sonnet', claudeEffort: 'high', maxParallelPerAgent: 2, maxFixRounds: 3, maxVerifyRounds: 2, review: 'cross', finalReview: true, allowSubtasks: true, budget: { maxTokens: 500000, maxMinutes: 60, maxAgentRuns: 20 }, codexMode: 'app-server', maxLimitPercent: 90 },
    final: state === 'final' || state === 'applied' ? { report: '## Ready to apply\n\nThe team built the shared workspace, reviewed every task, and passed the project check.\n\n- Added the task board and two live lanes\n- Kept approvals visible and keyboard reachable\n- Verified the result with `npm test`', files: [{ path: 'src/team.ts', status: 'added', added: 210, removed: 0 }, { path: 'src/styles.css', status: 'modified', added: 94, removed: 12 }], verifyOk: true, verifyOutput: '17 test files passed', reviewNotes: ['Cross-review passed'] } : undefined,
    applied: state === 'applied', appliedCheckpoint: state === 'applied' ? 'replay-checkpoint' : undefined,
  }
  if (state === 'authpause') { run.status = 'paused'; run.pausedReason = 'Claude Code is not signed in. Run: claude auth login, then resume the team.' }
  if (state === 'limitpause' || state === 'budget') { run.status = 'paused'; run.pausedReason = 'This run reached its plan allowance. Allow 50% more to continue.'; run.approvals = [{ id: 'budget-1', kind: 'budget', title: 'The team needs more room to finish', detail: 'The current token budget is used. Allow 50% more, or stop here.', status: 'pending', at: now }] }
  if (state === 'reviewoverride') { run.status = 'paused'; run.approvals = [{ id: 'review-1', kind: 'review_override', title: 'Merge despite a review concern?', detail: 'Claude found a keyboard-navigation issue. Merge anyway only if you accept that risk.', taskId: 'interface', agent: 'codex', status: 'pending', at: now }] }
  if (state === 'planreview') { run.status = 'paused'; run.pausedReason = 'Review the plan, then start the team.'; for (const item of run.tasks) { item.status = 'queued'; item.phase = null }; run.approvals = [{ id: 'plan-1', kind: 'plan', title: 'Start with this plan?', detail: `${run.tasks.length} tasks. You can edit, reassign or skip tasks first.`, status: 'pending', at: now }] }
  if (state === 'permission') { run.status = 'paused'; run.approvals = [{ id: 'permission-1', kind: 'permission', title: 'Allow a long-running project command that may rewrite generated files?', detail: 'Codex wants to run npm run generate -- --all. It can update generated source files in the isolated task folder.', taskId: 'interface', agent: 'codex', status: 'pending', at: now }] }
  if (state === 'failed' || state === 'blocked') { run.status = state === 'failed' ? 'failed' : 'paused'; const failed = run.tasks[1]; failed.status = state; failed.error = state === 'failed' ? 'The renderer check failed after two attempts.' : 'This task is waiting on a dependency that did not finish.'; run.pausedReason = failed.error }
  if (state === 'conflict') { run.status = 'paused'; const conflict = run.tasks[1]; conflict.status = 'blocked'; conflict.phase = 'conflict'; conflict.error = 'Two tasks changed the same lines. Choose Retry after reviewing the conflict, or Skip this task.'; run.pausedReason = conflict.error }
  if (state === 'verifyfail') { run.status = 'running'; run.tasks.push(task('fix-verify', 'Fix the failing project check', 'codex', 'running', 'fix', ['interface'])) }
  if (state === 'cancelled') { run.status = 'cancelled'; run.pausedReason = 'You cancelled this run. No changes reached your project.' }
  if (state === 'planningfail') { run.status = 'failed'; run.tasks = []; run.pausedReason = 'The team could not create a plan because the project could not be read.' }
  if (state === 'applyfail') { run.status = 'awaiting_approval'; run.final = { report: '## Ready, but the project moved\n\nThe result is complete. Applying it will re-check the project first.', files: [{ path: 'hello.js', status: 'added', added: 1, removed: 0 }], verifyOk: true, verifyOutput: 'Passed', reviewNotes: ['The final reviewer found no blocking issues.'] } }
  if (state === 'final' || state === 'localcheck') {
    const local = task('local-docs', 'Write the setup notes', 'claude', 'done', null); local.agent = 'local'; local.reviews = [{ by: 'codex', verdict: 'pass', issues: '', round: 1, at: now }]
    run.tasks.push(local)
  }
  if (state === 'question') {
    run.status = 'running'
    run.approvals = [
      { id: 'q-db', kind: 'question', title: 'Which database should the lobby use?', detail: 'The plan works with any of these. This decides how saved lobbies survive a restart.', agent: 'codex', taskId: 'interface', status: 'pending', at: now - 9_000, options: [{ label: 'SQLite', description: 'One file next to the app. No server to run.' }, { label: 'Postgres', description: 'A real server. Best if many people share it.' }, { label: 'In memory', description: 'Fastest, but lobbies vanish when the app restarts.' }] },
      { id: 'q-platforms', kind: 'question', title: 'Which platforms should the first release support?', detail: 'Pick every one that should work on day one.', agent: 'claude', taskId: 'verify', status: 'pending', at: now - 6_000, multi: true, options: [{ label: 'Web', description: 'Any modern browser.' }, { label: 'Desktop', description: 'Windows, macOS and Linux.' }, { label: 'Mobile', description: 'iOS and Android.' }] },
      { id: 'q-theme', kind: 'question', title: 'Should the lobby keep the current colours?', detail: '', agent: 'claude', taskId: 'foundation', status: 'allowed', answer: 'Keep the current palette', at: now - 80_000, answeredAt: now - 75_000 },
    ]
  }
  if (state === 'planning') run.messages = []
  const events: { t: number; ev: RunEvent }[] = [
    { t: now - 132_000, ev: { type: 'agent', runId: run.id, taskId: 'foundation', phase: 'work', ev: { type: 'prompt', agent: 'claude', text: 'Goal: Build a shared planning space.\n\nTask: Shape the shared data model.\n\nAcceptance: keep every state restart-safe and keyboard reachable.\n\nShared context: Codex will build the interface after this handoff.' } } },
    { t: now - 120_000, ev: { type: 'agent', runId: run.id, taskId: 'foundation', phase: 'work', ev: { type: 'text', agent: 'claude', text: 'I’m mapping the states the interface needs to explain.' } } },
    { t: now - 105_000, ev: { type: 'agent', runId: run.id, taskId: 'foundation', phase: 'work', ev: { type: 'tool', agent: 'claude', id: 't1', kind: 'read', name: 'Read', summary: 'src/renderer/team.ts' } } },
    { t: now - 58_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'text', agent: 'codex', text: 'The task board is taking shape. I’m making the waiting states visible first.' } } },
    { t: now - 52_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'prompt', agent: 'codex', text: 'Goal: Build a shared planning space.\n\nTask: Build the calm team workspace.\n\nAcceptance: light and dark themes, narrow layouts, and honest live activity.\n\nHandoff from Claude: the data model is ready; keep controls keyboard reachable.' } } },
    { t: now - 31_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'tool', agent: 'codex', id: 't2', kind: 'edit', name: 'apply_patch', summary: 'update src/renderer/team.ts' } } },
    { t: now - 28_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'delta', agent: 'codex', channel: 'output', id: 'live-command', text: 'Checking renderer bundle…\ntransforming modules…' } } },
    { t: now - 24_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'delta', agent: 'codex', channel: 'thinking', id: 'thought-1', text: 'I should keep live code subordinate to the task story, and make the exact prompt available without putting it in the main reading path.' } } },
    { t: now - 22_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'delta', agent: 'codex', channel: 'text', id: 'answer-1', text: 'I’m connecting ' } } },
    { t: now - 20_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'delta', agent: 'codex', channel: 'text', id: 'answer-1', text: 'the live files panel and shared memory now' } } },
    { t: now - 19_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'code', agent: 'codex', id: 'code-1', path: 'src/renderer/team.ts', text: 'function renderLiveFiles() {\n', kind: 'content', done: false } } },
    { t: now - 17_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'code', agent: 'codex', id: 'code-1', path: 'src/renderer/team.ts', text: "function renderLiveFiles() {\n  return files.map(file => file.path)\n}\n", kind: 'content', done: false } } },
    { t: now - 15_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'code', agent: 'codex', id: 'code-2', path: 'src/renderer/styles.css', text: '--- a/src/renderer/styles.css\n+++ b/src/renderer/styles.css\n@@ -1,2 +1,3 @@\n .agent-lane { display: grid; }\n+.live-code { border-left: 2px solid var(--accent); }', kind: 'diff', done: true } } },
    { t: now - 12_000, ev: { type: 'live', runId: run.id, taskId: 'interface', files: [{ path: 'src/renderer/team.ts', status: 'modified', added: 46, removed: 4 }, { path: 'src/renderer/styles.css', status: 'modified', added: 18, removed: 2 }] } },
    { t: now - 8_000, ev: { type: 'verify', runId: run.id, command: 'npm test', ok: true, output: '17 test files passed\n176 tests passed' } },
  ]
  const memory: TeamMemory = {
    decisions: [{ id: 'd1', text: 'Keep live activity secondary to the task story.', by: 'codex', taskId: 'interface', at: now - 42_000 }],
    messages: run.messages,
    handoffs: [{ taskId: 'foundation', title: 'Shape the shared data model', agent: 'claude', handoff: 'The data model is ready. Keep the controls usable with a keyboard.' }],
    errors: [{ id: 'e1', taskId: 'foundation', signature: 'worker failed to load', text: 'The diff worker initially failed to load.', fix: 'Use the bundled local Monaco worker.', at: now - 90_000 }],
    project: { decisions: [{ id: 'pd1', text: 'Use neutral greys and one white primary action.', by: 'user', at: now - 86_400_000 }], errors: [], stats: { 'claude:research': { ok: 4, fail: 0 }, 'codex:build': { ok: 7, fail: 1 } } },
  }
  if (state === 'verifyfail') events.push({ t: now - 2_000, ev: { type: 'verify', runId: run.id, command: 'npm test', ok: false, output: '1 test failed: expected the button to be keyboard reachable.\nA fix task has started.' } })
  if (state === 'stress') {
    const longLine = 'unbroken_'.repeat(3000) + ' 🌍 مرحبا שלום 👩🏽‍💻'
    run.messages.push({ id: 'stress-message', from: 'user', to: 'all', kind: 'steer', body: longLine, at: now, readBy: [] })
    for (let i = 0; i < 20_000; i++) events.push({ t: now + i, ev: { type: 'agent', runId: run.id, taskId: i % 2 ? 'task-4' : 'task-3', phase: 'work', ev: { type: 'delta', agent: i % 2 ? 'codex' : 'claude', channel: 'text', id: `stream-${i % 2}`, text: i % 37 ? 'x' : '🙂' } } })
    for (let i = 0; i < 300; i++) events.push({ t: now + 21_000 + i, ev: { type: 'agent', runId: run.id, taskId: i % 2 ? 'task-4' : 'task-3', phase: 'work', ev: { type: 'tool', agent: i % 2 ? 'codex' : 'claude', id: `tool-${i}`, kind: i % 3 ? 'read' : 'command', name: 'Tool', summary: `Stress tool row ${i}` } } })
    const lines = Array.from({ length: 5000 }, (_, i) => `export const line${i} = ${i}`).join('\n')
    for (let i = 1; i <= 50; i++) events.push({ t: now + 22_000 + i, ev: { type: 'agent', runId: run.id, taskId: 'task-4', phase: 'work', ev: { type: 'code', agent: 'codex', id: 'huge-code', path: 'src/huge.ts', text: lines.slice(0, Math.floor(lines.length * i / 50)), kind: 'content', done: i === 50 } } })
    events.push({ t: now + 23_000, ev: { type: 'agent', runId: run.id, taskId: 'task-4', phase: 'work', ev: { type: 'delta', agent: 'codex', channel: 'output', id: 'huge-output', text: 'output line\n'.repeat(20_000) } } })
  }
  if (state === 'settled') events.push(
    { t: now - 5_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'tool_result', agent: 'codex', id: 'live-command', ok: true, text: 'Renderer bundle passed.' } } },
    { t: now - 4_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'text', agent: 'codex', text: 'The live files panel and shared memory are connected.' } } },
  )
  return { run, events: state === 'planning' ? [] : events, memory }
}
