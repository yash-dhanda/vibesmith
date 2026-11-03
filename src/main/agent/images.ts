import { readFileSync } from 'node:fs'

// A picture attached to a user message. Chats store only this reference (a path in the app's data folder);
// the bytes are read when a vision model is called.
export type ImageRef = { mime: string; path: string }
export const imageB64 = (r: ImageRef): string => readFileSync(r.path).toString('base64')

// Pictures are re-sent with every model call, which is slow and costly. Only the latest message that has pictures keeps them;
// earlier ones keep their text (and the model's own description of the picture, which is in its replies).
export function onlyLatestImages<T extends { role: string; images?: ImageRef[] }>(messages: T[]): T[] {
  let last = -1
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.images?.length) last = i
  })
  return messages.map((m, i) => (m.images?.length && i !== last ? { ...m, images: undefined } : m))
}
