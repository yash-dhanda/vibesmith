import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findSkills, friendlyGitError, git, parseRepoUrl, scanSkills, SkillStore } from './skills'

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

  it('describes big libraries instead of listing every skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-store-'))
    mkdirSync(join(root, 'big__lib'), { recursive: true })
    const skills = Array.from({ length: 200 }, (_, i) => ({ name: `skill-${i}`, description: 'x', path: join(root, 'big__lib', `s${i}`, 'SKILL.md') }))
    writeFileSync(join(root, 'index.json'), JSON.stringify([{ id: 'big__lib', url: 'https://github.com/big/lib', name: 'big/lib', enabled: true, addedAt: 1, updatedAt: 1, skills }]))
    const c = new SkillStore(root).catalog()
    expect(c.block).toContain('big/lib: 200 skills')
    expect(c.block).not.toContain('skill-150')
    expect(c.block.length).toBeLessThan(1500)
  })
})

describe('skill libraries under load and bad input', () => {
  const oldPath = process.env.PATH
  let log: string
  // A fake git: a clone takes 300 ms and makes a folder with one skill; every other call is only logged.
  beforeEach(() => {
    const bin = mkdtempSync(join(tmpdir(), 'fakegit-'))
    log = join(bin, 'log')
    writeFileSync(join(bin, 'git'), `#!/bin/sh
for a in "$@"; do last="$a"; done
if [ "$SLOW_GIT" = 1 ]; then exec sleep 5; fi
case " $* " in *" clone "*) if [ -n "$FAIL_CLONE" ]; then echo "fatal: repository not found" >&2; exit 128; fi ;; esac
case " $* " in *" --branch $NOBRANCH "*) if [ -n "$NOBRANCH" ]; then echo "fatal: Remote branch $NOBRANCH not found in upstream origin" >&2; exit 128; fi ;; esac
case " $* " in
  *" clone "*) sleep 0.3; mkdir -p "$last/.git" "$last/s"; printf -- '---\\nname: s\\n---' > "$last/s/SKILL.md"; echo "clone $*" >> ${log} ;;
  *) sleep 0.3; echo "git $* ceiling=$GIT_CEILING_DIRECTORIES" >> ${log} ;;
esac
`)
    chmodSync(join(bin, 'git'), 0o755)
    process.env.PATH = `${bin}:${oldPath}`
  })
  afterEach(() => { process.env.PATH = oldPath; delete process.env.SLOW_GIT; delete process.env.FAIL_CLONE; delete process.env.NOBRANCH })
  const store = () => new SkillStore(mkdtempSync(join(tmpdir(), 'skills-store-')))
  const ids = (s: SkillStore) => s.list().map((r) => r.id).sort()

  it('keeps every repository when adds overlap, and ignores a toggle or removal made meanwhile', async () => {
    const s = store()
    await s.add('https://github.com/x/keep')
    await s.add('https://github.com/x/gone')
    const adds = Promise.all([s.add('https://github.com/x/one'), s.add('https://github.com/x/two')])
    await new Promise((r) => setTimeout(r, 100))
    s.setEnabled('x__keep', false)
    s.remove('x__gone')
    await adds
    expect(ids(s)).toEqual(['x__keep', 'x__one', 'x__two'])
    expect(s.list().find((r) => r.id === 'x__keep')?.enabled).toBe(false)
  })

  it('refuses a second add of a repository that is still being cloned', async () => {
    const s = store()
    const first = s.add('https://github.com/x/one')
    await expect(s.add('https://github.com/x/one')).rejects.toThrow(/already added/)
    await first
    expect(existsSync(join(s['root'], 'x__one', 's', 'SKILL.md'))).toBe(true)
  })

  it('does not bring back a repository removed or lose one added while an update runs', async () => {
    const s = store()
    await s.add('https://github.com/x/old')
    await s.add('https://github.com/x/removed')
    const upd = s.update('x__old')
    const upd2 = s.update('x__removed')
    await new Promise((r) => setTimeout(r, 100))
    s.remove('x__removed')
    await s.add('https://github.com/x/fresh')
    await Promise.all([upd, upd2])
    expect(ids(s)).toEqual(['x__fresh', 'x__old'])
  })

  it('never runs git in a folder without its own .git, and keeps git inside the skills folder', async () => {
    const s = store()
    await s.add('https://github.com/x/y')
    rmSync(join(s['root'], 'x__y', '.git'), { recursive: true })
    await s.update('x__y')
    expect(readFileSync(log, 'utf8')).not.toMatch(/fetch|reset/)
    await s.update('x__y')
    expect(readFileSync(log, 'utf8')).toMatch(/fetch .*ceiling=.*skills-store-[^/]+\n/)
  })

  it('finds a branch whose name holds a slash, and keeps the branch for a later re-clone', async () => {
    process.env.NOBRANCH = 'feature'
    const s = store()
    await s.add('https://github.com/x/br/tree/feature/x')
    expect(s.list()[0].branch).toBe('feature/x')
    rmSync(join(s['root'], 'x__br', '.git'), { recursive: true })
    await s.update('x__br')
    const clones = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('clone'))
    expect(clones.map((l) => /--branch (\S+)/.exec(l)?.[1])).toEqual(['feature/x', 'feature/x'])
    expect(existsSync(join(s['root'], 'x__br', '.git'))).toBe(true)
  })

  it('keeps the old folder when a re-clone fails, and does not recreate a repository removed meanwhile', async () => {
    const s = store()
    await s.add('https://github.com/x/keep')
    await s.add('https://github.com/x/gone')
    for (const id of ['x__keep', 'x__gone']) rmSync(join(s['root'], id, '.git'), { recursive: true })
    process.env.FAIL_CLONE = '1'
    const failed = await s.update('x__keep')
    expect(failed.error).toMatch(/Could not update/)
    expect(failed.skills.length).toBe(1)
    delete process.env.FAIL_CLONE
    const upd = s.update('x__gone')
    await new Promise((r) => setTimeout(r, 100))
    s.remove('x__gone')
    await upd
    expect(ids(s)).toEqual(['x__keep'])
    expect(existsSync(join(s['root'], 'x__gone'))).toBe(false)
    expect(readdirSync(s['root']).filter((n) => n.startsWith('.tmp-'))).toEqual([])
  })

  it('refuses ids that are not a repository folder', () => {
    const s = store()
    writeFileSync(join(s['root'], 'index.json'), JSON.stringify([{ id: 'a__one', url: 'u', name: 'a/one', enabled: true, addedAt: 1, updatedAt: 1, skills: [] }]))
    for (const bad of ['index.json', 'a__one/skills', '', '.', '..', 'b__two']) expect(() => s.remove(bad)).toThrow()
    expect(ids(s)).toEqual(['a__one'])
  })

  it('does not follow a symlinked README out of the clone', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'))
    const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'secret')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(root, 'README.md'))
    expect(findSkills(root, 'repo')).toEqual([])
  })

  it('reads a folder link as its branch and a stalled download as a timeout', async () => {
    expect(parseRepoUrl('https://github.com/anthropics/skills/tree/main/skills/pdf')).toMatchObject({ repo: 'skills', branch: 'main' })
    expect(parseRepoUrl('https://github.com/a/b/tree/dev')?.branch).toBe('dev')
    expect(parseRepoUrl('https://github.com/a/b/tree/feature/x')).toMatchObject({ branch: 'feature', tree: 'feature/x' })
    process.env.SLOW_GIT = '1'
    await expect(git(['clone', 'x'], undefined, 200)).rejects.toThrow(/took longer/)
  })

  it('reads block-scalar descriptions and a byte-order mark in SKILL.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'))
    for (const [d, text] of [['a', '---\nname: folded\ndescription: >\n  First line\n  second line\nother: 1\n---\n'], ['b', '\ufeff---\nname: bom\ndescription: |-\n  Literal text\n---\n']]) {
      mkdirSync(join(root, d))
      writeFileSync(join(root, d, 'SKILL.md'), text)
    }
    expect(findSkills(root, 'r').map((s) => [s.name, s.description]).sort()).toEqual([['bom', 'Literal text'], ['folded', 'First line second line']])
  })

  it('counts every skill but lists 200, and says so to the agents', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-store-'))
    const lib = join(root, 'big__lib')
    for (let i = 0; i < 205; i++) { mkdirSync(join(lib, `s${i}`), { recursive: true }); writeFileSync(join(lib, `s${i}`, 'SKILL.md'), '') }
    const { skills, total } = scanSkills(lib, 'lib')
    expect([skills.length, total]).toEqual([200, 205])
    writeFileSync(join(root, 'index.json'), JSON.stringify([{ id: 'big__lib', url: 'u', name: 'big/lib', enabled: true, addedAt: 1, updatedAt: 1, skills, total }]))
    expect(new SkillStore(root).catalog().block).toContain('big/lib: 205 skills (200 listed)')
  })
})
