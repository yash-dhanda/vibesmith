import { describe, expect, it } from 'vitest'
import { decideCommand, decideTool } from './policy'

const v = (c: string) => decideCommand(c).verdict
const wt = '/home/u/.forge/team/wt1'

describe('hard limits', () => {
  it('git push is denied however git is spelled', () => {
    for (const c of ['git push origin main', 'git -C . push origin HEAD', 'git -C /home/u/proj push', 'git -c credential.helper= push', 'git --no-pager push', 'git --git-dir /x/.git push', 'cd x && git -C "a b" push']) expect(v(c), c).toBe('deny')
    for (const c of ['git status', 'git commit -m "do not push"', 'git log --grep push', 'git -C . diff']) expect(v(c), c).toBe('allow')
  })
  it('other spellings of push, and long inputs, are handled without backtracking', () => {
    for (const c of ['git -ccore.pager=cat push', 'git "push"', "git 'push' origin", '/usr/bin/git push', 'bash -c "git push"', 'echo $(git push)', 'find . -exec git push {} \\;', 'git -c alias.p=push p', 'git -C./x push', 'git --git-dir=.git push']) expect(v(c), c).toBe('deny')
    for (const c of ['git' + ' --no-pager'.repeat(5000) + ' status', 'git' + ' -c a=b'.repeat(5000) + ' status', 'git' + ' -c'.repeat(5000)]) {
      const t = Date.now()
      expect(v(c)).toBe('allow')
      expect(Date.now() - t).toBeLessThan(500)
    }
    expect(v('git' + ' --no-pager'.repeat(5000) + ' push')).toBe('deny')
  })
  it('a 5000-character pathological input is judged quickly', () => {
    const inputs = ['git ' + '-c a '.repeat(1000) + 'push', 'git ' + '-c a '.repeat(1000) + 'status', 'vercel ' + 'x '.repeat(2500), 'rm ' + '-r '.repeat(1700) + 'x', '"' + 'git push '.repeat(550), 'echo ' + '$( '.repeat(1600)]
    for (const c of inputs) {
      const t = performance.now()
      decideCommand(c)
      decideTool('Bash', { command: c }, wt)
      expect(performance.now() - t, c.slice(0, 30)).toBeLessThan(100)
    }
    expect(v(inputs[0])).toBe('deny')
    expect(decideTool('Bash', { command: inputs[0] }, wt).verdict).toBe('deny')
  })
  it('text that only mentions a git command is not that command', () => {
    for (const c of ['grep -rn "git worktree" src', 'rg "git stash" docs', 'git commit -m "add git gc step"', 'git log --grep="git replace"', 'git config user.name', 'git config --global user.name']) expect(v(c), c).not.toBe('deny')
  })
  it('doas and pkexec are sudo', () => {
    for (const c of ['doas ls', 'pkexec ls', 'sudo ls', 'echo hi; su root']) expect(v(c), c).toBe('deny')
    expect(v('npm run result')).toBe('allow')
  })
  it('the stash, branches, refs and repo config are shared with the user: denied, not asked', () => {
    for (const c of ['git stash', 'git stash pop', 'git stash clear', 'git -C . stash drop', 'git update-ref -d refs/heads/main', 'git reflog expire --expire=now --all', 'git gc --prune=now', 'git branch -D main', 'git branch --delete x', 'git tag -d v1', 'git worktree remove x', 'git config user.name x', 'git remote add o u']) expect(v(c), c).toBe('deny')
    for (const c of ['git branch', 'git branch --show-current', 'git tag', 'git config --get remote.origin.url', 'git add . && git commit -m wip', 'git checkout -b feature']) expect(v(c), c).toBe('allow')
  })
  it('destructive git asks whatever global options come first', () => {
    for (const c of ['git reset --hard HEAD~1', 'git -C ../.. reset --hard', 'git -C /home/u/project checkout .', 'git -c a=b clean -fd', 'git restore .', 'git checkout -- f']) expect(v(c), c).toBe('ask')
    for (const c of ['git reset --soft HEAD~1', 'git restore --staged f', 'git checkout main']) expect(v(c), c).toBe('allow')
  })
  it('git aimed at a folder outside the task writes nowhere but the task', () => {
    const t = (command: string) => decideTool('Bash', { command }, wt).verdict
    expect(t('git -C /home/u/project commit -am x')).toBe('deny')
    expect(t('git -C ../.. reset --hard')).toBe('deny')
    expect(t('git --git-dir=/home/u/project/.git add .')).toBe('deny')
    expect(t('git -C /home/u/project status')).toBe('allow')
    expect(t(`git -C ${wt}/sub commit -am x`)).toBe('allow')
    expect(t('git -C sub commit -am x')).toBe('allow')
  })
  it('npx deploy tools with --prod ask', () => {
    expect(v('npx vercel --prod')).toBe('ask')
  })
  it('Bash may not write outside the task folder', () => {
    const t = (command: string) => decideTool('Bash', { command }, wt).verdict
    expect(t('cp src/app.js /home/u/code/myproject/src/app.js')).toBe('deny')
    expect(t('echo x | tee /home/u/code/myproject/a.txt')).toBe('deny')
    expect(t('echo x > ~/notes.txt')).toBe('deny')
    expect(t('mv a ../../elsewhere')).toBe('deny')
    expect(t('cp /etc/hosts .')).toBe('allow')
    expect(t('cp a b && mkdir -p out/x')).toBe('allow')
    expect(t(`echo x > ${wt}/out.txt`)).toBe('allow')
    expect(t('npm test 2>&1 > /dev/null')).toBe('allow')
    expect(t('mkdir -p /tmp/scratch')).toBe('allow')
    expect(t('git push origin HEAD')).toBe('deny')
  })
})
