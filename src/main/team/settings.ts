import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamConfig } from './types'

// Team defaults remembered per project (verify command, budgets, which agent plans...). A run's own choices win over these.
export class TeamSettingsStore {
  constructor(private dir: string) {}
  private file = (project: string) => join(this.dir, `settings-${createHash('sha1').update(project).digest('hex').slice(0, 12)}.json`)
  get(project: string): Partial<TeamConfig> {
    try {
      return JSON.parse(readFileSync(this.file(project), 'utf8'))
    } catch {
      return {}
    }
  }
  set(project: string, cfg: Partial<TeamConfig>) {
    mkdirSync(this.dir, { recursive: true })
    const f = this.file(project)
    writeFileSync(f + '.tmp', JSON.stringify(cfg))
    renameSync(f + '.tmp', f)
  }
}
