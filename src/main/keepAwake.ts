// A sleeping laptop is the commonest reason an overnight run stops. While at least one crew run is working, the computer is kept awake (the screen may still turn off).
export type Blocker = { start(type: 'prevent-app-suspension'): number; stop(id: number): void }

export function makeKeepAwake(blocker: Blocker) {
  const working = new Set<string>()
  let id: number | null = null
  const sync = () => {
    if (working.size && id === null) id = blocker.start('prevent-app-suspension')
    else if (!working.size && id !== null) (blocker.stop(id), (id = null))
  }
  return {
    set(runId: string, isWorking: boolean) { if (isWorking) working.add(runId); else working.delete(runId); sync() },
    count: () => working.size,
    stop() { working.clear(); sync() },
  }
}

export const WORKING_STATUSES = ['planning', 'running', 'verifying']
