// Sizes and the question before a clone. Pure, so the window and the main process share it. GitHub reports a repository's size in KB,
// including history; a shallow clone skips the history, so the real download is usually smaller.

export const ASK_KB = 50 * 1024 // below this a clone starts without a question
export const LARGE_KB = 400 * 1024 // from here a row carries the "Large download" tag
export const SPARE_BYTES = 200 * 1024 * 1024 // free space wanted on top of the repository's size

export function formatKb(kb: number): string {
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`
  if (kb < 1024 * 1024) return `${Math.round(kb / 1024)} MB`
  return `${(kb / 1024 / 1024).toFixed(1)} GB`
}
export const formatBytes = (b: number) => formatKb(b / 1024)

// 3 minutes plus 1 minute per 200 MB, at most 20.
export const cloneTimeoutMs = (sizeKb?: number | null) => Math.min(20, 3 + Math.floor((sizeKb ?? 0) / 1024 / 200)) * 60_000

// The line shown before cloning, or null when there is nothing to ask. A low-disk warning never blocks: the owner can still continue.
export function confirmLine(o: { fullName: string; sizeKb: number | null; freeBytes: number | null }): string | null {
  const { sizeKb, freeBytes } = o
  if (sizeKb === null) return null
  const low = freeBytes !== null && freeBytes < sizeKb * 1024 + SPARE_BYTES
  if (sizeKb < ASK_KB && !low) return null
  return [
    `${o.fullName} is about ${formatKb(sizeKb)}. Cloning it uses that much disk space, though a shallow clone skips the history, so the real number is often lower.`,
    low ? `Only ${formatBytes(freeBytes!)} is free on that disk, which is less than the size plus ${formatBytes(SPARE_BYTES)}.` : '',
    'Continue?',
  ].filter(Boolean).join(' ')
}
