import type { Run, RunEvent, Task } from '../main/team/types'

const usage = (runs = 0) => ({ input: runs * 18400, output: runs * 3200, cached: runs * 6100, costUsd: 0, runs })
const task = (id: string, title: string, agent: 'claude' | 'codex', status: Task['status'], phase: Task['phase'], deps: string[] = []): Task => ({
  id, title, agent, status, phase, deps, goal: title, acceptance: ['The change works and the project check passes'], kind: 'build', files: [], attempts: 0,
  fixRounds: status === 'running' && phase === 'fix' ? 1 : 0, reviews: status === 'done' ? [{ by: agent === 'claude' ? 'codex' : 'claude', verdict: 'pass', issues: '', round: 1, at: Date.now() }] : [],
  sessions: {}, branch: null, worktree: null, summary: status === 'done' ? 'Completed and reviewed.' : '', handoff: '',
  changed: status === 'done' ? [{ path: `${id}.ts`, status: 'modified', added: 24, removed: 7 }] : [], usage: usage(status === 'done' ? 2 : 1),
})

export function replayRun(state = 'running'): { run: Run; events: { t: number; ev: RunEvent }[] } {
  const now = Date.now()
  const tasks = [
    task('foundation', 'Shape the shared data model', 'claude', 'done', null),
    task('interface', 'Build the calm team workspace', 'codex', state === 'planning' ? 'queued' : 'running', state === 'planning' ? null : 'work', ['foundation']),
    task('verify', 'Connect and check the full flow', 'claude', 'queued', null, ['interface']),
  ]
  if (state === 'planning') tasks.splice(0)
  if (state === 'final') for (const item of tasks) { item.status = 'done'; item.phase = null; item.summary = 'Completed and reviewed.' }
  const status = state === 'final' || state === 'approval' ? 'awaiting_approval' : state === 'paused' ? 'paused' : state === 'interrupted' ? 'interrupted' : state === 'planning' ? 'planning' : 'running'
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
    final: state === 'final' ? { report: '## Ready to apply\n\nThe team built the shared workspace, reviewed every task, and passed the project check.\n\n- Added the task board and two live lanes\n- Kept approvals visible and keyboard reachable\n- Verified the result with `npm test`', files: [{ path: 'src/team.ts', status: 'added', added: 210, removed: 0 }, { path: 'src/styles.css', status: 'modified', added: 94, removed: 12 }], verifyOk: true, verifyOutput: '17 test files passed', reviewNotes: ['Cross-review passed'] } : undefined,
  }
  const events: { t: number; ev: RunEvent }[] = [
    { t: now - 120_000, ev: { type: 'agent', runId: run.id, taskId: 'foundation', phase: 'work', ev: { type: 'text', agent: 'claude', text: 'I’m mapping the states the interface needs to explain.' } } },
    { t: now - 105_000, ev: { type: 'agent', runId: run.id, taskId: 'foundation', phase: 'work', ev: { type: 'tool', agent: 'claude', id: 't1', kind: 'read', name: 'Read', summary: 'Reading the current renderer structure' } } },
    { t: now - 58_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'text', agent: 'codex', text: 'The task board is taking shape. I’m making the waiting states visible first.' } } },
    { t: now - 31_000, ev: { type: 'agent', runId: run.id, taskId: 'interface', phase: 'work', ev: { type: 'tool', agent: 'codex', id: 't2', kind: 'edit', name: 'Edit', summary: 'Building the run controls and activity lanes' } } },
    { t: now - 8_000, ev: { type: 'verify', runId: run.id, command: 'npm test', ok: true, output: '17 test files passed\n176 tests passed' } },
  ]
  return { run, events }
}
