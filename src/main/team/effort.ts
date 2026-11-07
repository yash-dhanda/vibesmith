import type { AgentName } from './events'
import type { TaskKind, TaskPhase, TeamConfig } from './types'

const RANK = ['low', 'medium', 'high', 'xhigh', 'max']
// Never above what the user configured; the cap itself when nothing is configured.
const atMost = (set: string | undefined, cap: string) => (set && RANK.indexOf(set) <= RANK.indexOf(cap) ? set : cap)
const SMALL_DIFF = 5 // files

// The reasoning effort for one agent turn (the string Claude's --effort and Codex's model_reasoning_effort take). The local model and Gemini have none.
// fixed: the configured value. auto: research and reviews of small diffs run at most "medium"; building, fixing and planning keep the configured
// value. cheap: "low" for everything that only reads, "medium" at most for planning and writing code.
export function effortFor(o: { agent: AgentName; phase: TaskPhase | 'plan' | 'final-review'; kind: TaskKind; changedFiles?: number; config: Pick<TeamConfig, 'effortMode' | 'claudeEffort' | 'codexEffort'> }): string | undefined {
  if (o.agent === 'local' || o.agent === 'gemini') return undefined // neither has a reasoning-effort switch
  const set = o.agent === 'claude' ? o.config.claudeEffort : o.config.codexEffort
  const mode = o.config.effortMode ?? 'auto'
  if (mode === 'fixed') return set
  const reads = o.phase === 'review' || o.phase === 'final-review' || (o.phase === 'work' && o.kind === 'research')
  if (mode === 'cheap') return reads ? atMost(set, 'low') : atMost(set, 'medium')
  const smallRead = o.kind === 'research' && o.phase === 'work' ? true : reads && o.changedFiles !== undefined && o.changedFiles <= SMALL_DIFF
  return smallRead ? atMost(set, 'medium') : set
}
