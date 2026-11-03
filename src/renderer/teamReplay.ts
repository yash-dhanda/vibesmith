import type { Run, RunEvent, Task } from '../main/team/types'
import type { TeamMemory } from '../main/team/service'

const usage = (runs = 0) => ({ input: runs * 18400, output: runs * 3200, cached: runs * 6100, costUsd: 0, runs })
const task = (id: string, title: string, agent: 'claude' | 'codex', status: Task['status'], phase: Task['phase'], deps: string[] = []): Task => ({
  id, title, agent, status, phase, deps, goal: title, acceptance: ['The change works and the project check passes'], kind: 'build', files: [], attempts: 0,
  fixRounds: status === 'running' && phase === 'fix' ? 1 : 0, reviews: status === 'done' ? [{ by: agent === 'claude' ? 'codex' : 'claude', verdict: 'pass', issues: '', round: 1, at: Date.now() }] : [],
  sessions: {}, branch: null, worktree: null, summary: status === 'done' ? 'Completed and reviewed.' : '', handoff: '',
  changed: status === 'done' ? [{ path: `${id}.ts`, status: 'modified', added: 24, removed: 7 }] : [], usage: usage(status === 'done' ? 2 : 1),
})

export function replayRun(state = 'running'): { run: Run; events: { t: number; ev: RunEvent }[]; memory: TeamMemory } {
  const now = Date.now()
  const tasks = [
    task('foundation', 'Shape the shared data model', 'claude', 'done', null),
    task('interface', 'Build the calm team workspace', 'codex', state === 'planning' ? 'queued' : 'running', state === 'planning' ? null : 'work', ['foundation']),
    task('verify', 'Connect and check the full flow', 'claude', 'queued', null, ['interface']),
  ]
  if (state === 'planning') tasks.splice(0)
  if (state === 'final' || state === 'applied') for (const item of tasks) { item.status = 'done'; item.phase = null; item.summary = 'Completed and reviewed.' }
  const status = state === 'final' || state === 'approval' ? 'awaiting_approval' : state === 'applied' ? 'done' : state === 'paused' ? 'paused' : state === 'interrupted' ? 'interrupted' : state === 'planning' ? 'planning' : 'running'
  const run: Run = {
    id: 'replay-team-run', project: '/tmp/forge-team-replay', goal: 'Build a shared planning space where two agents can work together', status,
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
  if (state === 'planning') run.messages = []
  const events: { t: number; ev: RunEvent }[] = [
    { t: now - 132_000, ev: { type: 'agent', runId: run.id, taskId: 'foundation', phase: 'work', ev: { type: 'prompt', agent: 'claude', text: 'Goal: Build a shared planning space.\n\nTask: Shape the shared data model.\n\nAcceptance: keep every state restart-safe and keyboard reachable.\n\nShared context: Codex will build the interface after this handoff.' } } },
    { t: now - 120_000, ev: { type: 'agent', runId: run.id, taskId: 'foundation', phase: 'work', ev: { type: 'text', agent: 'claude', text: 'I’m mapping the states the interface needs to explain.' } } },
    { t: now - 105_000, ev: { type: 'agent', runId: run.id, taskId: 'foundation', phase: 'work', ev: { type: 'tool', agent: 'claude', id: 't1', kind: 'read', name: 'Read', summary: 'Reading the current renderer structure' } } },
    { t: now - 58_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'text', agent: 'codex', text: 'The task board is taking shape. I’m making the waiting states visible first.' } } },
    { t: now - 52_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'prompt', agent: 'codex', text: 'Goal: Build a shared planning space.\n\nTask: Build the calm team workspace.\n\nAcceptance: light and dark themes, narrow layouts, and honest live activity.\n\nHandoff from Claude: the data model is ready; keep controls keyboard reachable.' } } },
    { t: now - 31_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'tool', agent: 'codex', id: 't2', kind: 'edit', name: 'Edit', summary: 'Building the run controls and activity lanes' } } },
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
    project: { decisions: [{ id: 'pd1', text: 'Use warm neutrals and ember for intent.', by: 'user', at: now - 86_400_000 }], errors: [], stats: { 'claude:research': { ok: 4, fail: 0 }, 'codex:build': { ok: 7, fail: 1 } } },
  }
  if (state === 'settled') events.push({ t: now - 4_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'text', agent: 'codex', text: 'The live files panel and shared memory are connected.' } } })
  return { run, events: state === 'planning' ? [] : events, memory }
}
