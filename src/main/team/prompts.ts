import type { AgentName } from './events'
import { rank } from './memory'
import type { Message, Review, Run, Task } from './types'

// ---------------------------------------------------------------- planning

export type PlannedTask = { id: string; title: string; goal: string; acceptance: string[]; deps: string[]; agent: AgentName | null; kind: 'build' | 'research'; files: string[] }
export type Plan = { summary: string; tasks: PlannedTask[] }

export function planPrompt(goal: string, brief: string, agents: AgentName[]): string {
  return `You are the lead planner of a small team of coding agents. Plan the work for this goal, then reply with ONE JSON object and nothing else.

GOAL:
${goal}
${brief ? `\nPROJECT NOTES:\n${brief}\n` : ''}
First look at the project folder (read-only: list and read files; do not change anything). Then split the goal into 1 to 8 tasks.

Rules for a good plan:
- Each task is a unit one agent can finish alone in one sitting and that can be checked.
- Tasks that touch different files can run in parallel. Give "deps" only when a task truly needs another one's result.
- Make tasks touch different files where you can. Two tasks editing the same file will conflict.
- "agent": ${agents.includes('claude') && agents.includes('codex') ? '"claude" for architecture, planning, multi-file design and research; "codex" for well-scoped implementation and tests' : `"${agents[0]}" (the only agent available)`}.
- "kind": "build" changes files; "research" only reads and reports.
- "acceptance": 1 to 4 concrete checks (a command that must pass, a behaviour that must hold).
- "files": the files you expect the task to create or edit.

JSON shape:
{"summary":"one sentence","tasks":[{"id":"t1","title":"short title","goal":"what to do and why","acceptance":["..."],"deps":[],"agent":"claude","kind":"build","files":["src/x.ts"]}]}`
}

// Pulls the JSON object out of a reply that may wrap it in prose or a code fence, and checks it. Throws a readable message.
export function parsePlan(text: string, available: AgentName[], maxTasks = 12): Plan {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : text
  const a = body.indexOf('{'), b = body.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('the planner did not return a plan')
  let raw: any
  try {
    raw = JSON.parse(body.slice(a, b + 1))
  } catch {
    throw new Error('the planner returned a plan that is not valid JSON')
  }
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) throw new Error('the plan has no tasks')
  const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n)
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 300)).filter(Boolean).slice(0, 8) : [])
  const ids = new Map<string, string>() // planner's id -> clean id
  raw.tasks.slice(0, maxTasks).forEach((t: any, i: number) => ids.set(str(t?.id, 40) || `t${i + 1}`, `t${i + 1}`))
  const tasks: PlannedTask[] = raw.tasks.slice(0, maxTasks).map((t: any, i: number) => {
    const title = str(t?.title, 120)
    const goal = str(t?.goal, 2000)
    if (!title && !goal) throw new Error(`task ${i + 1} has no title or goal`)
    const agent = t?.agent === 'claude' || t?.agent === 'codex' ? (available.includes(t.agent) ? t.agent : (available[0] ?? null)) : null
    return {
      id: `t${i + 1}`,
      title: title || goal.slice(0, 80),
      goal: goal || title,
      acceptance: list(t?.acceptance),
      deps: [...new Set((Array.isArray(t?.deps) ? t.deps : []).map((d: unknown) => ids.get(str(d, 40))).filter((d: string | undefined): d is string => !!d && d !== `t${i + 1}`))] as string[],
      agent,
      kind: t?.kind === 'research' ? 'research' : 'build',
      files: list(t?.files),
    }
  })
  // a dependency cycle would stall the run forever
  const done = new Set<string>()
  let progress = true
  while (progress && done.size < tasks.length) {
    progress = false
    for (const t of tasks) if (!done.has(t.id) && t.deps.every((d) => done.has(d))) (done.add(t.id), (progress = true))
  }
  if (done.size < tasks.length) throw new Error('the plan has tasks that wait for each other in a circle')
  return { summary: str(raw.summary, 500), tasks }
}

// ---------------------------------------------------------------- doing a task

const TOOLS = `You are one member of a team of coding agents, each working in its own copy of the project. Team tools (MCP server "forge_team") let you talk to the others:
- team_post(to, kind, body): tell a teammate ("claude", "codex" or "all") something they need: a finding, a question, a decision.
- team_inbox(): read messages sent to you. Call it when you start and again before you finish: teammates and the user may have sent something new.
- team_context(query): look up earlier decisions, problems and notes about this project.
- team_decision(text): record a decision others must follow (a name, an API shape, a library choice).
- team_handoff(notes): at the end, say what the next task needs to know (files, names, how to run, what is left).
- team_request_approval(title, detail): ask the user BEFORE anything destructive, any deployment, or anything that needs a secret. Wait for the answer.
Do not push to git, deploy, or read secrets. If a tool is missing, carry on without it.`

export type Ctx = { brief: string; rules: string; inbox: Message[]; memory: string[]; deps: { task: Task }[]; pastProblems: string[]; steer: string[] }

export function contextFor(run: Run, task: Task, extra: { inbox: Message[]; brief: string; rules: string; past: string[]; steer: string[] }): Ctx {
  const query = `${task.title} ${task.goal} ${task.acceptance.join(' ')} ${task.files.join(' ')}`
  const notes = rank(
    [...run.decisions.map((d) => ({ text: `Decision (${d.by}): ${d.text}` })), ...run.messages.filter((m) => m.kind === 'finding' || m.kind === 'decision').map((m) => ({ text: `${m.from} said: ${m.body}` }))],
    query,
    6,
  ).map((n) => n.text)
  return { brief: extra.brief, rules: extra.rules, inbox: extra.inbox, memory: notes, deps: task.deps.map((id) => ({ task: run.tasks.find((t) => t.id === id)! })).filter((d) => d.task), pastProblems: extra.past, steer: extra.steer }
}

const section = (title: string, body: string | string[]) => {
  const t = Array.isArray(body) ? body.map((b) => `- ${b}`).join('\n') : body
  return t.trim() ? `\n## ${title}\n${t}\n` : ''
}

const render = (c: Ctx): string =>
  section('Project', c.brief) +
  section('Rules from the user (follow them)', c.rules) +
  section('What finished tasks hand over', c.deps.map((d) => `${d.task.id} "${d.task.title}": ${d.task.handoff || d.task.summary}`)) +
  section('Messages for you', c.inbox.map((m) => `from ${m.from}${m.kind !== 'note' ? ` (${m.kind})` : ''}: ${m.body}`)) +
  section('Instructions from the user during this run', c.steer) +
  section('Relevant notes', c.memory) +
  section('Problems met earlier on this project (do not repeat them)', c.pastProblems)

export function workPrompt(run: Run, task: Task, c: Ctx): string {
  const write = task.kind === 'build'
  return `${TOOLS}

# Overall goal of the team
${run.goal}

# Your task ${task.id}: ${task.title}
${task.goal}
${section('Done means', task.acceptance)}${task.files.length ? section('Files you will probably touch', task.files) : ''}${render(c)}
## How to work
${write ? '- Work only inside the current folder. Make the change, run the checks that exist (tests, build, the commands in "Done means"), and fix what fails.\n- Keep changes focused on this task; other agents are doing the rest in parallel.\n- Do not commit; the team commits for you.' : '- Read only. Do not change any file. Report what you found.'}
- Finish by calling team_handoff with what the next task needs, then end with a short plain summary of what you did${write ? ' and what you verified' : ''}.`
}

export function reviewPrompt(run: Run, task: Task, diff: string, round: number, c: Ctx): string {
  return `You are reviewing another agent's work. Read only; do not change files.

# Team goal
${run.goal}

# The task that was done: ${task.id} ${task.title}
${task.goal}
${section('It must satisfy', task.acceptance)}${render(c)}
# Their summary
${task.summary || '(none)'}

# The change (git diff of their branch against the team branch)
${diff || '(no changes)'}

# Your job (review round ${round})
Check: does it do what the task asks, is it correct, does it have bugs or security problems, are tests or checks present where they should be, does it fit the rest of the project. You may read other files and run the tests.
Reply with a short review. Put the issues that MUST be fixed first, as a bullet list. Then end with exactly one final line:
VERDICT: PASS
or
VERDICT: FAIL
Use FAIL only for real problems (wrong behaviour, bugs, missing required parts), not style preferences.`
}

export function parseVerdict(text: string): { verdict: Review['verdict']; issues: string } {
  const all = [...text.matchAll(/VERDICT:\s*\**\s*(PASS|FAIL)/gi)]
  const last = all.at(-1)
  const verdict = last ? (last[1].toUpperCase() === 'PASS' ? 'pass' : 'fail') : 'unclear'
  const issues = (last ? text.slice(0, last.index) : text).trim().slice(0, 4000)
  return { verdict, issues }
}

export function fixPrompt(task: Task, issues: string, round: number): string {
  return `A reviewer checked your work on task ${task.id} "${task.title}" (round ${round}) and found problems:

${issues}

Fix every issue that is real, run the checks again, and then give a short summary of what you changed. If you disagree with an item, say why in the summary instead of ignoring it. Do not commit.`
}

export function conflictPrompt(task: Task, files: string[]): string {
  return `Merging task ${task.id} "${task.title}" into the team branch produced conflicts in:
${files.map((f) => `- ${f}`).join('\n')}

Open each file. The markers <<<<<<<, ======= and >>>>>>> show the two versions. Combine both sides so that BOTH changes still work (the team branch side is the work already merged; the other side is the new task: ${task.goal.slice(0, 300)}). Remove every marker. Run the project's checks if there are any. Do not add features. Do not commit.`
}

export function verifyFixPrompt(command: string, output: string, round: number): string {
  return `After all tasks were merged, the project's check failed (attempt ${round}).

Command: ${command}
Output:
${output.slice(-6000)}

Find the cause and fix it with the smallest change that makes the command pass. Do not weaken or delete tests to make them pass. Run the command again to confirm. Do not commit.`
}

export function finalReviewPrompt(run: Run, diff: string): string {
  return `The team finished this goal:
${run.goal}

Below is the complete change they made (merged result). Read only; do not change files. Check that the whole thing works together and meets the goal: missing pieces, integration mistakes between parts written by different agents, security problems, leftover debug code.

${diff || '(no changes)'}

Reply with a short review, the must-fix problems first as bullets, then one final line: VERDICT: PASS or VERDICT: FAIL (FAIL only for real problems).`
}

// ---------------------------------------------------------------- the final report the user reads

export function buildReport(run: Run, verify: { ok: boolean | null; command?: string; output?: string }, reviewNotes: string[]): string {
  const lines: string[] = [`# ${run.goal.split('\n')[0].slice(0, 120)}`, '', run.plan.summary ? `${run.plan.summary}\n` : '']
  const done = run.tasks.filter((t) => t.status === 'done')
  const bad = run.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
  lines.push(`## What the team did`)
  for (const t of done) lines.push(`- **${t.title}** (${t.agent}${t.fixRounds ? `, ${t.fixRounds} fix round${t.fixRounds > 1 ? 's' : ''}` : ''}): ${(t.summary || t.handoff || 'done').replace(/\s+/g, ' ').slice(0, 300)}`)
  if (bad.length) {
    lines.push('', '## Not finished')
    for (const t of bad) lines.push(`- **${t.title}** (${t.status}): ${(t.error ?? '').slice(0, 200)}`)
  }
  const files = new Map<string, Task['changed'][number]>()
  for (const t of done) for (const f of t.changed) files.set(f.path, f)
  lines.push('', `## Files changed (${files.size})`)
  for (const f of [...files.values()].slice(0, 60)) lines.push(`- ${f.status} \`${f.path}\` (+${f.added} -${f.removed})`)
  lines.push('', '## Checks')
  lines.push(verify.ok === null ? '- No test or build command was found, so nothing was run automatically.' : verify.ok ? `- \`${verify.command}\` passed.` : `- \`${verify.command}\` FAILED:\n\n\`\`\`\n${(verify.output ?? '').slice(-1500)}\n\`\`\``)
  const reviews = run.tasks.flatMap((t) => t.reviews.map((r) => `- ${t.title}: ${r.by} said ${r.verdict}${r.round > 1 ? ` (round ${r.round})` : ''}`))
  if (reviews.length) lines.push('', '## Reviews', ...reviews.slice(0, 30))
  if (reviewNotes.length) lines.push('', '## Final review notes', ...reviewNotes.map((n) => `- ${n.replace(/\s+/g, ' ').slice(0, 400)}`))
  if (run.decisions.length) lines.push('', '## Decisions made', ...run.decisions.slice(-10).map((d) => `- ${d.text}`))
  const u = run.usage
  lines.push('', '## Usage', `- Claude: ${u.claude.runs} runs, ${u.claude.input + u.claude.output} tokens${u.claude.costUsd ? ` (about $${u.claude.costUsd.toFixed(2)} at API rates)` : ''}`, `- Codex: ${u.codex.runs} runs, ${u.codex.input + u.codex.output} tokens`)
  return lines.join('\n')
}

