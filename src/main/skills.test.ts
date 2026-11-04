import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findSkills, friendlyGitError, parseRepoUrl, SkillStore } from './skills'

describe('skill libraries', () => {
  it('accepts only plain https GitHub links', () => {
    expect(parseRepoUrl('https://github.com/anthropics/skills')).toMatchObject({ owner: 'anthropics', repo: 'skills', id: 'anthropics__skills' })
    expect(parseRepoUrl('https://github.com/a/b.git')?.url).toBe('https://github.com/a/b')
    expect(parseRepoUrl('https://github.com/a/b/tree/main')?.branch).toBe('main')
    for (const bad of ['http://github.com/a/b', 'git@github.com:a/b.git', 'https://evil.com/a/b', 'https://user:pw@github.com/a/b', 'file:///etc', '/home/me/repo', 'https://github.com/../b', 'https://github.com/a/b; rm -rf /']) expect(parseRepoUrl(bad)).toBeNull()
  })

  it('explains a network that changes the secure connection', () => {
    expect(friendlyGitError("fatal: unable to access 'x': SSL certificate OpenSSL verify result: self-signed certificate in certificate chain (19)")).toMatch(/firewall/)
    expect(friendlyGitError('repository not found')).toBe('repository not found')
  })

  it('finds skills by their SKILL.md and reads name and description', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'))
    mkdirSync(join(root, 'skills/pdf'), { recursive: true })
    writeFileSync(join(root, 'skills/pdf/SKILL.md'), '---\nname: pdf-tools\ndescription: "Fill and read PDFs"\n---\nbody')
    mkdirSync(join(root, 'skills/docx'), { recursive: true })
    writeFileSync(join(root, 'skills/docx/SKILL.md'), 'no frontmatter')
    const found = findSkills(root, 'repo')
    expect(found.map((s) => [s.name, s.description]).sort()).toEqual([['docx', ''], ['pdf-tools', 'Fill and read PDFs']])
  })

  it('offers a README-only repository as one reference skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'))
    writeFileSync(join(root, 'README.md'), '# Style guide')
    expect(findSkills(root, 'guide')).toMatchObject([{ name: 'guide' }])
  })

  it('shows enabled skills to the agents and nothing when there are none', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-store-'))
    const store = new SkillStore(root)
    expect(store.catalog()).toEqual({ block: '', dirs: [] })
    mkdirSync(join(root, 'a__b'), { recursive: true })
    const skillFile = join(root, 'a__b', 'SKILL.md')
    writeFileSync(skillFile, '---\nname: neat\ndescription: Do it neatly\n---')
    writeFileSync(join(root, 'index.json'), JSON.stringify([{ id: 'a__b', url: 'https://github.com/a/b', name: 'a/b', enabled: true, addedAt: 1, updatedAt: 1, skills: [{ name: 'neat', description: 'Do it neatly', path: skillFile }] }]))
    const c = store.catalog()
    expect(c.block).toContain('neat: Do it neatly')
    expect(c.block).toContain(skillFile)
    expect(c.dirs).toEqual([join(root, 'a__b')])
    store.setEnabled('a__b', false)
    expect(store.catalog().block).toBe('')
    expect(() => store.remove('../../etc')).toThrow()
  })
})
