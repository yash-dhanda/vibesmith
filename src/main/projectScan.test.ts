import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rankProjects, scanProjects, type ProjectHit } from './projectScan'

const hit = (name: string, mtime = 1): ProjectHit => ({ path: `/home/u/code/${name}`, name, markers: ['.git'], mtime })

describe('project scan', () => {
  it('finds project folders, skips dependencies and hidden folders, and does not look inside a project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-'))
    for (const [dir, marker] of [['code/riftvault', 'package.json'], ['code/riftvault/inner', '.git'], ['code/node_modules/dep', 'package.json'], ['.cache/tool', 'package.json'], ['Documents/site', 'index.html'], ['Documents/py', 'pyproject.toml']]) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, marker), '')
    }
    const found = (await scanProjects(root)).map((h) => h.path.slice(root.length + 1)).sort()
    expect(found).toEqual(['Documents/py', 'code/riftvault'])
  })

  it('matches the folder named in the request, ahead of loose matches', () => {
    const all = [hit('riftvault'), hit('manhwamaniacs'), hit('forge'), hit('riftvault-old')]
    expect(rankProjects(all, 'fix the riftvault login page')[0].name).toBe('riftvault')
    expect(rankProjects(all, 'make the manhwa reader faster').map((p) => p.name)).toEqual(['manhwamaniacs'])
    expect(rankProjects(all, 'fix the bug')).toEqual([])
  })

  it('prefers the more recently changed folder when names tie', () => {
    const all = [hit('recall', 1), { ...hit('recall-corpus-meta', 100) }]
    expect(rankProjects(all, 'recall cards')[0].name).toBe('recall')
  })
})
