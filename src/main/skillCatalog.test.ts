import { describe, expect, it } from 'vitest'
import { parseRepoUrl } from './skills'
import { CATEGORY_LABEL, SKILL_CATALOG, SKILL_PACKS } from './skillCatalog'

describe('skill catalog', () => {
  it('has 50 distinct repositories that Forge can add', () => {
    expect(SKILL_CATALOG).toHaveLength(50)
    expect(new Set(SKILL_CATALOG.map((c) => c.repo.toLowerCase())).size).toBe(50)
    for (const c of SKILL_CATALOG) {
      expect(parseRepoUrl(`https://github.com/${c.repo}`), c.repo).not.toBeNull()
      expect(Object.keys(CATEGORY_LABEL)).toContain(c.category)
      expect(c.skills).toBeGreaterThan(0)
      expect(c.blurb.length).toBeGreaterThan(10)
    }
  })

  it('has packs made only of catalog repositories', () => {
    const repos = new Set(SKILL_CATALOG.map((c) => c.repo))
    for (const p of SKILL_PACKS) for (const r of p.repos) expect(repos.has(r), `${p.id}: ${r}`).toBe(true)
  })
})
