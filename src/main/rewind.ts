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

  const cps: Checkpoint[] = []
  for (const x of chat.transcript.slice(t)) {
    if (x.type !== 'changes') continue
    const cp = chat.checkpoints[x.checkpoint]
    if (cp) cps.push(cp)
    delete chat.checkpoints[x.checkpoint]
  }
  // Going back past several runs puts back what all of them changed, from the state before the first.
  let restore: Checkpoint | null = null
  if (cps.length) {
    const { paths, ...first } = cps[0]
    restore = cps.every((c) => c.paths) ? { ...first, paths: [...new Set(cps.flatMap((c) => c.paths!))] } : first
  }
  const users = chat.transcript.slice(0, t + 1).filter((x) => x.type === 'user') as { text: string; attachments?: unknown[] }[]
  chat.transcript = chat.transcript.slice(0, t)

  // Find the message by its text, in order: a real message that starts with "Verification failed" or "[Forge" would
  // otherwise be taken for an injected one and shift the count. Forge's own notes are never the exact text of a user turn.
  let m = -1
  for (const u of users) {
    const from = m + 1 // attachments are appended to the message, so only then is a prefix match enough
    m = chat.messages.findIndex((x, i) => i >= from && x.role === 'user' && (x.content === u.text || (!!u.attachments?.length && x.content.startsWith(u.text))))
    if (m < 0) break
  }
  if (m < 0) {
    let turns = -1
    m = chat.messages.findIndex((x) => isUserTurn(x) && ++turns === userIndex)
  }
  if (m >= 0) chat.messages = chat.messages.slice(0, m)
  return { text, restore }
}
