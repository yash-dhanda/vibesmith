import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = /^(forge|remote)(-|$)/
let started = 0

export function setup() {
  started = Date.now() - 1000
}

export function teardown() {
  const dir = tmpdir()
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (!PREFIX.test(name)) continue
    const path = join(dir, name)
    try { if (statSync(path).mtimeMs >= started) rmSync(path, { recursive: true, force: true }) } catch { /* in use or already gone */ }
  }
}
