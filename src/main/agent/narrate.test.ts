import { describe, expect, it } from 'vitest'
import { describeCommand, describeTool, parsePlan, plainLine } from './narrate'

describe('describeTool', () => {
  it('speaks plainly', () => {
    expect(describeTool('create_file', { path: 'src/app.js' })).toBe('Creating src/app.js')
    expect(describeTool('run_command', { command: 'npm test' })).toBe('Running the tests')
    expect(describeTool('run_command', { command: 'npm install left-pad' })).toBe('Installing packages')
    expect(describeTool('list_dir', { path: '.' })).toBe('Looking through the project')
    expect(describeTool('read_file', null)).toBe('Reading a file')
  })
})

describe('parsePlan', () => {
  it('reads markers, bullets and bare lines', () => {
    expect(parsePlan('[x] one\n- [>] two\n[ ] three\n4. four\n\n')).toEqual([
      { text: 'one', status: 'done' },
      { text: 'two', status: 'doing' },
      { text: 'three', status: 'todo' },
      { text: 'four', status: 'todo' },
    ])
  })
  it('caps the length', () => expect(parsePlan('x\n'.repeat(50))).toHaveLength(20))
})

describe('describeCommand / plainLine', () => {
  it('says what a command does, never the command', () => {
    expect(describeCommand("sed -n '1,150p' src/app/api/auth/login/route.ts; sed -n '1,360p' x.ts")).toBe('Reading login/route.ts')
    expect(describeCommand('cd /p && npm test 2>&1 | tail -20')).toBe('Running the tests')
    expect(describeCommand('echo hi')).toBe('Running a command')
  })
  it('turns an agent summary into one plain line', () => {
    expect(plainLine('**Summary:**\n\n✅ **Backup created** at `/home/u/backup`\n- ✅ Directory exists')).toBe('Backup created at /home/u/backup. Directory exists')
    expect(plainLine('Added the admin page.\nKEY: Admin login: id admin, password x')).toBe('Added the admin page.')
    const cut = plainLine('word '.repeat(60)); expect(cut.length).toBeLessThanOrEqual(140); expect(cut.endsWith('word…')).toBe(true)
  })
})
