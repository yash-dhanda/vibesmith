import type { Chat } from './chatStore'
import type { Checkpoint } from './checkpoint'

// Edit a message or try again: take the chat back to just before one of the user's messages, so it can be sent again.
// Both histories are cut (what the screen replays, and what the model remembers). Files can be put back too.

// Messages Forge injected itself (self-checks, plan steering, undo notes) are not the user's turns.
const INJECTED = ['[Forge', '[The user', 'Verification failed']
export const isUserTurn = (m: { role: string; content: string }) => m.role === 'user' && !INJECTED.some((p) => m.content.startsWith(p))

export type Rewound = { text: string; restore: Checkpoint | null }

// `userIndex` counts the user's messages from 0. Returns null when there is no such message.
// `restore` is the state of the files before the first run after that message that changed anything: put it back with undoTo.
export function rewindChat(chat: Chat, userIndex: number): Rewound | null {
  let seen = -1
  const t = chat.transcript.findIndex((x) => x.type === 'user' && ++seen === userIndex)
  if (t < 0) return null
  const text = (chat.transcript[t] as { type: 'user'; text: string }).text

  let restore: Checkpoint | null = null
  for (const x of chat.transcript.slice(t)) {
    if (x.type !== 'changes') continue
    restore ??= chat.checkpoints[x.checkpoint] ?? null
    delete chat.checkpoints[x.checkpoint]
  }
  chat.transcript = chat.transcript.slice(0, t)

  let turns = -1
  const m = chat.messages.findIndex((x) => isUserTurn(x) && ++turns === userIndex)
  if (m >= 0) chat.messages = chat.messages.slice(0, m)
  return { text, restore }
}
