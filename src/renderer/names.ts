// Every visible name for Forge's modes, places and agents lives here, so the copy stays consistent.
// Code identifiers, CSS classes, storage keys and IPC calls keep their old words (team, chat).
export const N = {
  solo: 'Solo',
  crew: 'Crew',
  crewRuns: 'Crew runs',
  recentRuns: 'Recent runs',
  sendCrew: 'Send the crew',
  backToSolo: 'Back to Solo',
  newChat: 'New Solo chat',
  chats: 'Chats',
  library: 'Model library',
  moreOptions: 'More options',
  live: 'Live',
  plan: 'Plan',
  feed: 'Crew feed',
  notes: 'Crew notes',
  checks: 'Checks',
  changing: 'Changing now',
  waiting: 'Waiting for you',
  reviewHead: 'Ready to land',
  land: 'Land it',
} as const

export const AGENT_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', local: 'Local' } as const
export const AGENT_FULL = { claude: 'Claude Code', codex: 'OpenAI Codex', gemini: 'Google Gemini', local: 'Local' } as const

// Static markup marks words with data-name="key"; this fills them from the map.
export function applyNames(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-name]').forEach((el) => {
    const key = el.dataset.name as keyof typeof N
    if (key in N) el.textContent = N[key]
  })
}

// The Gemini model list: what `agy models` reports for the signed-in account (empty until then), plus the one already saved.
export const geminiChoices = (models: readonly string[], current?: string, first = 'Default'): [string, string][] => {
  const out: [string, string][] = [['', first], ...models.map((m) => [m, m] as [string, string])]
  if (current && !out.some(([v]) => v === current)) out.push([current, current])
  return out
}
