// Tells the user a newer Forge exists. It only looks and links: installing stays a download the user chooses to run.
export type UpdateInfo = { available: boolean; version?: string; url?: string; notes?: string }
type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>

const REPO = 'yash-dhanda/vibesmith'

const parts = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)

// True when `a` is a higher version than `b`. A prerelease tag (1.0.0-beta) counts as its base number.
export function newerThan(a: string, b: string): boolean {
  const x = parts(a), y = parts(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

// Any failure (offline, rate-limited, no release published yet) means "nothing to report", never an error for the user.
export async function checkForUpdate(current: string, fetchFn: FetchFn = fetch as unknown as FetchFn): Promise<UpdateInfo> {
  try {
    const res = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { available: false }
    const r = (await res.json()) as { tag_name?: string; html_url?: string; body?: string; draft?: boolean; prerelease?: boolean }
    if (!r.tag_name || r.draft || r.prerelease || !newerThan(r.tag_name, current)) return { available: false }
    return { available: true, version: r.tag_name.replace(/^v/, ''), url: r.html_url, notes: (r.body ?? '').slice(0, 2000) }
  } catch {
    return { available: false }
  }
}
